"""Regression tests for AzollaSense backend security and safety behavior."""

import importlib.util
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "app-server.py"


def load_app(data_dir, setup_token=None):
    """Import app-server.py with mutable state redirected to a temp directory."""
    os.environ["AZOLLASENSE_DATA_DIR"] = str(data_dir)
    if setup_token is None:
        os.environ.pop("AZOLLASENSE_SETUP_TOKEN", None)
    else:
        os.environ["AZOLLASENSE_SETUP_TOKEN"] = setup_token
    spec = importlib.util.spec_from_file_location(f"azollasense_test_{id(data_dir)}", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AppSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data_dir = tempfile.mkdtemp(prefix="azollasense-security-")
        cls.module = load_app(cls.data_dir)
        cls.client = cls.module.app.test_client()
        response = cls.client.post(
            "/api/auth/setup",
            json={"username": "tester", "password": "correct-horse-battery"},
        )
        assert response.status_code == 200, response.get_data(as_text=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.data_dir, ignore_errors=True)
        os.environ.pop("AZOLLASENSE_DATA_DIR", None)

    def test_public_assets_are_served(self):
        anonymous = self.module.app.test_client()
        for path in ("/login", "/login.html", "/css/style.css", "/js/app.js", "/assets/logo.svg", "/manifest.json", "/sw.js"):
            with self.subTest(path=path):
                response = anonymous.get(path)
                self.assertEqual(response.status_code, 200)
                response.close()

    def test_source_and_instance_data_are_not_served(self):
        for path in (
            "/app-server.py",
            "/requirements.txt",
            "/.git/config",
            "/instance/auth.sqlite3",
            "/instance/sensor_settings.json",
        ):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 404)
                response.close()

    def test_capture_images_require_authentication(self):
        anonymous = self.module.app.test_client()
        for path in (
            "/assets/captures/latest.json",
            "/assets/./captures/latest.json",
            "/assets/Captures/latest.json",
        ):
            with self.subTest(path=path):
                response = anonymous.get(path)
                # 404 is acceptable on case-sensitive filesystems; the point is
                # that private captures are never served anonymously.
                self.assertIn(response.status_code, (302, 401, 404))
                self.assertNotEqual(response.status_code, 200)
                response.close()

    def test_remote_setup_is_rejected_without_a_token(self):
        remote = self.module.app.test_client()
        remote.environ_base["REMOTE_ADDR"] = "192.168.1.50"
        response = remote.post(
            "/api/auth/setup",
            json={"username": "remote", "password": "correct-horse-battery"},
        )
        self.assertEqual(response.status_code, 403)


class RemoteSetupTokenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data_dir = tempfile.mkdtemp(prefix="azollasense-token-")
        cls.module = load_app(cls.data_dir, setup_token="setup-secret")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.data_dir, ignore_errors=True)
        os.environ.pop("AZOLLASENSE_DATA_DIR", None)
        os.environ.pop("AZOLLASENSE_SETUP_TOKEN", None)

    def test_proxied_remote_setup_requires_token(self):
        # The optional Node proxy connects from loopback but forwards the real
        # client address; that must not be treated as a local setup request.
        proxied = self.module.app.test_client()
        proxied.environ_base["REMOTE_ADDR"] = "127.0.0.1"
        proxied.environ_base["HTTP_X_FORWARDED_FOR"] = "192.168.1.50"
        response = proxied.post(
            "/api/auth/setup",
            json={"username": "proxied", "password": "correct-horse-battery"},
        )
        self.assertEqual(response.status_code, 403)

    def test_remote_setup_requires_matching_token(self):
        remote = self.module.app.test_client()
        remote.environ_base["REMOTE_ADDR"] = "192.168.1.50"
        payload = {"username": "remote", "password": "correct-horse-battery"}

        self.assertEqual(remote.post("/api/auth/setup", json=payload).status_code, 403)
        response = remote.post(
            "/api/auth/setup",
            json={**payload, "setup_token": "wrong"},
        )
        self.assertEqual(response.status_code, 403)
        response = remote.post(
            "/api/auth/setup",
            json=payload,
            headers={"X-AzollaSense-Setup-Token": "setup-secret"},
        )
        self.assertEqual(response.status_code, 200)


class PhExchangeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data_dir = tempfile.mkdtemp(prefix="azollasense-ph-")
        cls.module = load_app(cls.data_dir)
        cls.settings = dict(cls.module.SENSOR_SETTINGS_DEFAULTS)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.data_dir, ignore_errors=True)
        os.environ.pop("AZOLLASENSE_DATA_DIR", None)

    def advance(self, stage, started, enabled, ph, water, now):
        actuators = {"solenoid": False, "pump_auto_running": False}
        new_stage, new_started, fault = self.module.advance_ph_exchange(
            stage, started, enabled, ph, water, self.settings, actuators, now
        )
        return new_stage, new_started, fault, actuators

    def test_exchange_does_not_start_without_a_level_reading(self):
        stage, _, fault, actuators = self.advance("idle", None, True, 6.0, None, 100.0)
        self.assertEqual(stage, "idle")
        self.assertIsNone(fault)
        self.assertFalse(actuators["solenoid"])

    def test_drain_then_refill(self):
        stage, started, fault, actuators = self.advance("idle", None, True, 6.0, 25.0, 100.0)
        self.assertEqual((stage, fault), ("draining", None))
        self.assertTrue(actuators["solenoid"])

        stage, started, fault, actuators = self.advance(stage, started, True, 6.0, 19.0, 110.0)
        self.assertEqual((stage, fault), ("refilling", None))
        self.assertFalse(actuators["solenoid"])
        self.assertTrue(actuators["pump_auto_running"])

    def test_low_water_refills_before_draining(self):
        stage, _, _, actuators = self.advance("idle", None, True, 6.0, 19.0, 100.0)
        self.assertEqual(stage, "refilling")
        self.assertFalse(actuators["solenoid"])

    def test_drain_timeout_stops_the_valve(self):
        stage, started, fault, actuators = self.advance(
            "draining", 100.0, True, 6.0, 25.0, 100.0 + self.module.PH_DRAIN_TIMEOUT_SECONDS + 1
        )
        self.assertEqual((stage, fault), ("fault", "drain"))
        self.assertFalse(actuators["solenoid"])

    def test_refill_timeout_stops_the_pump(self):
        stage, started, fault, actuators = self.advance(
            "refilling", 100.0, True, 6.0, 20.0, 100.0 + self.module.PH_REFILL_TIMEOUT_SECONDS + 1
        )
        self.assertEqual((stage, fault), ("fault", "refill"))
        self.assertFalse(actuators["pump_auto_running"])

    def test_disabling_ph_auto_resets_the_exchange(self):
        stage, started, fault, actuators = self.advance("draining", 100.0, False, 6.0, 25.0, 110.0)
        self.assertEqual((stage, fault), ("idle", None))
        self.assertFalse(actuators["solenoid"])


class TelemetryFreshnessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data_dir = tempfile.mkdtemp(prefix="azollasense-telemetry-")
        cls.module = load_app(cls.data_dir)
        cls.now = datetime.now(cls.module.PH_TIMEZONE)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.data_dir, ignore_errors=True)
        os.environ.pop("AZOLLASENSE_DATA_DIR", None)

    def setUp(self):
        with self.module.state_lock:
            self.module.state["actuators"]["device_connected"] = True
            self.module.state["sensor_received_monotonic"] = 1000.0
            self.module.state["telemetry"].update({
                "ph": 7.0,
                "water_level": 25.0,
                "temperature": 28.0,
                "lux": 12000.0,
                "sensor_updated_at": (self.now - timedelta(hours=1)).isoformat(timespec="seconds"),
            })

    def test_recent_received_reading_is_logged_even_with_an_old_publish_timestamp(self):
        entry = self.module.sample_telemetry_once(now=self.now, monotonic_now=1005.0)
        self.assertEqual(entry["ph"], 7.0)
        self.assertEqual(entry["water_level"], 25.0)

    def test_stale_reading_is_logged_as_null(self):
        entry = self.module.sample_telemetry_once(now=self.now, monotonic_now=1100.0)
        self.assertIsNone(entry["ph"])
        self.assertIsNone(entry["water_level"])


if __name__ == "__main__":
    unittest.main()
