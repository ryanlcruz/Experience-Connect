"""Authoritative API for Daily Games.

The browser receives only the player's hand and the current threat. Future
Sentury threats and the remaining player deck stay on the VPS in a Redis-bound,
authenticated run. Every round is replayed on the server before persistence.
"""

from __future__ import annotations

import copy
import json
import logging
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field

from app.core.session_auth import require_session_user
from app.db.redis_client import redis_client
from app.db.supabase_client import supabase_client

logger = logging.getLogger(__name__)
router = APIRouter()

GAME_KEY = "duelo-de-experiencia"
RUN_TTL_SECONDS = 30 * 60
MAX_ROUNDS = 5
GAME_TIMEZONE = ZoneInfo("America/Sao_Paulo")
SCRIPT_PATH = Path(__file__).resolve().parents[1] / "data" / "daily_games" / "duelo-de-experiencia.v1.json"


class StartRunRequest(BaseModel):
    scenario_id: str = Field(min_length=3, max_length=80, pattern=r"^[a-z0-9-]+$")


class RunActionRequest(BaseModel):
    run_id: str = Field(min_length=16, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    card_id: str = Field(min_length=3, max_length=80, pattern=r"^[a-z0-9-]+$")


class RoundChoice(BaseModel):
    """Internal replay fixture used by the test suite, never supplied by the UI."""

    round: int = Field(ge=1, le=MAX_ROUNDS)
    card_id: str = Field(min_length=3, max_length=80, pattern=r"^[a-z0-9-]+$")
    reorganized_card_id: str | None = Field(default=None, min_length=3, max_length=80, pattern=r"^[a-z0-9-]+$")


def _load_script() -> dict[str, Any]:
    try:
        with SCRIPT_PATH.open("r", encoding="utf-8") as source:
            script = json.load(source)
    except (OSError, json.JSONDecodeError) as exc:
        logger.error("daily game script unavailable: %s", exc)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Roteiro indisponivel")
    if script.get("game_key") != GAME_KEY or not isinstance(script.get("cards"), dict):
        logger.error("invalid daily game script")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Roteiro invalido")
    return script


def _scenario(script: dict[str, Any], scenario_id: str) -> dict[str, Any]:
    for scenario in script.get("scenarios", []):
        if scenario.get("id") == scenario_id:
            return scenario
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cenario nao encontrado")


def _run_key(run_id: str) -> str:
    return f"daily-game:{GAME_KEY}:run:{run_id}"


def _active_run_key(user_id: str) -> str:
    return f"daily-game:{GAME_KEY}:user:{user_id}:active-run"


def _public_scenario(scenario: dict[str, Any]) -> dict[str, Any]:
    return {key: scenario[key] for key in ("id", "name", "category", "rule")}


def _public_card(card_id: str, card: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": card_id,
        "name": card["name"],
        "type": card["type"],
        "response": card["response"],
        "resolution": card["resolution"],
        "keywords": card["keywords"],
        "effect": card["effect"],
        **({"risk": card["risk"]} if card.get("risk") else {}),
    }


def _public_threat(scenario: dict[str, Any], round_number: int) -> dict[str, Any] | None:
    threats = scenario.get("threats") or []
    if round_number < 1 or round_number > len(threats):
        return None
    threat = threats[round_number - 1]
    return {key: threat[key] for key in ("id", "name", "impact", "vulnerabilities", "consequence", "copy")}


def _game_date() -> str:
    return datetime.now(GAME_TIMEZONE).date().isoformat()


def _public_round(script: dict[str, Any], scenario: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    threat = _public_threat(scenario, int(row["round"])) or {}
    card = _public_card(row["card_id"], script["cards"][row["card_id"]])
    return {
        "round": row["round"],
        "threat": {key: threat[key] for key in ("id", "name", "impact")},
        "card": {key: card[key] for key in ("id", "name", "type", "keywords")},
        "remaining_impact": row["remaining_impact"],
        "perfect": row["perfect"],
        "combo": row.get("combo"),
    }


def _new_run(user_id: str, script: dict[str, Any], scenario: dict[str, Any]) -> dict[str, Any]:
    loadout = list(scenario.get("loadout") or [])
    if len(loadout) < MAX_ROUNDS + 1 or len(scenario.get("threats") or []) != MAX_ROUNDS:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Roteiro incompleto")
    return {
        "user_id": user_id,
        "game_key": GAME_KEY,
        "version": script["version"],
        "scenario_id": scenario["id"],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "round": 1,
        "trust": 100,
        "pressure": 100,
        "conditions": [],
        "hand": loadout[:5],
        "deck": loadout[5:],
        "previous_card_id": None,
        "reorganize_used": False,
        "rounds": [],
        "perfect_responses": 0,
        "combos": 0,
    }


def _public_state(script: dict[str, Any], scenario: dict[str, Any], run: dict[str, Any]) -> dict[str, Any]:
    cards = script["cards"]
    return {
        "round": run["round"],
        "trust": run["trust"],
        "pressure": run["pressure"],
        "conditions": list(run.get("conditions") or []),
        "hand": [_public_card(card_id, cards[card_id]) for card_id in run["hand"]],
        "threat": _public_threat(scenario, run["round"]),
        "round_history": [_public_round(script, scenario, row) for row in run.get("rounds") or []],
        "reorganize_available": bool(not run.get("reorganize_used") and run.get("deck")),
    }


async def _completed_run_for_today(user_id: str) -> dict[str, Any] | None:
    try:
        rows = (
            supabase_client.table("daily_game_runs")
            .select("outcome,score,trust_remaining,pressure_remaining,completed_at")
            .eq("user_id", user_id)
            .eq("game_key", GAME_KEY)
            .eq("game_date", _game_date())
            .limit(1)
            .execute()
            .data
            or []
        )
    except Exception as exc:
        logger.error("daily game completion lookup failed user_id=%s: %s", user_id, exc)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Nao foi possivel verificar o jogo diario")
    return rows[0] if rows else None


async def _assert_not_completed(user_id: str) -> None:
    if await _completed_run_for_today(user_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Jogo diario ja concluido")


def _keyword_matches(card: dict[str, Any], threat: dict[str, Any]) -> list[str]:
    vulnerabilities = set(threat.get("vulnerabilities") or [])
    return [keyword for keyword in card.get("keywords") or [] if keyword in vulnerabilities]


def _apply_round(script: dict[str, Any], scenario: dict[str, Any], run: dict[str, Any], card_id: str) -> dict[str, Any]:
    """Apply exactly one player choice to the private VPS run state."""
    cards = script["cards"]
    if card_id not in run["hand"] or card_id not in cards:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Carta indisponivel")

    threat = (scenario.get("threats") or [])[run["round"] - 1]
    card = cards[card_id]
    conditions = set(run.get("conditions") or [])
    matches = _keyword_matches(card, threat)
    containment = int(card["response"]) + len(matches) * 8

    if "Desconfianca" in conditions:
        containment = max(0, containment - 3)
    if scenario["id"] == "prioridades-conflito" and card.get("type") == "cx":
        previous_type = cards.get(run.get("previous_card_id"), {}).get("type")
        if previous_type != "ex":
            containment = max(0, containment - 4)

    rule_triggered = False
    if scenario["id"] == "cliente-irritado" and "Agilidade" in (card.get("keywords") or []):
        previous_keywords = cards.get(run.get("previous_card_id"), {}).get("keywords") or []
        if "Escuta" not in previous_keywords:
            conditions.add("Desconfianca")
            containment = max(0, containment - 4)
            rule_triggered = True

    remaining_impact = max(0, int(threat["impact"]) - containment)
    perfect = bool(matches) and remaining_impact == 0
    if remaining_impact:
        conditions.add(str(threat.get("consequence") or "Pressao"))
    if card_id == "transparencia" and perfect:
        conditions.discard("Desconfianca")
    if card_id == "empatia":
        run["trust"] = min(100, int(run["trust"]) + 4)

    run["trust"] = max(0, int(run["trust"]) - remaining_impact)
    run["pressure"] = max(0, int(run["pressure"]) - int(card["resolution"]) - (4 if matches else 0))

    combo_name = None
    for combo in scenario.get("combos") or []:
        if combo.get("cards") == [run.get("previous_card_id"), card_id]:
            combo_name = str(combo["name"])
            run["trust"] = min(100, int(run["trust"]) + int(combo.get("trust") or 0))
            run["pressure"] = max(0, int(run["pressure"]) - int(combo.get("pressure") or 0))
            run["combos"] = int(run.get("combos") or 0) + 1
            break

    if perfect:
        run["perfect_responses"] = int(run.get("perfect_responses") or 0) + 1
    row = {
        "round": run["round"],
        "threat_id": threat["id"],
        "card_id": card_id,
        "matched_keywords": matches,
        "remaining_impact": remaining_impact,
        "trust_after": run["trust"],
        "pressure_after": run["pressure"],
        "perfect": perfect,
        "combo": combo_name,
        "rule_triggered": rule_triggered,
    }
    run["rounds"].append(row)
    run["hand"].remove(card_id)
    if run["deck"]:
        run["hand"].append(run["deck"].pop(0))
    run["previous_card_id"] = card_id
    run["conditions"] = sorted(conditions)
    return row


def _is_finished(run: dict[str, Any]) -> bool:
    return int(run["trust"]) == 0 or int(run["pressure"]) == 0 or int(run["round"]) >= MAX_ROUNDS


def _result_from_run(run: dict[str, Any]) -> dict[str, Any]:
    trust = int(run["trust"])
    pressure = int(run["pressure"])
    if pressure == 0 and trust >= 70:
        outcome = "experience_recovered"
    elif pressure == 0 and trust >= 35:
        outcome = "problem_controlled"
    elif pressure == 0:
        outcome = "risky_victory"
    elif trust == 0:
        outcome = "rupture"
    else:
        outcome = "pressure_unresolved"
    score = max(0, min(1000, 120 + trust - pressure + int(run.get("perfect_responses") or 0) * 12 + int(run.get("combos") or 0) * 16))
    return {"outcome": outcome, "score": score, "trust_remaining": trust, "pressure_remaining": pressure, "rounds": run["rounds"]}


def _public_result(result: dict[str, Any]) -> dict[str, Any]:
    return {key: result[key] for key in ("outcome", "score", "trust_remaining", "pressure_remaining")}


def _replay_run(script: dict[str, Any], scenario: dict[str, Any], choices: list[RoundChoice]) -> dict[str, Any]:
    """Offline test helper that uses the same per-round implementation as the API."""
    run = _new_run("test-user", script, scenario)
    for index, choice in enumerate(choices):
        if choice.round != index + 1 or choice.round != run["round"]:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Rodadas fora de ordem")
        if choice.reorganized_card_id:
            if run["reorganize_used"] or choice.reorganized_card_id not in run["hand"] or not run["deck"]:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Reorganizacao invalida")
            replacement = run["deck"].pop(0)
            run["hand"].remove(choice.reorganized_card_id)
            run["hand"].append(replacement)
            run["reorganize_used"] = True
        _apply_round(script, scenario, run, choice.card_id)
        if _is_finished(run):
            if index != len(choices) - 1:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A partida deveria ter terminado antes")
            break
        run["round"] += 1
    if not _is_finished(run):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Partida incompleta")
    return _result_from_run(run)


async def _load_run(run_id: str, user_id: str) -> dict[str, Any]:
    run = await redis_client.get_json(_run_key(run_id))
    if not run or run.get("user_id") != user_id or run.get("game_key") != GAME_KEY:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Sessao do duelo expirada")
    return run


async def _save_run(run_id: str, run: dict[str, Any]) -> None:
    await redis_client.set_json(_run_key(run_id), run, ttl=RUN_TTL_SECONDS)
    await redis_client.set(_active_run_key(str(run["user_id"])), run_id, ttl=RUN_TTL_SECONDS)


async def _load_active_run(user_id: str) -> tuple[str, dict[str, Any]] | None:
    active_run_id = await redis_client.get(_active_run_key(user_id))
    if not active_run_id:
        return None
    run = await redis_client.get_json(_run_key(active_run_id))
    if run and run.get("user_id") == user_id and run.get("game_key") == GAME_KEY:
        return active_run_id, run
    await redis_client.delete(_active_run_key(user_id))
    return None


async def _record_result(user_id: str, run_id: str, version: str, result: dict[str, Any]) -> None:
    row = {
        "user_id": user_id,
        "game_key": GAME_KEY,
        "game_version": version,
        "run_id": run_id,
        "game_date": _game_date(),
        **result,
    }
    try:
        supabase_client.table("daily_game_runs").insert(row).execute()
    except Exception as exc:
        logger.error("daily game result write failed user_id=%s run_id=%s: %s", user_id, run_id, exc)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Nao foi possivel registrar o resultado")


def _private_response(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store, private"


@router.get(f"/{GAME_KEY}/manifest")
async def get_manifest(response: Response, session_user: dict = Depends(require_session_user)) -> dict[str, Any]:
    """Only public scenario labels; no future threats or private deck data."""
    _private_response(response)
    script = _load_script()
    completed = await _completed_run_for_today(session_user["sub"])
    return {
        "game_key": GAME_KEY,
        "version": script["version"],
        "title": script["title"],
        "rounds": script["rounds"],
        "scenarios": [_public_scenario(scenario) for scenario in script["scenarios"]],
        "daily_status": {"state": "completed", "result": _public_result(completed)} if completed else {"state": "available"},
    }


@router.get(f"/{GAME_KEY}/active")
async def get_active_run(response: Response, session_user: dict = Depends(require_session_user)) -> dict[str, Any]:
    _private_response(response)
    if not redis_client.is_available():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Jogo diario indisponivel")
    active = await _load_active_run(session_user["sub"])
    if not active:
        return {"active": False}
    run_id, run = active
    script = _load_script()
    scenario = _scenario(script, str(run["scenario_id"]))
    return {
        "active": True,
        "run_id": run_id,
        "game_key": GAME_KEY,
        "version": run["version"],
        "scenario": _public_scenario(scenario),
        "state": _public_state(script, scenario, run),
    }


@router.post(f"/{GAME_KEY}/start")
async def start_run(payload: StartRunRequest, response: Response, session_user: dict = Depends(require_session_user)) -> dict[str, Any]:
    _private_response(response)
    if not redis_client.is_available():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Jogo diario indisponivel")
    lock_key = f"daily-game:{GAME_KEY}:user:{session_user['sub']}:start-lock"
    lock = await redis_client.acquire_lock(lock_key, ttl_seconds=8)
    if not lock:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Preparando um duelo em andamento")
    try:
        await _assert_not_completed(session_user["sub"])
        active = await _load_active_run(session_user["sub"])
        if active:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Voce ja possui um duelo em andamento")
        script = _load_script()
        scenario = _scenario(script, payload.scenario_id)
        run_id = secrets.token_urlsafe(24)
        run = _new_run(session_user["sub"], script, scenario)
        try:
            await _save_run(run_id, run)
        except Exception as exc:
            logger.error("daily game start cache failed user_id=%s: %s", session_user["sub"], exc)
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Nao foi possivel iniciar o duelo")
        return {"run_id": run_id, "game_key": GAME_KEY, "version": script["version"], "scenario": _public_scenario(scenario), "state": _public_state(script, scenario, run)}
    finally:
        await redis_client.release_lock(lock_key, lock)


@router.post(f"/{GAME_KEY}/reorganize")
async def reorganize_run(payload: RunActionRequest, response: Response, session_user: dict = Depends(require_session_user)) -> dict[str, Any]:
    _private_response(response)
    if not redis_client.is_available():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Jogo diario indisponivel")
    lock = await redis_client.acquire_lock(f"daily-game:{GAME_KEY}:run:{payload.run_id}:lock", ttl_seconds=8)
    if not lock:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Jogada em processamento")
    try:
        script = _load_script()
        run = await _load_run(payload.run_id, session_user["sub"])
        scenario = _scenario(script, str(run["scenario_id"]))
        if run.get("reorganize_used") or payload.card_id not in run["hand"] or not run["deck"]:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Reorganizacao invalida")
        replacement = run["deck"].pop(0)
        run["hand"].remove(payload.card_id)
        run["hand"].append(replacement)
        run["reorganize_used"] = True
        await _save_run(payload.run_id, run)
        return {"ok": True, "state": _public_state(script, scenario, run)}
    finally:
        await redis_client.release_lock(f"daily-game:{GAME_KEY}:run:{payload.run_id}:lock", lock)


@router.post(f"/{GAME_KEY}/play")
async def play_round(payload: RunActionRequest, response: Response, session_user: dict = Depends(require_session_user)) -> dict[str, Any]:
    _private_response(response)
    if not redis_client.is_available():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Jogo diario indisponivel")
    lock = await redis_client.acquire_lock(f"daily-game:{GAME_KEY}:run:{payload.run_id}:lock", ttl_seconds=10)
    if not lock:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Jogada em processamento")
    try:
        await _assert_not_completed(session_user["sub"])
        script = _load_script()
        run = await _load_run(payload.run_id, session_user["sub"])
        if run.get("version") != script.get("version"):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="O roteiro do duelo foi atualizado. Inicie uma nova partida.")
        scenario = _scenario(script, str(run["scenario_id"]))
        working_run = copy.deepcopy(run)
        round_result = _apply_round(script, scenario, working_run, payload.card_id)
        if _is_finished(working_run):
            result = _result_from_run(working_run)
            await _record_result(session_user["sub"], payload.run_id, script["version"], result)
            await redis_client.delete(_run_key(payload.run_id))
            await redis_client.delete(_active_run_key(session_user["sub"]))
            return {"ok": True, "complete": True, "round": round_result, "result": _public_result(result)}
        working_run["round"] += 1
        await _save_run(payload.run_id, working_run)
        return {"ok": True, "complete": False, "round": round_result, "state": _public_state(script, scenario, working_run)}
    finally:
        await redis_client.release_lock(f"daily-game:{GAME_KEY}:run:{payload.run_id}:lock", lock)
