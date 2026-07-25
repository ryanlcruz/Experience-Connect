from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.invite_admin_service import InviteAdminService


@pytest.fixture
def service():
    return InviteAdminService()


@pytest.mark.asyncio
async def test_bulk_invites_uses_single_batch_rpc_and_keeps_failures(service):
    rows = [
        {"nickname": "ana", "grant_payload": {"invite_code": "EC-1"}, "error": None},
        {"nickname": "bia", "grant_payload": None, "error": "invite_already_issued"},
    ]
    with patch("app.services.invite_admin_service.supabase_client") as client:
        client.call_rpc = AsyncMock(return_value=rows)

        result = await service.create_bulk([" ana ", "bia"], "nexus-panel")

    client.call_rpc.assert_awaited_once_with("create_passkey_invite_batch", {
        "p_nicknames": ["ana", "bia"],
        "p_created_by": "nexus-panel",
    })
    assert result["total"] == 2
    assert result["created"] == 1
    assert result["failed"] == 1
    assert result["results"][1]["error"] == "invite_already_issued"


@pytest.mark.asyncio
async def test_single_invite_never_replaces_an_active_invite_silently(service):
    with patch("app.services.invite_admin_service.supabase_client") as client:
        client.call_rpc = AsyncMock(return_value={"invite_code": "EC-NEW"})

        result = await service.create_invite("ana", "nexus-panel")

    assert result == {"ok": True, "invite": {"invite_code": "EC-NEW"}}
    assert client.call_rpc.await_args.args[0] == "create_passkey_grant_controlled"
    assert client.call_rpc.await_args.args[1]["p_replace_active"] is False


@pytest.mark.asyncio
async def test_reissue_pending_invite_revokes_before_creating_new_secret(service):
    grant_table = MagicMock()
    grant_table.select.return_value.eq.return_value.limit.return_value.execute.return_value.data = [{
        "id": "grant-1", "grant_type": "INVITE", "state": "ISSUED",
        "nickname": "ana", "target_user_id": None,
    }]
    user_table = MagicMock()
    user_table.select.return_value.eq.return_value.limit.return_value.execute.return_value.data = []

    with patch("app.services.invite_admin_service.supabase_client") as client:
        client.table.side_effect = [grant_table, user_table]
        service.revoke_grant = AsyncMock(return_value={"state": "REVOKED"})
        service.create_invite = AsyncMock(return_value={
            "ok": True, "invite": {"invite_code": "EC-NEW"},
        })

        result = await service.reissue_grant("grant-1", "nexus-panel")

    service.revoke_grant.assert_awaited_once_with("grant-1", "reissued_by_admin")
    service.create_invite.assert_awaited_once_with("ana", "nexus-panel")
    assert result == {
        "ok": True,
        "grant": {"invite_code": "EC-NEW"},
        "grant_type": "INVITE",
    }


@pytest.mark.asyncio
async def test_revoke_all_targets_only_invite_grants(service):
    with patch("app.services.invite_admin_service.supabase_client") as client:
        client.call_rpc = AsyncMock(return_value=3)

        revoked = await service.revoke_issued_invites("revogado_em_lote_no_nexus")

    assert revoked == 3
    client.call_rpc.assert_awaited_once_with("revoke_issued_passkey_invites", {
        "p_reason": "revogado_em_lote_no_nexus",
    })
