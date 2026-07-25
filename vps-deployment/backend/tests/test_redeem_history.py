"""History endpoint keeps redeemed codes private while exposing rewards."""

import asyncio
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("JWT_SECRET", "unit-test-secret")
os.environ.setdefault("ADMIN_SECRET", "admin")
os.environ.setdefault("CRON_SECRET", "cron")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "anon")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service")
os.environ.setdefault("FIREBASE_CREDENTIALS_BASE64", "e30=")
os.environ.setdefault("REDIS_PASSWORD", "redis")

BACKEND_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, BACKEND_ROOT)

from app.api import redeem


class FakeRedeemOrdersTable:
    def __init__(self):
        self.user_filter = None

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, field, value):
        self.user_filter = (field, value)
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        return SimpleNamespace(data=[{
            "id": "order-1",
            "reward_type": "brinde",
            "reward_snapshot": {"nome": "Caneca EC"},
            "status": "pendente",
            "created_at": "2026-07-25T12:00:00Z",
            "codigo_normalizado_snapshot": "NEVER_RETURN_THIS",
        }], count=1)


class RedeemHistoryTests(unittest.TestCase):
    def test_history_is_scoped_to_session_user_and_hides_code(self):
        table = FakeRedeemOrdersTable()
        with patch.object(redeem.supabase_client, "table", return_value=table):
            payload = asyncio.run(redeem.redeem_history({"sub": "user-123"}))

        self.assertEqual(table.user_filter, ("user_id", "user-123"))
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["items"][0]["reward"], {"nome": "Caneca EC"})
        self.assertNotIn("codigo_normalizado_snapshot", payload["items"][0])
        self.assertNotIn("idempotency_key", payload["items"][0])


if __name__ == "__main__":
    unittest.main()
