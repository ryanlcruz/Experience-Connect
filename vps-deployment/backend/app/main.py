"""Main FastAPI application entry point for CX Game Backend — VPS Deployment."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import logging

from app.core.config import settings
from app.core.logging import setup_logging, get_logger
from app.db.redis_client import redis_client
from app.db.supabase_client import supabase_client
from app.db.firebase_client import firebase_client

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging(
        log_level=settings.LOG_LEVEL,
        log_format=settings.LOG_FORMAT,
        log_file=settings.LOG_FILE
    )
    logger.info(f"Starting {settings.APP_NAME} v{settings.APP_VERSION}")
    logger.info(f"Environment: {settings.ENVIRONMENT}")
    
    try:
        await redis_client.connect()
        await supabase_client.connect()
        firebase_client.initialize()
        logger.info("All database connections initialized")
    except Exception as e:
        logger.error(f"Failed to initialize connections: {e}")
        raise
    
    yield

    logger.info("Shutting down application")
    await redis_client.disconnect()
    await supabase_client.disconnect()
    firebase_client.close()


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="Backend API for CX Game - VPS Deployment",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from app.api import health
app.include_router(health.router, tags=["Health"])

from app.api import ranking
app.include_router(ranking.router, prefix="/api/ranking", tags=["Ranking"])

from app.api import intermission
app.include_router(intermission.router, prefix="/api/intermission", tags=["Intermission Games"])

from app.api import phase
app.include_router(phase.router, prefix="/api/phase", tags=["Phase Sessions"])

# Internal API: rate-limit and login-attempts routed here instead of direct Redis (port stays closed)
from app.api import internal
app.include_router(internal.router, prefix="/api/internal", tags=["Internal"])

from app.api import redeem
app.include_router(redeem.router, prefix="/api/redeem", tags=["Redeem"])

from app.api import daily_games
app.include_router(daily_games.router, prefix="/api/daily-games", tags=["Daily Games"])

from app.api import auth
app.include_router(auth.router, prefix="/api/auth", tags=["Passkeys"])


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "status": "running",
        "environment": settings.ENVIRONMENT
    }
