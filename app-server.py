"""
AzollaSense — Flask + Socket.IO backend

Serves the web app, streams the USB camera as MJPEG, runs YOLO
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
from flask import Flask, Response, jsonify, send_from_directory
from flask_socketio import SocketIO
from ultralytics import YOLO

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "runs", "segment", "train", "weights", "best_ncnn_model")

# Target frame size for the MJPEG stream (square crop of the camera feed)
FRAME_SIZE = 640
# Upper bound for the stream framerate (keeps CPU / USB bandwidth sane)
MAX_FPS = 15
# How often telemetry is broadcast while the camera stream is running
STREAM_TELEMETRY_INTERVAL = 0.5
PH_TIMEZONE = ZoneInfo("Asia/Manila")
CAPTURE_DIR = os.path.join(BASE_DIR, "assets", "captures")
LATEST_CAPTURE_PATH = os.path.join(CAPTURE_DIR, "latest.json")

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
    },
    "ai_vision_enabled": True,
    "stream_active": False,
    "camera": None,
    "model": None,
    "model_status": "not loaded",
    "last_capture_date": None,
}


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
    """Open the USB camera, trying platform-appropriate backends in order."""
    backends = [
        cv2.CAP_V4L2,                               # Linux
        getattr(cv2, "CAP_MSMF", cv2.CAP_ANY),    # Windows
        getattr(cv2, "CAP_DSHOW", cv2.CAP_ANY),   # Windows (DirectShow)
        cv2.CAP_ANY,
    ]
    for backend in backends:
        capture = cv2.VideoCapture(0, backend)
        if capture.isOpened():
            capture.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_SIZE)
            capture.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_SIZE)
            print(f"[CAMERA] Opened USB webcam with backend {backend}")
            return capture
        capture.release()
    return None


def release_camera():
    """Stop the stream and release the USB camera."""
    with state_lock:
        state["stream_active"] = False
        camera = state["camera"]
        state["camera"] = None
    if camera is not None:
        try:
            camera.release()
        except Exception:
            pass
        print("[CAMERA] USB webcam released.")


def center_crop_square(frame):
    """Many webcams ignore the requested resolution — crop to a centered square."""
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


def run_daily_capture(force=False):
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
        if (not force and state["last_capture_date"] == today) or state["stream_active"]:
            return False

    camera = open_camera()
    if camera is None:
        print("[CAPTURE] Could not open camera for scheduled capture.")
        return False
    try:
        # Allow auto exposure/focus to settle before using the frame.
        time.sleep(0.5)
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
        telemetry = dict(state["telemetry"])
    brown_pct = green_pct = 0.0
    output = frame
    if model is not None:
        result = model(frame, verbose=False, conf=0.95)[0]
        if result.masks is not None and result.boxes is not None:
            masks = result.masks.data.cpu().numpy()
            classes = result.boxes.cls.cpu().numpy().astype(int)
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
        "brown_cov": round(brown_pct, 2),
        "green_cov": round(green_pct, 2),
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
            print("[CAMERA] ERROR: could not open any camera backend.")
            release_camera()  # clears the stream reservation
            return
        print("[CAMERA] USB webcam streaming.")

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
                result = model(frame, verbose=False, conf=0.95)[0]

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


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

@app.route("/")
def serve_index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/video_feed")
def video_feed():
    with state_lock:
        if state["stream_active"]:
            # Only one MJPEG consumer may hold the USB camera at a time
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
    with state_lock:
        if state["stream_active"]:
            return jsonify({"success": False, "error": "Stop the live camera stream before capturing."}), 409
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
    threading.Thread(target=capture_scheduler_thread, daemon=True).start()

    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)

    # Host on localhost port 5000 (Cloudflare will route traffic here)
    socketio.run(app, host="127.0.0.1", port=5000, allow_unsafe_werkzeug=True)

