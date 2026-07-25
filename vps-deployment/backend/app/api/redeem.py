"""Resgate de codigo/palavra-chave: concede XP ou registra direito a brinde.

Rota publica autenticada por sessao (cookie). A garantia de unicidade/consistencia esta
toda no Postgres (RPC resgatar_codigo); Redis so faz rate-limit e lock anti duplo-clique.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.session_auth import require_session_user
from app.db.redis_client import redis_client
from app.db.supabase_client import supabase_client

logger = logging.getLogger(__name__)

router = APIRouter()

RATE_USER_MAX = 5
RATE_USER_WINDOW = 60
# IP alto de proposito: os ~500 usuarios podem sair pelo mesmo IP corporativo (NAT).
RATE_IP_MAX = 500
RATE_IP_WINDOW = 60
LOCK_TTL_SECONDS = 5

_MESSAGES = {
    "already_redeemed_user": "Você já utilizou este código.",
    "already_redeemed_global": "Outro participante já resgatou esta recompensa.",
}
_GENERIC = "Código inválido ou indisponível."


class RedeemRequest(BaseModel):
    codigo: str = Field(min_length=1, max_length=64)
    idempotency_key: str = Field(min_length=8, max_length=100)


async def _rate_limited(key: str, limit: int, window: int) -> bool:
    count = await redis_client.incr(key)
    if count == 1:
        await redis_client.expire(key, window)
    return count > limit


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _map_result(result) -> dict:
    if isinstance(result, list) and result:
        result = result[0]
    if not isinstance(result, dict):
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Resposta invalida")

    if result.get("status") in ("ok", "already_processed"):
        return {
            "ok": True,
            "status": result["status"],
            "reward_type": result.get("reward_type"),
            "reward": result.get("reward"),
        }

    error = result.get("error")
    if error == "idempotency_conflict":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="idempotency_conflict")
    return {"ok": False, "error": error, "message": _MESSAGES.get(error, _GENERIC)}


@router.get("/history")
async def redeem_history(
    session_user: dict = Depends(require_session_user),
) -> dict:
    """Return only the authenticated player's recent rewards.

    Codes and idempotency values are intentionally absent: after redemption the
    player needs the reward record, not a reusable secret.
    """
    try:
        result = (
            supabase_client.table("redeem_orders")
            .select("id,reward_type,reward_snapshot,status,created_at", count="exact")
            .eq("user_id", session_user["sub"])
            .order("created_at", desc=True)
            .limit(12)
            .execute()
        )
    except Exception as exc:
        logger.error("redeem history failed user_id=%s: %s", session_user["sub"], exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Historico de resgates temporariamente indisponivel",
        )

    items = []
    for row in result.data or []:
        reward = row.get("reward_snapshot")
        items.append({
            "id": row.get("id"),
            "reward_type": row.get("reward_type"),
            "reward": reward if isinstance(reward, dict) else {},
            "status": row.get("status"),
            "redeemed_at": row.get("created_at"),
        })

    return {"items": items, "total": int(result.count or len(items))}


@router.post("")
async def redeem_code(
    payload: RedeemRequest,
    request: Request,
    response: Response,
    origin: str | None = Header(default=None),
    session_user: dict = Depends(require_session_user),
) -> dict:
    # Defesa extra de CSRF, alem do cookie SameSite=Lax.
    if origin and origin not in settings.allowed_origins_list:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Origin nao permitida")

    if not redis_client.is_available():
        response.headers["Retry-After"] = "5"
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Resgate temporariamente indisponivel")

    user_id = session_user["sub"]
    if await _rate_limited(f"ec:rate:redeem:user:{user_id}", RATE_USER_MAX, RATE_USER_WINDOW) or \
       await _rate_limited(f"ec:rate:redeem:ip:{_client_ip(request)}", RATE_IP_MAX, RATE_IP_WINDOW):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="Muitas tentativas. Aguarde um instante.")

    lock_key = f"ec:redeem:lock:user:{user_id}"
    token = await redis_client.acquire_lock(lock_key, LOCK_TTL_SECONDS)
    if token is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Resgate em andamento")

    try:
        result = await supabase_client.call_rpc("resgatar_codigo", {
            "p_user_id": user_id,
            "p_codigo": payload.codigo,
            "p_idempotency_key": payload.idempotency_key,
        })
    except Exception as exc:
        logger.error("resgatar_codigo RPC falhou user_id=%s: %s", user_id, exc)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Falha no resgate")
    finally:
        await redis_client.release_lock(lock_key, token)

    mapped = _map_result(result)
    if mapped.get("error") == "invalid_config":
        logger.warning("resgate: codigo mal configurado codigo=%s user_id=%s", payload.codigo, user_id)
    return mapped
