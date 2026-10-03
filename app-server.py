import os
import time
import cv2
import numpy as np
from flask import Flask, Response, send_from_directory
from flask_socketio import SocketIO
from ultralytics import YOLO
import threading

# Serve static web files directly from the current directory
app = Flask(__name__, static_url_path='', static_folder='.')
socketio = SocketIO(app, cors_allowed_origins="*")

# Load YOLO NCNN model
MODEL_PATH = 'runs/segment/train/weights/best_ncnn_model'
model = YOLO(MODEL_PATH)

telemetry_data = {
    "water_level": 26.0,
    "temperature": 31.5,
    "ph": 7.2,
    "green_cov": 0.0,
    "brown_cov": 0.0,
    "total_cov": 0.0
}

ai_vision_enabled = True

def generate_camera_stream():
    # cv2.VideoCapture(0) selects the USB webcam on /dev/video0
    cap = cv2.VideoCapture(0, cv2.CAP_V4L2)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

    if not cap.isOpened():
        print("Error: Could not open USB webcam.")
        return

    while True:
        ok, frame = cap.read()

        if not ok:
            time.sleep(0.01)
            continue

        h, w, _ = frame.shape
        total_pixels = h * w

        # 1. RUN YOLO INFERENCE
        results = model(frame, verbose=False)
        result = results[0]
        
        # 2. ALWAYS CALCULATE PERCENTAGES (Even if UI toggle is OFF)
        green_pct, brown_pct = 0.0, 0.0
        if result.masks is not None and result.boxes is not None:
            masks_array = result.masks.data.cpu().numpy()
            classes = result.boxes.cls.cpu().numpy()

            if 0 in classes:
                b_mask = np.any(masks_array[classes == 0], axis=0)
                b_mask = cv2.resize(b_mask.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
                brown_pct = (np.sum(b_mask) / total_pixels) * 100

            if 1 in classes:
                g_mask = np.any(masks_array[classes == 1], axis=0)
                g_mask = cv2.resize(g_mask.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
                green_pct = (np.sum(g_mask) / total_pixels) * 100

        telemetry_data["green_cov"] = round(green_pct, 2)
        telemetry_data["brown_cov"] = round(brown_pct, 2)
        telemetry_data["total_cov"] = round(green_pct + brown_pct, 2)

        # ================================================================
        # DRAW YOLO VISUALIZATION ONLY WHEN AI VISION IS ENABLED
        # ================================================================
        if ai_vision_enabled:
            output_frame = result.plot(
                conf=False,
                labels=True,
                boxes=False,
                masks=True
            )
        else:
            # Completely raw camera frame
            output_frame = frame.copy()

        ok, encoded = cv2.imencode('.jpg', output_frame,[cv2.IMWRITE_JPEG_QUALITY, 85])

        if not ok:
            continue
        
        yield (b'--frame\r\n'
            b'Content-Type: image/jpeg\r\n\r\n' + encoded.tobytes() + b'\r\n')

def sensor_thread():
    while True:
        socketio.emit('telemetry_update', telemetry_data)
        time.sleep(2)

@socketio.on('toggle_ai_vision')
def handle_toggle_vision(data):
    global ai_vision_enabled

    enabled = bool(data.get('enabled', True))

    ai_vision_enabled = enabled

    print(
        f"[AI VISION] Overlay set to: "
        f"{'ON' if ai_vision_enabled else 'OFF'}"
    )

    return {
        "success": True,
        "enabled": ai_vision_enabled
    }

@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/video_feed')
def video_feed():
    response = Response(
        generate_camera_stream(),
        mimetype='multipart/x-mixed-replace; boundary=frame'
    )

    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"

    return response

if __name__ == '__main__':
    threading.Thread(target=sensor_thread, daemon=True).start()
    # Host on localhost port 5000 (Cloudflare will route traffic here)
    socketio.run(app, host='127.0.0.1', port=5000, allow_unsafe_werkzeug=True)