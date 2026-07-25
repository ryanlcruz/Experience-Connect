-- Operational controls for passkey invitation grants.
-- Raw tokens and codes remain one-time outputs only; this migration never
-- stores them outside the existing hashes in passkey_grants.

alter table public.passkey_security_events
  drop constraint if exists passkey_security_events_event_type_check;

alter table public.passkey_security_events
  add constraint passkey_security_events_event_type_check check (event_type in (
    'GRANT_ISSUED', 'GRANT_BLOCKED', 'GRANT_USED', 'GRANT_REVOKED',
    'PASSKEY_REGISTERED', 'PASSKEY_AUTHENTICATED', 'PASSKEY_REVOKED',
    'SESSIONS_REVOKED'
  ));

create function public.create_passkey_grant(
  p_grant_type text,
  p_nickname text,
  p_target_user_id uuid,
  p_expires_at timestamptz,
  p_created_by text,
  p_replace_active boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_type text := upper(trim(p_grant_type));
  v_nickname text;
  v_token text;
  v_code_raw text;
  v_code text;
  v_pending_user_id uuid;
  v_grant_id uuid;
  v_lock_key text;
begin
  if v_type not in ('INVITE', 'MIGRATION', 'RECOVERY') then
    raise exception 'invalid_grant_type';
  end if;
  if p_expires_at <= now() then
    raise exception 'grant_expired';
  end if;

  if v_type = 'INVITE' then
    v_nickname := trim(coalesce(p_nickname, ''));
    if v_nickname = '' then
      raise exception 'nickname_required';
    end if;
    if exists (select 1 from public.usuarios where nickname = v_nickname) then
      raise exception 'nickname_already_exists';
    end if;
    v_pending_user_id := gen_random_uuid();
    v_lock_key := 'invite:' || lower(v_nickname);
  else
    if p_target_user_id is null then
      raise exception 'target_user_required';
    end if;
    select nickname into v_nickname from public.usuarios where id = p_target_user_id;
    if v_nickname is null then
      raise exception 'target_user_not_found';
    end if;
    v_lock_key := 'user:' || p_target_user_id::text;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

  update public.passkey_grants
     set state = 'EXPIRED', updated_at = now()
   where state = 'ISSUED'
     and expires_at <= now()
     and ((p_target_user_id is not null and target_user_id = p_target_user_id)
       or (p_target_user_id is null and target_user_id is null and nickname = v_nickname));

  if p_replace_active then
    update public.passkey_grants
       set state = 'REVOKED', revoked_at = now(), updated_at = now()
     where state = 'ISSUED'
       and ((p_target_user_id is not null and target_user_id = p_target_user_id)
         or (p_target_user_id is null and target_user_id is null and nickname = v_nickname));
  elsif exists (
    select 1 from public.passkey_grants
     where state = 'ISSUED'
       and ((p_target_user_id is not null and target_user_id = p_target_user_id)
         or (p_target_user_id is null and target_user_id is null and nickname = v_nickname))
  ) then
    raise exception 'invite_already_issued';
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  v_code_raw := upper(encode(gen_random_bytes(7), 'hex'));
  v_code := 'EC-' || substr(v_code_raw, 1, 4) || '-' || substr(v_code_raw, 5, 5) || '-' || substr(v_code_raw, 10, 5);

  insert into public.passkey_grants (
    grant_type, nickname, target_user_id, pending_user_id, token_hash, code_hash,
    expires_at, created_by
  ) values (
    v_type, v_nickname, p_target_user_id, v_pending_user_id,
    encode(digest(v_token, 'sha256'), 'hex'),
    encode(digest(v_code, 'sha256'), 'hex'),
    p_expires_at, p_created_by
  ) returning id into v_grant_id;

  insert into public.passkey_security_events (user_id, grant_id, event_type, metadata)
  values (p_target_user_id, v_grant_id, 'GRANT_ISSUED', jsonb_build_object('grant_type', v_type));

  return jsonb_build_object(
    'id', v_grant_id,
    'grant_type', v_type,
    'nickname', v_nickname,
    'invite_url', 'https://expconnect.com.br/invite?token=' || v_token,
    'invite_token', v_token,
    'invite_code', v_code,
    'invite_expires', p_expires_at
  );
end;
$$;

create or replace function public.revoke_passkey_grant(
  p_grant_id uuid,
  p_reason text default 'admin_revoked'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_grant public.passkey_grants%rowtype;
  v_reason text := left(coalesce(nullif(trim(p_reason), ''), 'admin_revoked'), 200);
begin
  select * into v_grant
    from public.passkey_grants
   where id = p_grant_id
   for update;

  if not found then
    raise exception 'grant_not_found';
  end if;
  if v_grant.state <> 'ISSUED' then
    raise exception 'grant_not_available';
  end if;

  update public.passkey_grants
     set state = 'REVOKED', revoked_at = now(), updated_at = now()
   where id = v_grant.id;

  insert into public.passkey_security_events (user_id, grant_id, event_type, metadata)
  values (
    v_grant.target_user_id,
    v_grant.id,
    'GRANT_REVOKED',
    jsonb_build_object('reason', v_reason, 'grant_type', v_grant.grant_type)
  );

  return jsonb_build_object(
    'id', v_grant.id,
    'state', 'REVOKED',
    'nickname', v_grant.nickname,
    'grant_type', v_grant.grant_type
  );
end;
$$;

create or replace function public.revoke_issued_passkey_invites(
  p_reason text default 'admin_revoked_batch'
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_grant public.passkey_grants%rowtype;
  v_count integer := 0;
  v_reason text := left(coalesce(nullif(trim(p_reason), ''), 'admin_revoked_batch'), 200);
begin
  for v_grant in
    update public.passkey_grants
       set state = 'REVOKED', revoked_at = now(), updated_at = now()
     where state = 'ISSUED' and grant_type = 'INVITE'
     returning *
  loop
    insert into public.passkey_security_events (user_id, grant_id, event_type, metadata)
    values (
      v_grant.target_user_id,
      v_grant.id,
      'GRANT_REVOKED',
      jsonb_build_object('reason', v_reason, 'grant_type', v_grant.grant_type, 'scope', 'all_issued_invites')
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function public.create_passkey_invite_batch(
  p_nicknames text[],
  p_created_by text default null
)
returns table (
  row_number integer,
  nickname text,
  grant jsonb,
  error text
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_index integer;
  v_nickname text;
  v_seen text[] := '{}'::text[];
begin
  if coalesce(array_length(p_nicknames, 1), 0) = 0 then
    raise exception 'nicknames_required';
  end if;
  if array_length(p_nicknames, 1) > 10000 then
    raise exception 'batch_limit_exceeded';
  end if;

  for v_index in 1..array_length(p_nicknames, 1) loop
    v_nickname := trim(coalesce(p_nicknames[v_index], ''));
    row_number := v_index;
    nickname := v_nickname;
    grant := null;
    error := null;

    if v_nickname = '' then
      error := 'nickname_required';
    elsif char_length(v_nickname) > 100 then
      error := 'nickname_too_long';
    elsif lower(v_nickname) = any(v_seen) then
      error := 'duplicate_nickname_in_batch';
    elsif exists (
      select 1 from public.passkey_grants
       where grant_type = 'INVITE'
         and state = 'ISSUED'
         and nickname = v_nickname
         and expires_at > now()
    ) then
      error := 'invite_already_issued';
    elsif exists (select 1 from public.usuarios where nickname = v_nickname) then
      error := 'nickname_already_exists';
    else
      begin
        grant := public.create_passkey_grant(
          'INVITE',
          v_nickname,
          null::uuid,
          now() + interval '4 days',
          p_created_by,
          false
        );
      exception when others then
        get stacked diagnostics error = message_text;
      end;
    end if;

    if v_nickname <> '' then
      v_seen := array_append(v_seen, lower(v_nickname));
    end if;
    return next;
  end loop;
end;
$$;

revoke all on function public.revoke_passkey_grant(uuid, text) from public, anon, authenticated;
revoke all on function public.revoke_issued_passkey_invites(text) from public, anon, authenticated;
revoke all on function public.create_passkey_invite_batch(text[], text) from public, anon, authenticated;
revoke all on function public.create_passkey_grant(text, text, uuid, timestamptz, text, boolean) from public, anon, authenticated;

grant execute on function public.revoke_passkey_grant(uuid, text) to service_role;
grant execute on function public.revoke_issued_passkey_invites(text) to service_role;
grant execute on function public.create_passkey_invite_batch(text[], text) to service_role;
grant execute on function public.create_passkey_grant(text, text, uuid, timestamptz, text, boolean) to service_role;
