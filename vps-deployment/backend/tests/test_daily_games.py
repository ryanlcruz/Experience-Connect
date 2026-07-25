import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

os.environ.setdefault("DEBUG", "false")
os.environ.setdefault("JWT_SECRET", "test-secret-for-daily-games")
os.environ.setdefault("ADMIN_SECRET", "test-admin-secret")
os.environ.setdefault("CRON_SECRET", "test-cron-secret")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "test-key")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-key")
os.environ.setdefault("FIREBASE_CREDENTIALS_BASE64", "e30=")
os.environ.setdefault("REDIS_HOST", "127.0.0.1")
os.environ.setdefault("REDIS_PASSWORD", "test-redis-password")

from fastapi import HTTPException

from app.api import daily_games


class DailyGameReplayTests(unittest.TestCase):
    def setUp(self):
        self.script = daily_games._load_script()

    def scenario(self, scenario_id):
        return daily_games._scenario(self.script, scenario_id)

    def test_all_scripted_scenarios_replay_five_rounds(self):
        for scenario_id in ("cliente-irritado", "prioridades-conflito", "crise-operacional"):
            scenario = self.scenario(scenario_id)
            choices = [
                daily_games.RoundChoice(round=index + 1, card_id=card_id)
                for index, card_id in enumerate(scenario["loadout"][:5])
            ]
            result = daily_games._replay_run(self.script, scenario, choices)
            self.assertEqual(len(result["rounds"]), 5)
            self.assertIn(result["outcome"], {
                "experience_recovered", "problem_controlled", "risky_victory", "rupture", "pressure_unresolved"
            })
            self.assertGreaterEqual(result["score"], 0)

    def test_reorganize_is_validated_and_consumed_once(self):
        scenario = self.scenario("cliente-irritado")
        choices = [
            daily_games.RoundChoice(round=1, card_id="comunicacao-clara", reorganized_card_id="empatia"),
            daily_games.RoundChoice(round=2, card_id="escuta-ativa"),
            daily_games.RoundChoice(round=3, card_id="transparencia"),
            daily_games.RoundChoice(round=4, card_id="follow-up"),
            daily_games.RoundChoice(round=5, card_id="resolucao-rapida"),
        ]
        result = daily_games._replay_run(self.script, scenario, choices)
        self.assertEqual(result["rounds"][0]["card_id"], "comunicacao-clara")

    def test_card_outside_hand_is_rejected(self):
        scenario = self.scenario("cliente-irritado")
        with self.assertRaises(HTTPException) as caught:
            daily_games._replay_run(
                self.script,
                scenario,
                [daily_games.RoundChoice(round=1, card_id="gestao-de-crise")],
            )
        self.assertEqual(caught.exception.status_code, 422)

    def test_public_state_does_not_expose_future_threats_or_deck(self):
        scenario = self.scenario("cliente-irritado")
        run = daily_games._new_run("user-123", self.script, scenario)
        public = daily_games._public_state(self.script, scenario, run)
        self.assertEqual(public["threat"]["id"], "reclamacao-inicial")
        self.assertNotIn("deck", public)
        self.assertNotIn("threats", public)
        self.assertEqual(len(public["hand"]), 5)

    def test_manifest_scenario_is_limited_to_public_metadata(self):
        scenario = self.scenario("crise-operacional")
        public = daily_games._public_scenario(scenario)
        self.assertEqual(set(public), {"id", "name", "category", "rule"})

    def test_history_reveals_only_resolved_confrontations(self):
        scenario = self.scenario("cliente-irritado")
        run = daily_games._new_run("user-123", self.script, scenario)
        daily_games._apply_round(self.script, scenario, run, "empatia")
        run["round"] = 2
        public = daily_games._public_state(self.script, scenario, run)
        history = public["round_history"]
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["threat"]["id"], "reclamacao-inicial")
        self.assertEqual(history[0]["card"]["id"], "empatia")
        self.assertNotIn("threats", history[0])


if __name__ == "__main__":
    unittest.main()
