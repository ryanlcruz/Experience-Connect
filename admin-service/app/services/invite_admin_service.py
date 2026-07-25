"""Admin-side issuance and recovery for passwordless passkey grants."""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

from app.db.supabase_client import supabase_client

logger = logging.getLogger(__name__)


def _err_message(exc: Exception) -> str:
    message = str(exc)
    for marker in ("'message': '", '"message": "'):
        if marker in message:
            rest = message.split(marker, 1)[1]
            end = rest.find("'") if marker.endswith("'") else rest.find('"')
            if end > 0:
                return rest[:end]
    return message


class InviteAdminService:
    EVENT_TTL = timedelta(days=4)
    RECOVERY_TTL = timedelta(minutes=30)

    async def _grant(self, grant_type: str, *, nickname: str | None = None,
                     target_user_id: str | None = None, created_by: str = "admin",
                     replace_active: bool = True) -> Dict[str, Any]:
        expires = datetime.now(timezone.utc) + (self.RECOVERY_TTL if grant_type == "RECOVERY" else self.EVENT_TTL)
        try:
            data = await supabase_client.call_rpc("create_passkey_grant", {
                "p_grant_type": grant_type,
                "p_nickname": nickname,
                "p_target_user_id": target_user_id,
                "p_expires_at": expires.isoformat(),
                "p_created_by": created_by,
                "p_replace_active": replace_active,
            })
            return {"ok": True, "grant": data}
        except Exception as exc:
            logger.warning("Could not issue %s passkey grant: %s", grant_type, exc)
            return {"ok": False, "error": _err_message(exc)}

    async def create_invite(self, nickname: str, created_by: str = "admin") -> Dict[str, Any]:
        nickname = (nickname or "").strip()
        if not nickname:
            return {"ok": False, "nickname": nickname, "error": "nickname vazio"}
        result = await self._grant("INVITE", nickname=nickname, created_by=created_by, replace_active=False)
        if not result["ok"]:
            return {"ok": False, "nickname": nickname, "error": result["error"]}
        return {"ok": True, "invite": result["grant"]}

    async def create_bulk(self, nicknames: List[str], created_by: str = "admin") -> Dict[str, Any]:
        cleaned = [str(nickname or "").strip() for nickname in nicknames]
        if not cleaned:
            return {"total": 0, "created": 0, "failed": 0, "results": []}
        rows = await supabase_client.call_rpc("create_passkey_invite_batch", {
            "p_nicknames": cleaned,
            "p_created_by": created_by,
        })
        results = [{
            "ok": not bool(row.get("error")),
            "nickname": row.get("nickname", ""),
            "invite": row.get("grant") or None,
            "error": row.get("error") or None,
        } for row in (rows or [])]
        return {
            "total": len(results),
            "created": sum(result.get("ok", False) for result in results),
            "failed": sum(not result.get("ok", False) for result in results),
            "results": results,
        }

    async def list_invites(self, limit: int = 200) -> List[Dict[str, Any]]:
        result = (supabase_client.table("passkey_grants")
                  .select("id,grant_type,state,nickname,target_user_id,expires_at,used_at,revoked_at,attempt_count,created_by,created_at")
                  .order("created_at", desc=True).limit(limit).execute())
        return result.data or []

    async def clear_used_invites(self) -> Dict[str, Any]:
        # Security/audit events reference grants. They are never physically
        # deleted from the admin route anymore.
        return {"deleted": 0, "message": "Passkey grants are retained for audit."}

    async def revoke_grant(self, grant_id: str, reason: str = "admin_revoked") -> Dict[str, Any]:
        return await supabase_client.call_rpc("revoke_passkey_grant", {
            "p_grant_id": grant_id,
            "p_reason": reason,
        })

    async def revoke_issued_invites(self, reason: str = "admin_revoked_batch") -> int:
        result = await supabase_client.call_rpc("revoke_issued_passkey_invites", {
            "p_reason": reason,
        })
        return int(result or 0)

    async def reissue_grant(self, grant_id: str, created_by: str = "admin") -> Dict[str, Any]:
        rows = (supabase_client.table("passkey_grants")
                .select("id,grant_type,state,nickname,target_user_id")
                .eq("id", grant_id).limit(1).execute().data or [])
        if not rows:
            return {"ok": False, "error": "grant_not_found"}
        grant = rows[0]

        if grant["state"] == "ISSUED":
            try:
                await self.revoke_grant(grant_id, "reissued_by_admin")
            except Exception as exc:
                return {"ok": False, "error": _err_message(exc)}

        if grant["grant_type"] == "INVITE":
            users = (supabase_client.table("usuarios")
                     .select("id").eq("nickname", grant["nickname"]).limit(1).execute().data or [])
            if users:
                result = await self.create_recovery(users[0]["id"], created_by)
                mode = "RECOVERY"
            else:
                result = await self.create_invite(grant["nickname"], created_by)
                mode = "INVITE"
        else:
            result = await self._grant(
                grant["grant_type"],
                target_user_id=grant.get("target_user_id"),
                created_by=created_by,
            )
            mode = grant["grant_type"]

        if not result.get("ok"):
            return {"ok": False, "error": result.get("error", "grant_reissue_failed")}
        issued_grant = result.get("grant") or result.get("invite")
        if not issued_grant:
            return {"ok": False, "error": "grant_reissue_failed"}
        return {"ok": True, "grant": issued_grant, "grant_type": mode}

    async def create_recovery(self, user_id: str, created_by: str = "admin") -> Dict[str, Any]:
        return await self._grant("RECOVERY", target_user_id=user_id, created_by=created_by)

    async def create_migration(self, user_id: str, created_by: str = "admin") -> Dict[str, Any]:
        return await self._grant("MIGRATION", target_user_id=user_id, created_by=created_by)

    async def create_migration_batch(self, created_by: str = "admin") -> Dict[str, Any]:
        users = (supabase_client.table("usuarios").select("id,nickname").eq("banned", False).limit(10000).execute().data or [])
        credentials = (supabase_client.table("passkey_credentials").select("user_id").is_("revoked_at", "null").execute().data or [])
        covered_users = {credential["user_id"] for credential in credentials}
        results = []
        for user in users:
            if user["id"] not in covered_users:
                result = await self.create_migration(user["id"], created_by)
                results.append({"user_id": user["id"], "nickname": user["nickname"], **result})
        return {
            "total": len(results), "created": sum(result.get("ok", False) for result in results),
            "failed": sum(not result.get("ok", False) for result in results), "results": results,
        }

    async def list_passkeys(self, user_id: str) -> List[Dict[str, Any]]:
        result = (supabase_client.table("passkey_credentials")
                  .select("id,friendly_name,transports,aaguid,backup_eligible,backup_state,created_at,last_used_at,revoked_at,revoked_reason")
                  .eq("user_id", user_id).order("created_at", desc=True).execute())
        return result.data or []

    async def revoke_passkey(self, credential_id: str, reason: str) -> bool:
        result = await supabase_client.call_rpc("revoke_passkey_credential", {
            "p_credential_id": credential_id, "p_reason": (reason or "admin_revoked")[:200],
        })
        return bool(result)

    async def revoke_all_passkeys(self, user_id: str, reason: str) -> int:
        result = await supabase_client.call_rpc("revoke_all_user_passkeys", {
            "p_user_id": user_id, "p_reason": (reason or "admin_revoked_all")[:200],
        })
        return int(result or 0)


invite_admin_service = InviteAdminService()
