# AzollaSense

AzollaSense is a local monitoring and control system for Azolla cultivation. It combines a browser dashboard, a Python backend, ESP32 sensor and actuator firmware, and a YOLO segmentation model for estimating healthy and browned Azolla coverage.

## What it does

- Displays pond telemetry including water temperature, pH, water level, light, rain sensor readings, and canopy state.
- Streams and captures camera images, runs Azolla segmentation, and reports healthy and browned coverage.
- Supports configurable sensor calibration, thresholds, pump and canopy automation, rain protection, alerts, and telemetry history.
- Communicates with an ESP32 over USB serial using newline-delimited JSON.
- Serves as a Progressive Web App (PWA) with local user accounts and settings stored on the host running the backend.

## Repository layout

| Path | Purpose |
| --- | --- |
| `app-server.py` | Flask and Socket.IO backend, camera integration, model inference, telemetry, controls, and local persistence. |
| `app-server-windows.py` | Windows launcher that uses a connected webcam instead of Raspberry Pi Camera. |
| `index.html`, `login.html`, `css/`, `js/`, `assets/` | Dashboard, login page, frontend code, and static assets. |
| `server.js` | Optional Node.js static-file server and reverse proxy to the Python backend. |
| `Azolla NCNN Model/` | Exported YOLO NCNN segmentation model used by the backend. Classes are `Browning` and `Healthy`. |
| `AzollaML/train.py` | YOLO training, validation, and NCNN export workflow. |
| `firmware/azollasense_esp32/` | ESP32 Arduino firmware and hardware design files. |
| `instance/` | Runtime database and settings location; generated locally and excluded from version control. |

## Run the backend

Use Python 3.10 or newer. Create and activate a virtual environment, then install the Python dependencies:

```bash
python -m venv .venv
```

On Linux or macOS:

```bash
source .venv/bin/activate
pip install -r requirements.txt
python app-server.py
```

On Windows PowerShell:

```powershell
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app-server-windows.py
```

Open [http://localhost:5000](http://localhost:5000). The Windows launcher uses camera index `0` by default. Set `AZOLLASENSE_CAMERA_INDEX` to select another camera, or `AZOLLASENSE_CAMERA_BACKEND` to select an OpenCV backend such as `DSHOW` or `MSMF`.

On Raspberry Pi, `app-server.py` uses Picamera2 when installed. Install it with the system package manager (`sudo apt install python3-picamera2`) and run the backend in an environment that can access the system Picamera2 package. Without Picamera2 or a usable camera, camera features are unavailable. If model loading fails, the server logs a warning and continues with the raw camera feed.

### Optional Node.js frontend proxy

The Flask backend serves the dashboard directly on port 5000. To use the Node.js static-file server in front of it, start the Python backend first, then run:

```bash
node server.js
```

The proxy listens on port `8080` by default. Configure `PORT` to change that port and `AZOLLASENSE_BACKEND_URL` to change the backend origin (default `http://127.0.0.1:5000`).

## ESP32 connection

Upload `firmware/azollasense_esp32/azollasense_esp32.ino` to an ESP32 using the Arduino IDE. Install the libraries listed in [firmware/README.md](firmware/README.md), check the pin assignments and actuator polarity for your hardware, and connect the ESP32 to the backend host over USB serial.

The backend auto-detects common serial devices. Set these environment variables if needed:

| Variable | Default | Description |
| --- | --- | --- |
| `AZOLLASENSE_SERIAL_PORT` | Automatic detection | Serial device, for example `/dev/ttyACM0` or `COM5`. |
| `AZOLLASENSE_SERIAL_BAUD` | `115200` | Serial link baud rate. |

See [firmware/README.md](firmware/README.md) for wiring, safety notes, rain sensing, calibration, and the serial protocol. Verify the relay, motor-driver, sensor voltage levels, and mechanical limits before connecting pond equipment.

## Model training

`AzollaML/train.py` trains a YOLO segmentation model, validates its best checkpoint, and exports it to NCNN. The script currently expects a dataset configuration at `AzollaSense.v2/data.yaml`, a CUDA-capable device (`device=0`), and the `yolo26n-seg.pt` base weights. The dataset and training checkpoint directories are not included in this repository; provide the dataset and required weights before training. Exported model files are placed by Ultralytics in the run output directory; copy the resulting NCNN model directory to `Azolla NCNN Model/` for backend use.

Install the listed Python dependencies before running training. Training settings such as epochs, image size, batch size, and device are configured in `AzollaML/train.py`.

## Local data and configuration

The backend creates `instance/` for local accounts, sessions, telemetry history, alerts, push subscriptions, sensor settings, and actuator preferences. Captured images and capture metadata are written under `assets/captures/`. These are machine-specific runtime data and should be backed up or handled separately from the source code.

Web push alerts are optional. Configure `AZOLLASENSE_VAPID_PUBLIC_KEY`, `AZOLLASENSE_VAPID_PRIVATE_KEY`, and `AZOLLASENSE_VAPID_SUBJECT` to enable push delivery. The dashboard and core monitoring do not require these keys.

For Raspberry Pi reboot controls, follow the restricted sudoers setup documented in [firmware/README.md](firmware/README.md).

## License

No project-wide license file is currently included. The exported model metadata identifies the model as AGPL-3.0; review the applicable model and dependency licenses before redistributing a deployment.
