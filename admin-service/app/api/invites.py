"""Passkey invitation, migration, recovery, and credential admin endpoints."""

import csv
import io
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.services.invite_admin_service import invite_admin_service

router = APIRouter()


class CreateInvite(BaseModel):
    nickname: str = Field(min_length=1, max_length=100)
    created_by: str = Field(default="admin", min_length=1, max_length=100)


class BulkInvite(BaseModel):
    nicknames: List[str] = Field(min_length=1, max_length=10000)
    created_by: str = Field(default="admin", min_length=1, max_length=100)


class BulkInviteCsv(BaseModel):
    nicknames: List[str] = Field(min_length=1, max_length=10000)
    created_by: str = Field(default="admin", min_length=1, max_length=100)


class RecoveryRequest(BaseModel):
    created_by: str = Field(default="admin", min_length=1, max_length=100)


class RevokePasskeyRequest(BaseModel):
    reason: str = Field(default="admin_revoked", min_length=1, max_length=200)


class GrantActionRequest(BaseModel):
    created_by: str = Field(default="admin", min_length=1, max_length=100)
    reason: str = Field(default="admin_revoked", min_length=1, max_length=200)


@router.get("/invites")
async def list_invites() -> List[Dict[str, Any]]:
    # Raw link/code values are returned only once, when a grant is created.
    return await invite_admin_service.list_invites()


@router.post("/invites", status_code=201)
async def create_invite(body: CreateInvite) -> Dict[str, Any]:
    result = await invite_admin_service.create_invite(body.nickname, body.created_by)
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("error", "Falha ao criar convite"))
    return result["invite"]


@router.post("/invites/bulk")
async def create_bulk(body: BulkInvite) -> Dict[str, Any]:
    return await invite_admin_service.create_bulk(body.nicknames, body.created_by)


@router.post("/invites/bulk.csv")
async def create_bulk_csv(body: BulkInviteCsv) -> StreamingResponse:
    """Create grants and return the one-time link/code values as a CSV.

    Raw values are returned only in this download and are never persisted.
    """
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=[
        "nickname", "activation_link", "activation_code", "expires_at", "status", "error"
    ])
    writer.writeheader()
    result = await invite_admin_service.create_bulk(body.nicknames, body.created_by)
    for entry in result["results"]:
        invite = entry.get("invite") or {}
        writer.writerow({
            "nickname": entry.get("nickname", ""),
            "activation_link": invite.get("invite_url", ""),
            "activation_code": invite.get("invite_code", ""),
            "expires_at": invite.get("invite_expires", ""),
            "status": "CREATED" if entry.get("ok") else "FAILED",
            "error": "" if entry.get("ok") else entry.get("error", "grant_failed"),
        })
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=passkey-activation-grants.csv"},
    )


@router.post("/invites/clear-used")
async def clear_used() -> Dict[str, Any]:
    # Preserved for clients of the old panel, but passkey audit records remain.
    return await invite_admin_service.clear_used_invites()


@router.post("/invites/revoke-issued")
async def revoke_issued_invites(body: GrantActionRequest) -> Dict[str, Any]:
    revoked = await invite_admin_service.revoke_issued_invites(body.reason)
    return {"ok": True, "revoked": revoked}


@router.post("/invites/{grant_id}/reissue", status_code=201)
async def reissue_invite(grant_id: str, body: GrantActionRequest) -> Dict[str, Any]:
    result = await invite_admin_service.reissue_grant(grant_id, body.created_by)
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("error", "Falha ao reemitir convite"))
    return result


@router.post("/invites/{grant_id}/revoke")
async def revoke_invite(grant_id: str, body: GrantActionRequest) -> Dict[str, Any]:
    try:
        grant = await invite_admin_service.revoke_grant(grant_id, body.reason)
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True, "grant": grant}


@router.post("/passkeys/migrations")
async def create_migrations(body: RecoveryRequest) -> Dict[str, Any]:
    """Create four-day link+code migrations for old accounts without a passkey."""
    return await invite_admin_service.create_migration_batch(body.created_by)


@router.post("/users/{user_id}/passkey-recovery", status_code=201)
async def create_recovery(user_id: str, body: RecoveryRequest) -> Dict[str, Any]:
    result = await invite_admin_service.create_recovery(user_id, body.created_by)
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("error", "Falha ao emitir recuperação"))
    return result["grant"]


@router.get("/users/{user_id}/passkeys")
async def list_passkeys(user_id: str) -> List[Dict[str, Any]]:
    return await invite_admin_service.list_passkeys(user_id)


@router.post("/users/{user_id}/passkeys/{credential_id}/revoke")
async def revoke_passkey(user_id: str, credential_id: str, body: RevokePasskeyRequest) -> Dict[str, Any]:
    credentials = await invite_admin_service.list_passkeys(user_id)
    if credential_id not in {credential["id"] for credential in credentials}:
        raise HTTPException(status_code=404, detail="Passkey não encontrada para este usuário")
    revoked = await invite_admin_service.revoke_passkey(credential_id, body.reason)
    if not revoked:
        raise HTTPException(status_code=409, detail="Passkey já está revogada")
    return {"ok": True, "credential_id": credential_id}


@router.post("/users/{user_id}/passkeys/revoke-all")
async def revoke_all_passkeys(user_id: str, body: RevokePasskeyRequest) -> Dict[str, Any]:
    revoked = await invite_admin_service.revoke_all_passkeys(user_id, body.reason)
    return {"ok": True, "revoked": revoked}
