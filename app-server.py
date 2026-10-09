"""
AzollaSense — Flask + Socket.IO backend

Serves the web app, streams the Raspberry Pi Camera as MJPEG, runs YOLO
segmentation for browning detection and relays telemetry to every connected client.
"""

import os
import json
import signal
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import cv2
import numpy as np
try:
    from picamera2 import Picamera2
except ImportError:
    Picamera2 = None
from flask import Flask, Response, jsonify, request, send_from_directory
from flask_socketio import SocketIO
from ultralytics import YOLO
import serial
from serial.tools import list_ports

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

# ---------------------------------------------------------------------------
# Shared state — every field below is guarded by state_lock
# ---------------------------------------------------------------------------

state_lock = threading.RLock()
state = {
    "telemetry": {
        "water_level": 26.0,
        "temperature": 31.5,
        "ph": 7.2,
        "green_cov": 0.0,
        "brown_cov": 0.0,
        "total_cov": 0.0,
        "lux": None,
    },
    "ai_vision_enabled": True,
    "stream_active": False,
    "capture_in_progress": False,
    "camera": None,
    "model": None,
    "model_status": "not loaded",
    "last_capture_date": None,
    "actuators": {"motor": False, "solenoid": False, "pump": False, "pump_manual": False,
                  "pump_auto": False, "canopy_auto": False, "device_connected": False},
}

serial_lock = threading.Lock()
serial_device = None
serial_ready = False
device_preferences = {
    "motor": False,
    "pump_manual": False,
    "pump_auto": False,
    "canopy_auto": False,
}
DEVICE_PREFERENCES_PATH = os.path.join(app.instance_path, "actuator_preferences.json")
preferences_write_lock = threading.Lock()


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
            "pump_auto": device_preferences["pump_auto"],
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


def serial_reader_thread():
    """Read ESP32 JSON telemetry and keep the existing dashboard state current."""
    global serial_device, serial_ready
    while True:
        try:
            if serial_device is None or not serial_device.is_open:
                port = find_serial_port()
                if not port:
                    time.sleep(3)
                    continue
                serial_device = serial.Serial(port, SERIAL_BAUD, timeout=1)
                serial_ready = False
                time.sleep(2)  # allow ESP32 to restart after USB serial opens
                with serial_lock:
                    with state_lock:
                        restored = dict(device_preferences)
                    # Automatic mode follows the ESP32's end-stop reading at boot.
                    restore_command = {
                        "type": "restore_state",
                        "pump_auto": restored["pump_auto"],
                        "pump": restored["pump_manual"],
                        "canopy_auto": restored["canopy_auto"],
                        "solenoid": False,
                    }
                    if not restored["canopy_auto"]:
                        restore_command["motor"] = restored["motor"]
                    serial_device.write((json.dumps(restore_command) + "\n").encode("utf-8"))
                    serial_ready = True
                print(f"[SERIAL] Connected to ESP32 on {port}")
            line = serial_device.readline().decode("utf-8", errors="ignore").strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                print(f"[SERIAL] Ignoring non-JSON line: {line[:120]}")
                continue
            if message.get("type") == "telemetry":
                with state_lock:
                    for key in ("water_level", "temperature", "ph", "lux"):
                        value = message.get(key)
                        if isinstance(value, (int, float)):
                            state["telemetry"][key] = round(value, 2)
                    for key in ("solenoid", "pump", "pump_manual", "pump_auto", "canopy_auto"):
                        if key in message:
                            state["actuators"][key] = bool(message[key])
                    if "canopy_deployed" in message:
                        state["actuators"]["motor"] = bool(message["canopy_deployed"])
                    state["actuators"]["device_connected"] = True
                    payload = dict(state["telemetry"])
                    actuators = dict(state["actuators"])
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
            with state_lock:
                state["actuators"]["device_connected"] = False
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
            main={"size": (FRAME_SIZE, FRAME_SIZE), "format": "BGR888"}
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


def _capture_image(force=False):
    """Capture and analyze a frame; force bypasses the daily schedule guard."""
    now = datetime.now(PH_TIMEZONE)
    today = now.date().isoformat()
    try:
        with open(LATEST_CAPTURE_PATH, "r", encoding="utf-8") as record_file:
            latest = json.load(record_file)
        if not force and latest.get("captured_at", "").startswith(today):
            with state_lock:
                state["last_capture_date"] = today
            return False
    except (OSError, json.JSONDecodeError):
        pass
    with state_lock:
        if not force and state["last_capture_date"] == today:
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
    with state_lock:
        state["last_capture_date"] = today
    print(f"[CAPTURE] Saved daily capture: {image_path}")
    return True


def run_daily_capture(force=False):
    """Give a requested capture exclusive camera access, preempting live video."""
    with state_lock:
        if state["capture_in_progress"]:
            return False
        state["capture_in_progress"] = True
        stream_was_active = state["stream_active"]
    try:
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
                    state["telemetry"]["green_cov"] = round(green_pct, 2)
                    state["telemetry"]["brown_cov"] = round(brown_pct, 2)
                    state["telemetry"]["total_cov"] = round(green_pct + brown_pct, 2)
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
        socketio.emit("telemetry_update", payload)


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


@socketio.on("set_actuator")
def handle_set_actuator(data):
    """Request a manual output state or switch canopy control mode."""
    data = data or {}
    name = data.get("name")
    if name not in ("motor", "solenoid", "pump", "pump_auto", "canopy_auto"):
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

    sent = send_device_command(command)
    return {"success": True, "pending": not sent}


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

@app.route("/")
def serve_index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/video_feed")
def video_feed():
    with state_lock:
        if state["capture_in_progress"]:
            return jsonify({"error": "image capture in progress"}), 409
        if state["stream_active"]:
            # Only one MJPEG consumer may hold the camera at a time
            return jsonify({"error": "camera stream already active"}), 503
        state["stream_active"] = True

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
            "telemetry": dict(state["telemetry"]),
            "actuators": dict(state["actuators"]),
        })


@app.route("/api/telemetry")
def api_telemetry():
    with state_lock:
        return jsonify(dict(state["telemetry"]))


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
    threading.Thread(target=serial_reader_thread, daemon=True).start()
    threading.Thread(target=capture_scheduler_thread, daemon=True).start()

    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    # Host on localhost port 5000 (Cloudflare will route traffic here)
    socketio.run(app, host="127.0.0.1", port=5000, allow_unsafe_werkzeug=True)

