"""
AzollaSense — Flask + Socket.IO backend

Serves the web app, streams the Raspberry Pi Camera as MJPEG, runs YOLO
segmentation for browning detection and relays telemetry to every connected client.
"""

import os
import json
import csv
import io
import math
import hashlib
import hmac
import secrets
import sqlite3
import signal
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import cv2
import numpy as np
try:
    from picamera2 import Picamera2
except ImportError:
    Picamera2 = None
from flask import Flask, Response, jsonify, request, send_from_directory, redirect, make_response, g, stream_with_context
from flask_socketio import SocketIO
from ultralytics import YOLO
import serial
from serial.tools import list_ports
try:
    from pywebpush import WebPushException, webpush
except ImportError:
    WebPushException = Exception
    webpush = None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "runs", "segment", "train", "weights", "best_ncnn_model")

# Target frame size for the MJPEG stream (square crop of the camera feed)
FRAME_SIZE = 640
# Upper bound for the stream framerate (keeps CPU / USB bandwidth sane)
MAX_FPS = 15
# How often telemetry is broadcast while the camera stream is running
STREAM_TELEMETRY_INTERVAL = 0.5
CAPTURE_CAMERA_WARMUP_SECONDS = 5
YOLO_CONFIDENCE_THRESHOLD = 0.25
PH_TIMEZONE = ZoneInfo("Asia/Manila")
CAPTURE_DIR = os.path.join(BASE_DIR, "assets", "captures")
LATEST_CAPTURE_PATH = os.path.join(CAPTURE_DIR, "latest.json")
SERIAL_PORT = os.environ.get("AZOLLASENSE_SERIAL_PORT", "").strip()
SERIAL_BAUD = int(os.environ.get("AZOLLASENSE_SERIAL_BAUD", "115200"))

app = Flask(__name__, static_url_path="", static_folder=BASE_DIR)
socketio = SocketIO(app, cors_allowed_origins="*")

# User accounts and opaque sessions live on this device. No cloud service is
# involved in registration, login, session validation, or dashboard access.
os.makedirs(app.instance_path, exist_ok=True)
AUTH_DB_PATH = os.path.join(app.instance_path, "auth.sqlite3")
SESSION_COOKIE = "azollasense_session"
SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7
AUTH_DB_LOCK = threading.RLock()
TELEMETRY_DB_PATH = os.path.join(app.instance_path, "telemetry.sqlite3")
TELEMETRY_DB_LOCK = threading.RLock()
LOG_SAMPLE_INTERVAL_SECONDS = 30
LOG_SENSOR_FRESH_SECONDS = 30
LOG_CAMERA_FRESH_SECONDS = 10
LOG_RETENTION_DAYS = 90
PUSH_DB_PATH = os.path.join(app.instance_path, "push_subscriptions.sqlite3")
PUSH_DB_LOCK = threading.RLock()
VAPID_PUBLIC_KEY = os.environ.get("AZOLLASENSE_VAPID_PUBLIC_KEY", "").strip()
VAPID_PRIVATE_KEY = os.environ.get("AZOLLASENSE_VAPID_PRIVATE_KEY", "").strip()
VAPID_SUBJECT = os.environ.get("AZOLLASENSE_VAPID_SUBJECT", "").strip()
push_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="web-push")
alert_state_lock = threading.RLock()
previous_alert_states = None
system_alert_history = deque(maxlen=100)
system_alert_sequence = 0


def init_push_db():
    with PUSH_DB_LOCK, sqlite3.connect(PUSH_DB_PATH, timeout=10) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, subscription_json TEXT NOT NULL, created_at TEXT NOT NULL)")


init_push_db()
if os.name != "nt":
    os.chmod(PUSH_DB_PATH, 0o600)


def _send_web_push(payload):
    if webpush is None or not (VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY and VAPID_SUBJECT):
        return
    with PUSH_DB_LOCK, sqlite3.connect(PUSH_DB_PATH, timeout=10) as connection:
        rows = connection.execute("SELECT endpoint, subscription_json FROM push_subscriptions").fetchall()
    for endpoint, raw_subscription in rows:
        try:
            webpush(json.loads(raw_subscription), json.dumps(payload), VAPID_PRIVATE_KEY,
                    vapid_claims={"sub": VAPID_SUBJECT})
        except WebPushException as exc:
            response = getattr(exc, "response", None)
            if response is not None and response.status_code in (404, 410):
                with PUSH_DB_LOCK, sqlite3.connect(PUSH_DB_PATH, timeout=10) as connection:
                    connection.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,))
            else:
                print(f"[PUSH] Delivery failed: {exc}")
        except Exception as exc:
            print(f"[PUSH] Delivery failed: {exc}")


def _emit_system_alert(title, body, severity="warning"):
    global system_alert_sequence
    payload = {"title": title, "body": body, "severity": severity,
               "tag": f"azollasense-{int(time.time() * 1000)}", "created_at": time.time()}
    with alert_state_lock:
        system_alert_sequence += 1
        payload["id"] = system_alert_sequence
        system_alert_history.append(payload)
    socketio.emit("system_alert", payload)
    if webpush is not None and VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY and VAPID_SUBJECT:
        push_executor.submit(_send_web_push, payload)


def _evaluate_alert_transitions(telemetry, actuators, settings):
    """Emit alerts on transitions only; seed silently until one valid sample arrives."""
    global previous_alert_states
    try:
        observed_at = datetime.fromisoformat(telemetry.get("sensor_updated_at"))
        if observed_at.tzinfo is None:
            observed_at = observed_at.replace(tzinfo=PH_TIMEZONE)
        fresh = (actuators.get("device_connected") is True and
                 0 <= (datetime.now(PH_TIMEZONE) - observed_at.astimezone(PH_TIMEZONE)).total_seconds() <= LOG_SENSOR_FRESH_SECONDS)
    except (TypeError, ValueError):
        fresh = False
    if not fresh:
        return

    def number(key):
        value = telemetry.get(key)
        return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None

    ph, water, lux = number("ph"), number("water_level"), number("lux")
    current = {}
    if ph is not None:
        current["ph"] = "low" if ph < settings["ph_min"] else "high" if ph > settings["ph_max"] else "ok"
    if water is not None:
        current["water"] = "low" if water < settings["water_min_cm"] else "high" if water > settings["water_max_cm"] else "ok"
    if lux is not None:
        prior_light = previous_alert_states.get("light") if previous_alert_states else None
        current["light"] = "high" if lux >= (settings["canopy_release_lux"] if prior_light == "high" else settings["canopy_deploy_lux"]) else "normal"
    pump_on = bool(actuators.get("pump_manual") or actuators.get("pump_auto_running") or actuators.get("pump"))
    current["pump"] = "on" if pump_on else "off"
    current["canopy"] = "deployed" if actuators.get("motor") else "retracted"

    with alert_state_lock:
        previous = previous_alert_states
        previous_alert_states = {**(previous or {}), **current}
    if previous is None:
        return

    events = []
    for key, value in current.items():
        old = previous.get(key)
        if old is None or old == value:
            continue
        if key == "ph" and value in ("low", "high"):
            events.append(("Water pH warning", f"pH is {value}; reading {ph:g}, configured range {settings['ph_min']:g}–{settings['ph_max']:g}.", "warning"))
        elif key == "ph" and old != "ok":
            events.append(("pH back in range", "Water pH has returned to its configured range.", "success"))
        elif key == "water" and value == "low":
            if current.get("pump") == "on" and previous.get("pump") != "on":
                events.append(("Low water level", f"Water level is {water:g} cm; pump started.", "warning"))
            else:
                events.append(("Low water level", f"Water level is {water:g} cm, below the configured minimum.", "warning"))
        elif key == "water" and value == "high":
            events.append(("High water level", f"Water level is {water:g} cm, above the configured maximum.", "warning"))
        elif key == "water" and old != "ok":
            events.append(("Water level recovered", "Water level has returned to its configured range.", "success"))
        elif key == "light" and value == "high":
            events.append(("High light intensity", "Light is above the canopy deploy threshold.", "warning"))
        elif key == "light" and old == "high":
            events.append(("Light intensity normal", "Light has fallen below the canopy release threshold.", "success"))
        elif key == "pump" and value == "on" and previous.get("water") != "low":
            events.append(("Pump started", "Pump is now running.", "info"))
        elif key == "pump" and value == "off":
            events.append(("Pump stopped", "Pump is no longer running.", "info"))
        elif key == "canopy" and value == "deployed":
            events.append(("Canopy deployed", "Canopy is now open.", "info"))
        elif key == "canopy" and value == "retracted":
            events.append(("Canopy retracted", "Canopy is now closed.", "info"))
    for event in events:
        _emit_system_alert(*event)


@contextmanager
def telemetry_db():
    connection = sqlite3.connect(TELEMETRY_DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_telemetry_db():
    with TELEMETRY_DB_LOCK, telemetry_db() as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("""
            CREATE TABLE IF NOT EXISTS telemetry_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                ph REAL,
                water_level REAL,
                temperature REAL,
                lux REAL,
                canopy_status TEXT,
                browning_pct REAL,
                occupancy_pct REAL,
                occupancy_date TEXT UNIQUE
            )
        """)
        connection.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_logs_timestamp ON telemetry_logs(timestamp)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_logs_occupancy_date ON telemetry_logs(occupancy_date)")
        retention_cutoff = (datetime.now(PH_TIMEZONE) - timedelta(days=LOG_RETENTION_DAYS)).isoformat(timespec="seconds")
        connection.execute("DELETE FROM telemetry_logs WHERE timestamp < ?", (retention_cutoff,))


init_telemetry_db()
if os.name != "nt":
    os.chmod(TELEMETRY_DB_PATH, 0o600)


@contextmanager
def auth_db():
    connection = sqlite3.connect(AUTH_DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_auth_db():
    with AUTH_DB_LOCK, auth_db() as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash BLOB NOT NULL, password_salt BLOB NOT NULL, created_at TEXT NOT NULL)")
        connection.execute("CREATE TABLE IF NOT EXISTS sessions (token_hash BLOB PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL)")
        connection.execute("CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_started REAL NOT NULL, locked_until REAL NOT NULL DEFAULT 0)")


init_auth_db()
if os.name != "nt":
    os.chmod(AUTH_DB_PATH, 0o600)


def password_digest(password, salt):
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)


def create_session(user_id):
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("ascii")).digest()
    expiry = datetime.now(timezone.utc) + timedelta(seconds=SESSION_LIFETIME_SECONDS)
    with AUTH_DB_LOCK, auth_db() as connection:
        connection.execute("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)", (token_hash, user_id, expiry.isoformat()))
    return token


@app.before_request
def load_local_user():
    token = request.cookies.get(SESSION_COOKIE, "")
    g.user = None
    if token:
        token_hash = hashlib.sha256(token.encode("utf-8")).digest()
        with AUTH_DB_LOCK, auth_db() as connection:
            row = connection.execute("SELECT users.id, users.username, sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=?", (token_hash,)).fetchone()
            if row:
                if datetime.fromisoformat(row["expires_at"]) > datetime.now(timezone.utc):
                    g.user = {"id": row["id"], "username": row["username"]}
                else:
                    connection.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))

    path = request.path
    public = path in ("/api/auth/status", "/api/auth/setup", "/api/auth/login", "/login") or path.startswith("/css/") or path.startswith("/js/") or path.startswith("/assets/") and not path.startswith("/assets/captures/") or path in ("/manifest.json", "/sw.js", "/favicon.ico")
    if not public and g.user is None:
        if path.startswith("/api/") or path in ("/video_feed", "/stop_stream"):
            return jsonify({"error": "Authentication required."}), 401
        return redirect("/login", code=302)


@socketio.on("connect")
def require_socket_login(auth=None):
    token = request.cookies.get(SESSION_COOKIE, "")
    if not token:
        return False
    token_hash = hashlib.sha256(token.encode("utf-8")).digest()
    with AUTH_DB_LOCK, auth_db() as connection:
        row = connection.execute("SELECT expires_at FROM sessions WHERE token_hash=?", (token_hash,)).fetchone()
    return bool(row and datetime.fromisoformat(row["expires_at"]) > datetime.now(timezone.utc))

# ---------------------------------------------------------------------------
# Shared state — every field below is guarded by state_lock
# ---------------------------------------------------------------------------

state_lock = threading.RLock()
state = {
    "telemetry": {
        "water_level": 26.0,
        "water_distance_cm": None,
        "temperature": 31.5,
        "ph": 7.2,
        "ph_voltage": None,
        "green_cov": 0.0,
        "brown_cov": 0.0,
        "total_cov": 0.0,
        "lux": None,
        "sensor_updated_at": None,
    },
    "cv_updated_monotonic": None,
    "ai_vision_enabled": True,
    "stream_active": False,
    "capture_in_progress": False,
    "camera_cover_requested_open": False,
    "camera_cover_open": None,
    "camera_cover_moving": False,
    "camera_cover_reported_monotonic": 0.0,
    "camera": None,
    "model": None,
    "model_status": "not loaded",
    "last_capture_date": None,
    "actuators": {"motor": False, "canopy_motor_running": False, "solenoid": False,
                  "pump": False, "pump_manual": False, "ph_auto": False,
                  "pump_auto_running": False, "canopy_auto": False, "device_connected": False},
}


def _numeric_value(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value)


def _timestamp_age_seconds(value, now):
    if not value:
        return None
    try:
        observed_at = datetime.fromisoformat(value)
        if observed_at.tzinfo is None:
            observed_at = observed_at.replace(tzinfo=PH_TIMEZONE)
        return (now - observed_at.astimezone(PH_TIMEZONE)).total_seconds()
    except (TypeError, ValueError):
        return None


def _insert_telemetry_log(entry):
    retention_cutoff = (datetime.now(PH_TIMEZONE) - timedelta(days=LOG_RETENTION_DAYS)).isoformat(timespec="seconds")
    with TELEMETRY_DB_LOCK, telemetry_db() as connection:
        connection.execute("""
            INSERT INTO telemetry_logs
                (timestamp, ph, water_level, temperature, lux, canopy_status, browning_pct, occupancy_pct, occupancy_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            entry["timestamp"], entry.get("ph"), entry.get("water_level"), entry.get("temperature"),
            entry.get("lux"), entry.get("canopy_status"), entry.get("browning_pct"),
            entry.get("occupancy_pct"), entry.get("occupancy_date"),
        ))
        connection.execute("DELETE FROM telemetry_logs WHERE timestamp < ?", (retention_cutoff,))


def _record_scheduled_occupancy(captured_at, brown_pct, green_pct):
    occupancy_pct = None
    if brown_pct is not None and green_pct is not None:
        occupancy_pct = round(min(100.0, max(0.0, brown_pct + green_pct)), 2)
    capture_date = captured_at.astimezone(PH_TIMEZONE).date().isoformat()
    _insert_telemetry_log({
        "timestamp": captured_at.astimezone(PH_TIMEZONE).isoformat(timespec="seconds"),
        "occupancy_pct": occupancy_pct,
        "occupancy_date": capture_date,
    })


def sample_telemetry_once(now=None, monotonic_now=None):
    """Persist one snapshot, replacing sensor and CV values that have gone stale with NULL."""
    sampled_at = now or datetime.now(PH_TIMEZONE)
    if sampled_at.tzinfo is None:
        sampled_at = sampled_at.replace(tzinfo=PH_TIMEZONE)
    sampled_at = sampled_at.astimezone(PH_TIMEZONE)
    monotonic_now = time.monotonic() if monotonic_now is None else monotonic_now
    with state_lock:
        telemetry = dict(state["telemetry"])
        actuators = dict(state["actuators"])
        cv_updated_monotonic = state.get("cv_updated_monotonic")

    sensor_age = _timestamp_age_seconds(telemetry.get("sensor_updated_at"), sampled_at)
    sensor_fresh = (
        actuators.get("device_connected") is True and sensor_age is not None
        and 0 <= sensor_age <= LOG_SENSOR_FRESH_SECONDS
    )
    canopy_status = None
    if sensor_fresh:
        if actuators.get("canopy_motor_running"):
            canopy_status = "moving"
        else:
            canopy_status = "deployed" if actuators.get("motor") else "retracted"

    cv_age = monotonic_now - cv_updated_monotonic if isinstance(cv_updated_monotonic, (int, float)) else None
    cv_fresh = cv_age is not None and 0 <= cv_age <= LOG_CAMERA_FRESH_SECONDS
    entry = {
        "timestamp": sampled_at.isoformat(timespec="seconds"),
        "ph": _numeric_value(telemetry.get("ph")) if sensor_fresh else None,
        "water_level": _numeric_value(telemetry.get("water_level")) if sensor_fresh else None,
        "temperature": _numeric_value(telemetry.get("temperature")) if sensor_fresh else None,
        "lux": _numeric_value(telemetry.get("lux")) if sensor_fresh else None,
        "canopy_status": canopy_status,
        "browning_pct": _numeric_value(telemetry.get("brown_cov")) if cv_fresh else None,
        "occupancy_pct": None,
        "occupancy_date": None,
    }
    _insert_telemetry_log(entry)
    return entry

serial_lock = threading.Lock()
serial_device = None
serial_ready = False
ph_exchange_stage = "idle"
device_preferences = {
    "motor": False,
    "pump_manual": False,
    "ph_auto": False,
    "canopy_auto": False,
}
DEVICE_PREFERENCES_PATH = os.path.join(app.instance_path, "actuator_preferences.json")
preferences_write_lock = threading.Lock()

SENSOR_SETTINGS_DEFAULTS = {
    "update_interval_seconds": 2,
    "temperature_max_c": 34.0,
    "ph_min": 6.5,
    "ph_max": 7.5,
    "water_min_cm": 20.0,
    "water_max_cm": 30.0,
    "pump_target_cm": 25.0,
    "pump_hysteresis_cm": 2.0,
    "canopy_deploy_lux": 45000.0,
    "canopy_release_lux": 35000.0,
    "browning_alert_pct": 10.0,
    "ph7_voltage": 2.5,
    "ph4_voltage": 3.026,
    "tank_depth_cm": 50.0,
    "water_level_offset_cm": 0.0,
}
# Keep sensor settings alongside the other persistent, device-local data.
# Using Flask's instance directory for both reads and writes avoids choosing a
# different settings file when the app is launched through another entry point.
SENSOR_SETTINGS_PATH = os.path.join(app.instance_path, "sensor_settings.json")
LEGACY_SENSOR_SETTINGS_PATH = os.path.join(BASE_DIR, "instance", "sensor_settings.json")
settings_lock = threading.RLock()
sensor_settings = dict(SENSOR_SETTINGS_DEFAULTS)


def load_sensor_settings():
    saved = {}
    candidate_paths = [SENSOR_SETTINGS_PATH]
    if LEGACY_SENSOR_SETTINGS_PATH != SENSOR_SETTINGS_PATH:
        candidate_paths.append(LEGACY_SENSOR_SETTINGS_PATH)
    for settings_path in candidate_paths:
        try:
            with open(settings_path, "r", encoding="utf-8") as settings_file:
                saved = json.load(settings_file)
            break
        except (OSError, json.JSONDecodeError):
            continue
    if not isinstance(saved, dict):
        saved = {}
    with settings_lock:
        for key, default in SENSOR_SETTINGS_DEFAULTS.items():
            value = saved.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                sensor_settings[key] = float(value)


def save_sensor_settings():
    with settings_lock:
        saved = dict(sensor_settings)
    os.makedirs(os.path.dirname(SENSOR_SETTINGS_PATH), exist_ok=True)
    temp_path = SENSOR_SETTINGS_PATH + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as settings_file:
        json.dump(saved, settings_file, indent=2)
        settings_file.flush()
        os.fsync(settings_file.fileno())
    os.replace(temp_path, SENSOR_SETTINGS_PATH)


load_sensor_settings()
print(f"[SETTINGS] Sensor settings file: {SENSOR_SETTINGS_PATH}")


def load_device_preferences():
    """Restore persisted mode and manual switch values from the Pi's instance directory."""
    try:
        with open(DEVICE_PREFERENCES_PATH, "r", encoding="utf-8") as preferences_file:
            saved = json.load(preferences_file)
    except (OSError, json.JSONDecodeError):
        saved = {}
    if not isinstance(saved, dict):
        saved = {}
    with state_lock:
        for key in device_preferences:
            if isinstance(saved.get(key), bool):
                device_preferences[key] = saved[key]
        state["actuators"].update({
            "motor": device_preferences["motor"],
            "pump_manual": device_preferences["pump_manual"],
            "ph_auto": device_preferences["ph_auto"],
            "canopy_auto": device_preferences["canopy_auto"],
        })


def save_device_preferences():
    """Atomically persist switch states so a Pi or ESP32 restart keeps them."""
    with preferences_write_lock:
        with state_lock:
            saved = dict(device_preferences)
        os.makedirs(os.path.dirname(DEVICE_PREFERENCES_PATH), exist_ok=True)
        temp_path = DEVICE_PREFERENCES_PATH + ".tmp"
        with open(temp_path, "w", encoding="utf-8") as preferences_file:
            json.dump(saved, preferences_file)
            preferences_file.flush()
            os.fsync(preferences_file.fileno())
        os.replace(temp_path, DEVICE_PREFERENCES_PATH)


load_device_preferences()


def find_serial_port():
    """Use AZOLLASENSE_SERIAL_PORT when set; otherwise pick a likely USB serial device."""
    if SERIAL_PORT:
        return SERIAL_PORT
    ports = list(list_ports.comports())
    candidates = [p.device for p in ports if any(k in (p.description or "").lower()
                  for k in ("esp32", "usb serial", "usb jtag", "cp210", "ch340", "uart"))]
    if candidates:
        return candidates[0]
    if os.name != "nt":
        for candidate in ("/dev/ttyACM0", "/dev/ttyUSB0"):
            if os.path.exists(candidate):
                return candidate
    return None


def send_device_command(command):
    """Write one JSON command line to the ESP32 serial link."""
    global serial_device
    with serial_lock:
        if not serial_ready or serial_device is None or not serial_device.is_open:
            return False
        try:
            serial_device.write((json.dumps(command) + "\n").encode("utf-8"))
            return True
        except (serial.SerialException, OSError) as exc:
            print(f"[SERIAL] Write failed: {exc}")
            return False


def set_camera_cover(opened):
    """Request a cover position without making camera access depend on telemetry."""
    with state_lock:
        state["camera_cover_requested_open"] = bool(opened)
        state["camera_cover_reported_monotonic"] = 0.0
    send_device_command({"camera_cover": bool(opened)})


def sync_camera_cover():
    """Keep the cover open while either camera use owns the camera."""
    with state_lock:
        should_be_open = state["stream_active"] or state["capture_in_progress"]
    set_camera_cover(should_be_open)


def serial_reader_thread():
    """Read ESP32 JSON telemetry and keep the existing dashboard state current."""
    global serial_device, serial_ready
    last_telemetry_at = None
    telemetry_timeout_seconds = 10
    while True:
        try:
            if serial_device is None or not serial_device.is_open:
                port = find_serial_port()
                if not port:
                    time.sleep(3)
                    continue
                serial_device = serial.Serial(port, SERIAL_BAUD, timeout=1)
                serial_ready = False
                last_telemetry_at = time.monotonic()
                time.sleep(2)  # allow ESP32 to restart after USB serial opens
                with serial_lock:
                    with state_lock:
                        restored = dict(device_preferences)
                    # Automatic mode follows the ESP32's end-stop reading at boot.
                    restore_command = {
                        "type": "restore_state",
                        "pump_auto": False,
                        "pump": restored["pump_manual"],
                        "canopy_auto": restored["canopy_auto"],
                        "solenoid": False,
                    }
                    with state_lock:
                        restore_command["camera_cover"] = state["camera_cover_requested_open"]
                    if not restored["canopy_auto"]:
                        restore_command["motor"] = restored["motor"]
                    serial_device.write((json.dumps(restore_command) + "\n").encode("utf-8"))
                    serial_ready = True
                print(f"[SERIAL] Connected to ESP32 on {port}")
            line = serial_device.readline().decode("utf-8", errors="ignore").strip()
            if not line:
                if (last_telemetry_at is not None
                        and time.monotonic() - last_telemetry_at > telemetry_timeout_seconds):
                    raise serial.SerialException("ESP32 telemetry timed out")
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                print(f"[SERIAL] Ignoring non-JSON line: {line[:120]}")
                continue
            if message.get("type") == "telemetry":
                last_telemetry_at = time.monotonic()
                with settings_lock:
                    settings = dict(sensor_settings)

                def numeric_reading(name):
                    value = message.get(name)
                    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else None

                distance = numeric_reading("water_distance_cm")
                ph_voltage = numeric_reading("ph_voltage")
                water_level = settings["tank_depth_cm"] - distance + settings["water_level_offset_cm"] if distance is not None else None
                ph_span = settings["ph4_voltage"] - settings["ph7_voltage"]
                ph = (7.0 + (ph_voltage - settings["ph7_voltage"]) * (4.0 - 7.0) / ph_span
                      if ph_voltage is not None and abs(ph_span) >= 0.05 else None)
                temperature = numeric_reading("temperature")
                lux = numeric_reading("lux")
                published_readings = {
                    "water_distance_cm": distance,
                    "water_level": water_level,
                    "temperature": temperature,
                    "ph": ph,
                    "ph_voltage": ph_voltage,
                    "lux": lux,
                }
                now_monotonic = time.monotonic()
                command = {"type": "heartbeat"}
                with state_lock:
                    for key in ("solenoid", "pump", "pump_manual", "pump_auto", "canopy_auto", "pump_auto_running"):
                        if key in message:
                            state["actuators"][key] = bool(message[key])
                    if "canopy_deployed" in message:
                        state["actuators"]["motor"] = bool(message["canopy_deployed"])
                    if "motor_running" in message:
                        state["actuators"]["canopy_motor_running"] = bool(message["motor_running"])
                    state["actuators"]["device_connected"] = True

                    # Replace out-of-range water in two stages. Drain to the
                    # configured minimum, then refill to the pump target plus
                    # its stop margin. Wait for pH to recover before starting
                    # another exchange cycle.
                    global ph_exchange_stage
                    ph_auto_enabled = state["actuators"].get("ph_auto", False)
                    if not ph_auto_enabled and ph_exchange_stage != "idle":
                        ph_exchange_stage = "idle"
                        state["actuators"]["solenoid"] = False
                        state["actuators"]["pump_auto_running"] = False
                    ph_out_of_range = ph is not None and (ph < settings["ph_min"] or ph > settings["ph_max"])
                    ph_in_range = ph is not None and settings["ph_min"] <= ph <= settings["ph_max"]
                    if ph_auto_enabled and ph_exchange_stage == "idle" and ph_out_of_range:
                        ph_exchange_stage = "draining"
                    if ph_exchange_stage == "draining":
                        state["actuators"]["solenoid"] = True
                        state["actuators"]["pump_auto_running"] = False
                        if water_level is not None and water_level <= settings["water_min_cm"]:
                            state["actuators"]["solenoid"] = False
                            state["actuators"]["pump_auto_running"] = True
                            ph_exchange_stage = "refilling"
                    elif ph_exchange_stage == "refilling":
                        state["actuators"]["solenoid"] = False
                        state["actuators"]["pump_auto_running"] = True
                        if water_level is not None and water_level >= settings["pump_target_cm"] + settings["pump_hysteresis_cm"]:
                            state["actuators"]["pump_auto_running"] = False
                            ph_exchange_stage = "wait_in_range"
                    elif ph_exchange_stage == "wait_in_range" and ph_in_range:
                        ph_exchange_stage = "idle"

                    pump_should_run = ph_exchange_stage == "refilling"
                    state["actuators"]["pump_auto_running"] = pump_should_run
                    command.update({
                        "pump": state["actuators"].get("pump_manual", False),
                        "pump_auto": False,
                        "pump_auto_running": pump_should_run,
                        "ph_auto": ph_auto_enabled,
                        "canopy_auto": state["actuators"].get("canopy_auto", False),
                        "solenoid": state["actuators"].get("solenoid", False),
                        "camera_cover": state["camera_cover_requested_open"],
                    })

                    if isinstance(message.get("camera_cover_open"), bool):
                        state["camera_cover_open"] = message["camera_cover_open"]
                        state["camera_cover_moving"] = bool(message.get("camera_cover_moving", False))
                        state["camera_cover_reported_monotonic"] = now_monotonic

                    deployed = state["actuators"].get("motor", False)
                    motor_running = state["actuators"].get("canopy_motor_running", False)
                    if state["actuators"].get("canopy_auto") and lux is not None and not motor_running:
                        if lux >= settings["canopy_deploy_lux"] and not deployed:
                            command["auto_motor"] = True
                            state["actuators"]["motor"] = True
                        elif lux <= settings["canopy_release_lux"] and deployed:
                            command["auto_motor"] = False
                            state["actuators"]["motor"] = False

                    publish_interval = settings["update_interval_seconds"]
                    should_publish = (now_monotonic - state.get("last_telemetry_publish_monotonic", 0.0) >= publish_interval)
                    if should_publish:
                        state["last_telemetry_publish_monotonic"] = now_monotonic
                        for key, value in published_readings.items():
                            if value is not None:
                                state["telemetry"][key] = round(value, 2)
                        state["telemetry"]["sensor_updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
                    payload = dict(state["telemetry"]) if should_publish else None
                    actuators = dict(state["actuators"])
                send_device_command(command)
                if payload is not None:
                    socketio.emit("telemetry_update", payload)
                socketio.emit("actuator_update", actuators)
        except (serial.SerialException, OSError) as exc:
            print(f"[SERIAL] Disconnected: {exc}")
            with serial_lock:
                try:
                    if serial_device:
                        serial_device.close()
                except Exception:
                    pass
                serial_device = None
                serial_ready = False
                last_telemetry_at = None
            with state_lock:
                state["actuators"]["device_connected"] = False
                state["camera_cover_open"] = None
                state["camera_cover_moving"] = False
            socketio.emit("actuator_update", dict(state["actuators"]))
            time.sleep(2)


def load_model():
    """Load the YOLO NCNN model; fall back to raw camera mode on failure."""
    try:
        model = YOLO(MODEL_PATH)
        with state_lock:
            state["model"] = model
            state["model_status"] = "loaded"
        print(f"[AI VISION] YOLO model loaded from {MODEL_PATH}")
    except Exception as exc:  # missing weights, corrupt export, etc.
        with state_lock:
            state["model"] = None
            state["model_status"] = f"unavailable ({exc})"
        print(f"[AI VISION] WARNING: model not available ({exc}). Serving raw camera feed.")


# ---------------------------------------------------------------------------
# Camera helpers
# ---------------------------------------------------------------------------

def open_camera():
    """Start the Raspberry Pi Camera using the native Picamera2 interface."""
    if Picamera2 is None:
        print("[CAMERA] Picamera2 is unavailable. Install it with: sudo apt install python3-picamera2")
        return None
    camera = None
    try:
        camera = Picamera2()
        config = camera.create_video_configuration(
            # Picamera2's RGB888 buffer is BGR-ordered in memory on Raspberry Pi,
            # which is the channel order OpenCV and the YOLO model expect.
            main={"size": (FRAME_SIZE, FRAME_SIZE), "format": "RGB888"}
        )
        camera.configure(config)
        camera.start()
        print("[CAMERA] Raspberry Pi Camera started with Picamera2")
        return PiCameraCapture(camera)
    except Exception as exc:
        print(f"[CAMERA] Could not start Raspberry Pi Camera: {exc}")
        if camera is not None:
            try:
                camera.stop()
                camera.close()
            except Exception:
                pass
        return None


class PiCameraCapture:
    """Small VideoCapture-compatible wrapper around Picamera2."""

    def __init__(self, camera):
        self.camera = camera
        self.closed = False

    def read(self):
        if self.closed:
            return False, None
        try:
            return True, self.camera.capture_array()
        except Exception as exc:
            print(f"[CAMERA] Frame capture failed: {exc}")
            return False, None

    def release(self):
        if self.closed:
            return
        self.closed = True
        try:
            self.camera.stop()
        finally:
            self.camera.close()


def release_camera():
    """Stop the stream and release the Raspberry Pi Camera."""
    with state_lock:
        state["stream_active"] = False
        camera = state["camera"]
        state["camera"] = None
    if camera is not None:
        try:
            camera.release()
        except Exception:
            pass
        print("[CAMERA] Raspberry Pi Camera released.")
    sync_camera_cover()


def center_crop_square(frame):
    """Center-crop any non-square camera frame before resizing it."""
    height, width = frame.shape[:2]
    side = min(height, width)
    top = (height - side) // 2
    left = (width - side) // 2
    cropped = frame[top:top + side, left:left + side]
    return cv2.resize(cropped, (FRAME_SIZE, FRAME_SIZE), interpolation=cv2.INTER_AREA)


def compute_coverage(masks_array, classes, target_class, height, width, total_pixels):
    """Return the percentage of the frame covered by a given class index."""
    if target_class not in classes:
        return 0.0
    mask = np.any(masks_array[classes == target_class], axis=0).astype(np.uint8)
    mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
    return float(np.sum(mask) / total_pixels * 100.0)


def capture_is_due_today():
    """Avoid moving the cover on repeated scheduler checks after today's capture."""
    now = datetime.now(PH_TIMEZONE)
    today = now.date().isoformat()
    try:
        with TELEMETRY_DB_LOCK, telemetry_db() as connection:
            occupancy_logged = connection.execute(
                "SELECT 1 FROM telemetry_logs WHERE occupancy_date = ? LIMIT 1", (today,)
            ).fetchone()
        if occupancy_logged:
            with state_lock:
                state["last_capture_date"] = today
            return False
    except sqlite3.Error as exc:
        print(f"[LOGS] Could not check today's occupancy record: {exc}")
    try:
        with open(LATEST_CAPTURE_PATH, "r", encoding="utf-8") as record_file:
            latest = json.load(record_file)
        if latest.get("captured_at", "").startswith(today) and latest.get("scheduled", True):
            with state_lock:
                state["last_capture_date"] = today
            return False
    except (OSError, json.JSONDecodeError):
        pass
    with state_lock:
        if state["last_capture_date"] == today:
            return False

    return True


def _capture_image(force=False):
    """Capture and analyze a frame; force bypasses the daily schedule guard."""
    if not force and not capture_is_due_today():
        return False

    camera = open_camera()
    if camera is None:
        print("[CAPTURE] Could not open camera for scheduled capture.")
        return False
    try:
        # Discard warm-up frames while auto exposure/focus adapts to the lighting.
        warmup_until = time.monotonic() + CAPTURE_CAMERA_WARMUP_SECONDS
        while time.monotonic() < warmup_until:
            camera.read()
            time.sleep(0.1)
        success, frame = camera.read()
    finally:
        camera.release()
    if not success:
        print("[CAPTURE] Camera did not return a frame.")
        return False

    frame = center_crop_square(frame)
    height, width = frame.shape[:2]
    with state_lock:
        model = state["model"]
        model_status = state["model_status"]
        telemetry = dict(state["telemetry"])
    brown_pct = green_pct = None
    output = frame
    detection_count = 0
    if model is not None:
        result = model(frame, verbose=False, conf=YOLO_CONFIDENCE_THRESHOLD)[0]
        brown_pct = green_pct = 0.0
        if result.masks is not None and result.boxes is not None:
            masks = result.masks.data.cpu().numpy()
            classes = result.boxes.cls.cpu().numpy().astype(int)
            detection_count = len(classes)
            pixels = height * width
            brown_pct = compute_coverage(masks, classes, 0, height, width, pixels)
            green_pct = compute_coverage(masks, classes, 1, height, width, pixels)
        output = result.plot(conf=False, labels=False, boxes=False, masks=True)

    os.makedirs(CAPTURE_DIR, exist_ok=True)
    captured_at = datetime.now(PH_TIMEZONE)
    filename = f"browning-{captured_at.strftime('%Y%m%d-%H%M%S-%f')}.jpg"
    image_path = os.path.join(CAPTURE_DIR, filename)
    if not cv2.imwrite(image_path, output):
        print("[CAPTURE] Failed to save scheduled image.")
        return False
    record = {
        "image": f"/assets/captures/{filename}",
        "captured_at": captured_at.isoformat(timespec="seconds"),
        "scheduled": not force,
        "brown_cov": round(brown_pct, 2) if brown_pct is not None else None,
        "green_cov": round(green_pct, 2) if green_pct is not None else None,
        "model_status": model_status,
        "detection_count": detection_count,
        "temperature": telemetry.get("temperature"),
        "water_level": telemetry.get("water_level"),
    }
    temp_path = LATEST_CAPTURE_PATH + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as record_file:
        json.dump(record, record_file)
    os.replace(temp_path, LATEST_CAPTURE_PATH)
    if not force:
        with state_lock:
            state["last_capture_date"] = captured_at.date().isoformat()
        try:
            _record_scheduled_occupancy(captured_at, record["brown_cov"], record["green_cov"])
        except sqlite3.Error as exc:
            print(f"[LOGS] Could not record daily occupancy: {exc}")
    if model is not None and brown_pct is not None and green_pct is not None:
        with state_lock:
            state["telemetry"]["brown_cov"] = round(brown_pct, 2)
            state["telemetry"]["green_cov"] = round(green_pct, 2)
            state["telemetry"]["total_cov"] = round(brown_pct + green_pct, 2)
            state["cv_updated_monotonic"] = time.monotonic()
    print(f"[CAPTURE] Saved daily capture: {image_path}")
    return True


def run_daily_capture(force=False):
    """Give a requested capture exclusive camera access, preempting live video."""
    if not force and not capture_is_due_today():
        return False
    with state_lock:
        if state["capture_in_progress"]:
            return False
        state["capture_in_progress"] = True
        stream_was_active = state["stream_active"]
    try:
        sync_camera_cover()
        if stream_was_active:
            print("[CAPTURE] Stopping live stream to prioritize image capture.")
            release_camera()
            socketio.emit("stream_preempted", {"reason": "image_capture"})
            time.sleep(0.25)
        captured = _capture_image(force=force)
        if captured:
            socketio.emit("browning_capture_updated", {"success": True})
        return captured
    finally:
        with state_lock:
            state["capture_in_progress"] = False
        sync_camera_cover()


def capture_scheduler_thread():
    """Check frequently so process startup at 08:00 still triggers today's capture."""
    while True:
        now = datetime.now(PH_TIMEZONE)
        if now.hour == 8:
            try:
                run_daily_capture()
            except Exception as exc:
                print(f"[CAPTURE] Scheduled capture failed: {exc}")
        time.sleep(max(1, 60 - datetime.now(PH_TIMEZONE).second))



def generate_camera_stream():
    """MJPEG generator: read -> segment -> (optionally) annotate -> emit."""
    with state_lock:
        if state["camera"] is None:
            state["camera"] = open_camera()
        if state["camera"] is None:
            print("[CAMERA] ERROR: could not start the Raspberry Pi Camera.")
            release_camera()  # clears the stream reservation
            return
        print("[CAMERA] Raspberry Pi Camera streaming.")

    camera = state["camera"]
    frame_period = 1.0 / MAX_FPS
    last_telemetry = 0.0

    try:
        while True:
            frame_start = time.time()

            with state_lock:
                if not state["stream_active"] or state["camera"] is None:
                    break
                success, frame = camera.read()

            if not success:
                time.sleep(0.01)
                continue

            frame = center_crop_square(frame)
            height, width, _ = frame.shape
            total_pixels = height * width

            with state_lock:
                model = state["model"]
                ai_enabled = state["ai_vision_enabled"]

            green_pct = brown_pct = 0.0
            output_frame = frame

            if model is not None:
                result = model(frame, verbose=False, conf=YOLO_CONFIDENCE_THRESHOLD)[0]

                if result.masks is not None and result.boxes is not None:
                    masks_array = result.masks.data.cpu().numpy()
                    classes = result.boxes.cls.cpu().numpy().astype(int)

                    # Class 0 = browned / affected Azolla, class 1 = healthy Azolla
                    brown_pct = compute_coverage(masks_array, classes, 0, height, width, total_pixels)
                    green_pct = compute_coverage(masks_array, classes, 1, height, width, total_pixels)

                if ai_enabled:
                    output_frame = result.plot(conf=False, labels=False, boxes=False, masks=True)

            # Broadcast telemetry at a fixed cadence while streaming
            now = time.time()
            if now - last_telemetry >= STREAM_TELEMETRY_INTERVAL:
                last_telemetry = now
                with state_lock:
                    if model is not None:
                        state["telemetry"]["green_cov"] = round(green_pct, 2)
                        state["telemetry"]["brown_cov"] = round(brown_pct, 2)
                        state["telemetry"]["total_cov"] = round(green_pct + brown_pct, 2)
                        state["cv_updated_monotonic"] = time.monotonic()
                    payload = dict(state["telemetry"])
                socketio.emit("telemetry_update", payload)

            ok, buffer = cv2.imencode(".jpg", output_frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if not ok:
                continue

            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + buffer.tobytes() + b"\r\n"

            elapsed = time.time() - frame_start
            if elapsed < frame_period:
                time.sleep(frame_period - elapsed)

    except GeneratorExit:
        print("[CAMERA] Browser disconnected from stream.")
    except Exception as exc:
        print(f"[CAMERA] Stream error: {exc}")
    finally:
        release_camera()



def sensor_thread():
    """Broadcast the current telemetry to every client twice per second."""
    while True:
        time.sleep(2)
        with state_lock:
            payload = dict(state["telemetry"])
            actuators = dict(state["actuators"])
        with settings_lock:
            settings = dict(sensor_settings)
        _evaluate_alert_transitions(payload, actuators, settings)
        socketio.emit("telemetry_update", payload)


def telemetry_log_thread():
    """Persist one local telemetry snapshot every thirty seconds."""
    while True:
        time.sleep(LOG_SAMPLE_INTERVAL_SECONDS)
        try:
            sample_telemetry_once()
        except sqlite3.Error as exc:
            print(f"[LOGS] Could not save telemetry reading: {exc}")


# ---------------------------------------------------------------------------
# Socket.IO events
# ---------------------------------------------------------------------------

@socketio.on("toggle_ai_vision")
def handle_toggle_vision(data):
    enabled = bool((data or {}).get("enabled", True))
    with state_lock:
        state["ai_vision_enabled"] = enabled
    print(f"[AI VISION] Overlay set to: {'ON' if enabled else 'OFF'}")
    return {"success": True, "enabled": enabled}


@socketio.on("connect")
def send_initial_device_state():
    with state_lock:
        socketio.emit("actuator_update", dict(state["actuators"]), to=request.sid)
    with settings_lock:
        socketio.emit("sensor_settings", dict(sensor_settings), to=request.sid)


@socketio.on("set_actuator")
def handle_set_actuator(data):
    """Request a manual output state or switch canopy control mode."""
    data = data or {}
    name = data.get("name")
    if name not in ("motor", "solenoid", "pump", "ph_auto", "canopy_auto"):
        return {"success": False, "error": "Unknown actuator"}
    enabled = bool(data.get("enabled"))
    command = {name: enabled}
    preference_key = {"pump": "pump_manual"}.get(name, name)
    if preference_key in device_preferences:
        with state_lock:
            previous_preferences = dict(device_preferences)
            previous_actuators = dict(state["actuators"])
            device_preferences[preference_key] = enabled
            if name == "motor":
                # Manual canopy movement takes control away from lux automation.
                device_preferences["canopy_auto"] = False
                state["actuators"]["canopy_auto"] = False
            state["actuators"][preference_key] = enabled
            if name == "motor":
                state["actuators"]["motor"] = enabled
        try:
            save_device_preferences()
        except OSError as exc:
            print(f"[STATE] Could not persist actuator preferences: {exc}")
            with state_lock:
                device_preferences.update(previous_preferences)
                state["actuators"].update(previous_actuators)
            return {"success": False, "error": "Could not save the switch state on the Raspberry Pi"}
    elif name == "solenoid":
        with state_lock:
            state["actuators"][name] = enabled
            if enabled:
                state["actuators"]["pump_auto_running"] = False

    elif name == "ph_auto":
        with state_lock:
            state["actuators"]["ph_auto"] = enabled
            if not enabled:
                global ph_exchange_stage
                ph_exchange_stage = "idle"
                state["actuators"]["solenoid"] = False
                state["actuators"]["pump_auto_running"] = False

    sent = send_device_command(command)
    if name == "solenoid" and enabled:
        send_device_command({"pump_auto_running": False})
    if name == "ph_auto" and not enabled:
        send_device_command({"solenoid": False, "pump_auto_running": False})
    return {"success": True, "pending": not sent}


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

@app.route("/")
def serve_index():
    return no_store(send_from_directory(BASE_DIR, "index.html"))


@app.route("/login")
def serve_login():
    if g.user:
        return redirect("/")
    return no_store(send_from_directory(BASE_DIR, "login.html"))


def set_session_cookie(response, token):
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_LIFETIME_SECONDS,
                        httponly=True, secure=request_is_https(), samesite="Lax", path="/")
    response.headers["Cache-Control"] = "no-store"
    return response


def request_is_https():
    forwarded_proto = request.headers.get("X-Forwarded-Proto", "").split(",", 1)[0].strip().lower()
    cf_visitor = request.headers.get("CF-Visitor", "")
    try:
        cf_scheme = json.loads(cf_visitor).get("scheme", "").lower()
    except (AttributeError, TypeError, json.JSONDecodeError):
        cf_scheme = ""
    return request.is_secure or forwarded_proto == "https" or cf_scheme == "https"


def no_store(response):
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


@app.route("/api/auth/status")
def auth_status():
    with AUTH_DB_LOCK, auth_db() as connection:
        configured = connection.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None
    return no_store(jsonify({"configured": configured, "authenticated": bool(g.user), "username": g.user["username"] if g.user else None}))


@app.route("/api/auth/setup", methods=["POST"])
def auth_setup():
    data = request.get_json(silent=True) or {}
    username, password = str(data.get("username", "")).strip(), data.get("password", "")
    if not isinstance(password, str) or not 3 <= len(username) <= 40 or not username.replace("_", "").replace("-", "").isalnum() or len(password) < 10 or len(password) > 256:
        return jsonify({"error": "Use a 3–40 character username and a password of at least 10 characters."}), 400
    salt = secrets.token_bytes(16)
    with AUTH_DB_LOCK, auth_db() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if connection.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            return jsonify({"error": "Initial setup is already complete."}), 409
        try:
            cursor = connection.execute("INSERT INTO users(username,password_hash,password_salt,created_at) VALUES (?,?,?,?)", (username, password_digest(password, salt), salt, datetime.now(timezone.utc).isoformat()))
            user_id = cursor.lastrowid
        except sqlite3.IntegrityError:
            return jsonify({"error": "That username is already in use."}), 409
    return set_session_cookie(jsonify({"success": True}), create_session(user_id))


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    data = request.get_json(silent=True) or {}
    username, password = str(data.get("username", "")).strip(), data.get("password", "")
    ip = request.remote_addr or "unknown"
    now = time.time()
    with AUTH_DB_LOCK, auth_db() as connection:
        attempt = connection.execute("SELECT failures,window_started,locked_until FROM login_attempts WHERE ip=?", (ip,)).fetchone()
        if attempt and attempt["locked_until"] > now:
            return jsonify({"error": "Too many attempts. Try again in a few minutes."}), 429
        row = connection.execute("SELECT id,password_hash,password_salt FROM users WHERE username=?", (username,)).fetchone()
    valid = bool(row and isinstance(password, str) and len(password) <= 256 and hmac.compare_digest(password_digest(password, row["password_salt"]), row["password_hash"]))
    with AUTH_DB_LOCK, auth_db() as connection:
        if not valid:
            failures = (attempt["failures"] + 1) if attempt and now - attempt["window_started"] < 900 else 1
            locked_until = now + 900 if failures >= 8 else 0
            connection.execute("INSERT INTO login_attempts(ip,failures,window_started,locked_until) VALUES(?,?,?,?) ON CONFLICT(ip) DO UPDATE SET failures=excluded.failures,window_started=excluded.window_started,locked_until=excluded.locked_until", (ip, failures, now if failures == 1 else attempt["window_started"], locked_until))
            return jsonify({"error": "Username or password is incorrect."}), 401
        connection.execute("DELETE FROM login_attempts WHERE ip=?", (ip,))
    return set_session_cookie(jsonify({"success": True}), create_session(row["id"]))


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    token = request.cookies.get(SESSION_COOKIE, "")
    if token:
        with AUTH_DB_LOCK, auth_db() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode("utf-8")).digest(),))
    response = make_response(jsonify({"success": True}))
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, secure=request_is_https(), samesite="Lax")
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/auth/users", methods=["POST"])
def auth_add_user():
    data = request.get_json(silent=True) or {}
    username, password = str(data.get("username", "")).strip(), data.get("password", "")
    if not isinstance(password, str) or not 3 <= len(username) <= 40 or not username.replace("_", "").replace("-", "").isalnum() or len(password) < 10 or len(password) > 256:
        return jsonify({"error": "Use a 3–40 character username and a password of at least 10 characters."}), 400
    salt = secrets.token_bytes(16)
    try:
        with AUTH_DB_LOCK, auth_db() as connection:
            connection.execute("INSERT INTO users(username,password_hash,password_salt,created_at) VALUES (?,?,?,?)", (username, password_digest(password, salt), salt, datetime.now(timezone.utc).isoformat()))
    except sqlite3.IntegrityError:
        return jsonify({"error": "That username is already in use."}), 409
    return jsonify({"success": True}), 201


@app.route("/video_feed")
def video_feed():
    with state_lock:
        if state["capture_in_progress"]:
            return jsonify({"error": "image capture in progress"}), 409
        if state["stream_active"]:
            # Only one MJPEG consumer may hold the camera at a time
            return jsonify({"error": "camera stream already active"}), 503
        state["stream_active"] = True

    sync_camera_cover()

    response = Response(generate_camera_stream(), mimetype="multipart/x-mixed-replace; boundary=frame")
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@app.route("/stop_stream", methods=["POST"])
def stop_stream():
    print("[CAMERA] Stop stream requested.")
    release_camera()
    return jsonify({"success": True, "streaming": False})


@app.route("/health")
def health():
    with state_lock:
        return jsonify({
            "status": "ok",
            "model": state["model_status"],
            "ai_vision": state["ai_vision_enabled"],
            "streaming": state["stream_active"],
            "camera_cover": {
                "requested_open": state["camera_cover_requested_open"],
                "open": state["camera_cover_open"],
                "moving": state["camera_cover_moving"],
            },
            "telemetry": dict(state["telemetry"]),
            "actuators": dict(state["actuators"]),
        })


@app.route("/api/telemetry")
def api_telemetry():
    with state_lock:
        return jsonify(dict(state["telemetry"]))


def _requested_log_range():
    today = datetime.now(PH_TIMEZONE).date()
    start_value = request.args.get("start", today.isoformat())
    end_value = request.args.get("end", today.isoformat())
    try:
        start_date = datetime.strptime(start_value, "%Y-%m-%d").date()
        end_date = datetime.strptime(end_value, "%Y-%m-%d").date()
        if start_date.isoformat() != start_value or end_date.isoformat() != end_value:
            raise ValueError("Use YYYY-MM-DD dates.")
        if start_date > end_date:
            raise ValueError("The start date must not be after the end date.")
    except (TypeError, ValueError) as exc:
        return None, None, (jsonify({"error": str(exc) or "Use YYYY-MM-DD dates."}), 400)

    start_stamp = datetime.combine(start_date, datetime.min.time(), PH_TIMEZONE).isoformat(timespec="seconds")
    end_stamp = datetime.combine(end_date + timedelta(days=1), datetime.min.time(), PH_TIMEZONE).isoformat(timespec="seconds")
    return start_stamp, end_stamp, None


@app.route("/api/logs")
def api_telemetry_logs():
    start_stamp, end_stamp, error = _requested_log_range()
    if error:
        return error
    try:
        limit = min(30, max(1, int(request.args.get("limit", "30"))))
        offset = max(0, int(request.args.get("offset", "0")))
    except ValueError:
        return jsonify({"error": "limit and offset must be whole numbers."}), 400
    with TELEMETRY_DB_LOCK, telemetry_db() as connection:
        where = "timestamp >= ? AND timestamp < ?"
        total = connection.execute(f"SELECT COUNT(*) FROM telemetry_logs WHERE {where}", (start_stamp, end_stamp)).fetchone()[0]
        rows = connection.execute(f"""
            SELECT timestamp, ph, water_level, temperature, lux, canopy_status, browning_pct, occupancy_pct
            FROM telemetry_logs WHERE {where}
            ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?
        """, (start_stamp, end_stamp, limit, offset)).fetchall()
    return no_store(jsonify({
        "entries": [dict(row) for row in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }))


@app.route("/api/logs/export")
def api_export_telemetry_logs():
    start_stamp, end_stamp, error = _requested_log_range()
    if error:
        return error
    start_date = start_stamp[:10]
    end_date = (datetime.fromisoformat(end_stamp) - timedelta(days=1)).date().isoformat()

    def csv_rows():
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(("timestamp_pht", "ph", "water_level_cm", "temperature_c", "lux", "canopy_status", "browning_pct", "occupancy_pct"))
        yield output.getvalue()
        output.seek(0)
        output.truncate(0)
        with telemetry_db() as connection:
            cursor = connection.execute("""
                SELECT timestamp, ph, water_level, temperature, lux, canopy_status, browning_pct, occupancy_pct
                FROM telemetry_logs WHERE timestamp >= ? AND timestamp < ?
                ORDER BY timestamp ASC, id ASC
            """, (start_stamp, end_stamp))
            for row in cursor:
                writer.writerow(tuple(row))
                yield output.getvalue()
                output.seek(0)
                output.truncate(0)

    filename = f"azollasense-logs-{start_date}-to-{end_date}.csv"
    return Response(
        stream_with_context(csv_rows()),
        mimetype="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store, max-age=0",
        },
    )


@app.route("/api/state")
def api_local_state():
    with state_lock, settings_lock:
        result = {
            "telemetry": dict(state["telemetry"]),
            "actuators": dict(state["actuators"]),
            "settings": dict(sensor_settings),
            "camera_cover": {
                "requested_open": state["camera_cover_requested_open"],
                "open": state["camera_cover_open"],
                "moving": state["camera_cover_moving"],
            },
        }
    try:
        after = max(0, int(request.args.get("alerts_after", "0")))
    except ValueError:
        after = 0
    try:
        since = max(0.0, float(request.args.get("alerts_since", "0")))
    except ValueError:
        since = 0.0
    with alert_state_lock:
        result["alert_cursor"] = system_alert_sequence
        if "alerts_recent" in request.args:
            result["alerts"] = [dict(alert) for alert in list(system_alert_history)[-10:]]
        else:
            result["alerts"] = ([dict(alert) for alert in system_alert_history
                                 if alert["id"] > after and alert.get("created_at", 0) >= since]
                                if "alerts_after" in request.args else [])
    return jsonify(result)


@app.route("/api/push/status")
def api_push_status():
    subscription = request.args.get("endpoint", "")
    with PUSH_DB_LOCK, sqlite3.connect(PUSH_DB_PATH, timeout=10) as connection:
        subscribed = bool(subscription and connection.execute(
            "SELECT 1 FROM push_subscriptions WHERE endpoint=?", (subscription,)
        ).fetchone())
    return no_store(jsonify({"public_key": VAPID_PUBLIC_KEY, "subscribed": subscribed,
                             "available": bool(webpush and VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY and VAPID_SUBJECT)}))


@app.route("/api/push/subscription", methods=["POST", "DELETE"])
def api_push_subscription():
    if request.method == "DELETE":
        data = request.get_json(silent=True) or {}
        endpoint = data.get("endpoint")
        if not isinstance(endpoint, str) or len(endpoint) > 4096:
            return jsonify({"error": "A valid subscription endpoint is required."}), 400
        with PUSH_DB_LOCK, sqlite3.connect(PUSH_DB_PATH, timeout=10) as connection:
            connection.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,))
        return no_store(jsonify({"success": True}))

    if not (webpush and VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY and VAPID_SUBJECT):
        return jsonify({"error": "Browser push is not configured on this server."}), 503
    subscription = request.get_json(silent=True)
    if not isinstance(subscription, dict):
        return jsonify({"error": "A valid browser subscription is required."}), 400
    endpoint = subscription.get("endpoint")
    keys = subscription.get("keys")
    if (not isinstance(endpoint, str) or not endpoint.startswith("https://") or len(endpoint) > 4096 or
            not isinstance(keys, dict) or not isinstance(keys.get("p256dh"), str) or not isinstance(keys.get("auth"), str)):
        return jsonify({"error": "The browser subscription is incomplete or invalid."}), 400
    with PUSH_DB_LOCK, sqlite3.connect(PUSH_DB_PATH, timeout=10) as connection:
        connection.execute("INSERT INTO push_subscriptions(endpoint,subscription_json,created_at) VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json",
                           (endpoint, json.dumps(subscription), datetime.now(timezone.utc).isoformat()))
    return no_store(jsonify({"success": True}))


@app.route("/api/vision", methods=["POST"])
def api_set_vision():
    data = request.get_json(silent=True) or {}
    enabled = bool(data.get("enabled", True))
    with state_lock:
        state["ai_vision_enabled"] = enabled
    return jsonify({"success": True, "enabled": enabled})


@app.route("/api/actuator", methods=["POST"])
def api_set_actuator():
    data = request.get_json(silent=True) or {}
    reply = handle_set_actuator(data)
    return jsonify(reply), (200 if reply.get("success") else 400)


@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    if request.method == "GET":
        with settings_lock:
            return no_store(jsonify(dict(sensor_settings)))

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"success": False, "error": "Expected a settings object."}), 400
    updated = {}
    for key, default in SENSOR_SETTINGS_DEFAULTS.items():
        value = data.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return jsonify({"success": False, "error": f"{key} must be numeric."}), 400
        value = float(value)
        limits = {
            "update_interval_seconds": (2, 3600),
            "temperature_max_c": (0, 80), "ph_min": (0, 14), "ph_max": (0, 14),
            "water_min_cm": (0, 500), "water_max_cm": (0, 500),
            "pump_target_cm": (0, 500), "pump_hysteresis_cm": (0.1, 100),
            "canopy_deploy_lux": (0, 200000), "canopy_release_lux": (0, 200000),
            "browning_alert_pct": (0, 100), "ph7_voltage": (0, 3.3),
            "ph4_voltage": (0, 3.3), "tank_depth_cm": (1, 500),
            "water_level_offset_cm": (-100, 100),
        }[key]
        if not limits[0] <= value <= limits[1]:
            return jsonify({"success": False, "error": f"{key} is out of range."}), 400
        updated[key] = value

    if updated["update_interval_seconds"] not in (2, 5, 10, 30, 60, 300, 600, 1800, 3600):
        return jsonify({"success": False, "error": "Choose a supported sensor update interval."}), 400

    if updated["ph_min"] >= updated["ph_max"] or updated["water_min_cm"] >= updated["water_max_cm"]:
        return jsonify({"success": False, "error": "Minimum thresholds must be lower than maximum thresholds."}), 400
    if updated["canopy_release_lux"] >= updated["canopy_deploy_lux"]:
        return jsonify({"success": False, "error": "Canopy release light must be lower than deploy light."}), 400
    if abs(updated["ph4_voltage"] - updated["ph7_voltage"]) < 0.05:
        return jsonify({"success": False, "error": "pH buffer voltages must differ by at least 0.05 V."}), 400
    if updated["pump_target_cm"] + updated["pump_hysteresis_cm"] > updated["tank_depth_cm"] + updated["water_level_offset_cm"]:
        return jsonify({"success": False, "error": "Pump target and stop margin must fit within the calibrated tank depth."}), 400

    with settings_lock:
        previous = dict(sensor_settings)
        sensor_settings.update(updated)
    try:
        save_sensor_settings()
    except OSError as exc:
        with settings_lock:
            sensor_settings.clear()
            sensor_settings.update(previous)
        print(f"[SETTINGS] Could not persist sensor settings: {exc}")
        return jsonify({"success": False, "error": "Could not save settings on the Raspberry Pi."}), 500

    socketio.emit("sensor_settings", updated)
    return no_store(jsonify({"success": True, "settings": updated}))


@app.route("/api/browning/latest")
def api_latest_browning_capture():
    try:
        with open(LATEST_CAPTURE_PATH, "r", encoding="utf-8") as record_file:
            return jsonify(json.load(record_file))
    except (OSError, json.JSONDecodeError):
        return jsonify({"available": False}), 404


@app.route("/api/browning/capture", methods=["POST"])
def api_trigger_browning_capture():
    try:
        if not run_daily_capture(force=True):
            return jsonify({"success": False, "error": "Camera capture failed. Check that the camera is connected."}), 503
        with open(LATEST_CAPTURE_PATH, "r", encoding="utf-8") as record_file:
            return jsonify({"success": True, "capture": json.load(record_file)})
    except Exception as exc:
        print(f"[CAPTURE] Manual capture failed: {exc}")
        return jsonify({"success": False, "error": "Capture failed. Check the server log for details."}), 500


def handle_shutdown(signum, _frame):
    print(f"\n[SHUTDOWN] Signal {signum} received — releasing camera.")
    release_camera()
    socketio.stop()


if __name__ == "__main__":
    load_model()
    threading.Thread(target=sensor_thread, daemon=True).start()
    threading.Thread(target=telemetry_log_thread, daemon=True).start()
    threading.Thread(target=serial_reader_thread, daemon=True).start()
    threading.Thread(target=capture_scheduler_thread, daemon=True).start()

    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    # Bind to all interfaces so the dashboard remains reachable on the local LAN.
    socketio.run(app, host="0.0.0.0", port=5000, allow_unsafe_werkzeug=True)

