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
| `azolla_ncnn_model/` | Exported YOLO NCNN segmentation model used by the backend. Classes are `Browning` and `Healthy`. |
| `AzollaML/train.py` | YOLO training, validation, and NCNN export workflow. |
| `firmware/esp32/azollasense_esp32/` | ESP32 Arduino firmware and hardware design files. |
| `Dockerfile`, `docker-compose.yml` | Debian 13 "Trixie" container image and Compose service for a production-like deployment. |
| `instance/` | Runtime database and settings location; generated locally and excluded from version control. |

## Run the backend

Use Python 3.11 or newer. Create and activate a virtual environment, then install the Python dependencies:

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
pip install -r requirements-windows.txt
python app-server-windows.py
```

Open [http://localhost:5000](http://localhost:5000). The Windows launcher uses camera index `0` by default. Set `AZOLLASENSE_CAMERA_INDEX` to select another camera, or `AZOLLASENSE_CAMERA_BACKEND` to select an OpenCV backend such as `DSHOW` or `MSMF`.

The first browser session creates the initial administrator account. When the server is reached from another device, that setup form also asks for `AZOLLASENSE_SETUP_TOKEN`; set the variable before starting the server and enter the same value in the form. Setup over loopback (`http://localhost:5000` on the server itself) does not require the token.

On Raspberry Pi, `app-server.py` uses Picamera2 when installed. Install it with the system package manager (`sudo apt install python3-picamera2`) and run the backend in an environment that can access the system Picamera2 package. Without Picamera2 or a usable camera, camera features are unavailable. If model loading fails, the server logs a warning and continues with the raw camera feed.

### Docker (Debian 13 "Trixie", 64-bit)

A production-like image based on `debian:trixie-slim` is included. It installs the backend into an isolated virtual environment, runs as the unprivileged `azolla` user, and keeps accounts, telemetry, settings, alerts, and captures in Docker volumes. The Flask/Socket.IO server still listens on port 5000, matching a native deployment.

Build and start the container:

```bash
cp .env.example .env    # set AZOLLASENSE_SETUP_TOKEN before the first start
docker compose up -d --build
```

Open [http://localhost:5000](http://localhost:5000). Docker forwards host-browser traffic through the bridge gateway, so the container treats it as a remote request: enter the `AZOLLASENSE_SETUP_TOKEN` value from `.env` in the setup form to create the first administrator. The token is read when the container starts, so set it before the first launch. To create the account without exposing a token, run the setup request from inside the container (loopback) instead:

```bash
docker compose exec azollasense python -c "import json,urllib.request; req=urllib.request.Request('http://127.0.0.1:5000/api/auth/setup', data=json.dumps({'username':'admin','password':'change-this-password'}).encode(), headers={'Content-Type':'application/json'}); print(urllib.request.urlopen(req).read().decode())"
```

Useful commands:

```bash
docker compose logs -f
docker compose ps
docker compose down          # keep persisted data
docker compose down -v       # also delete the data and capture volumes
```

The image works without a camera or ESP32; those features report unavailable until the devices are mapped. On a Linux host (including a Raspberry Pi), uncomment the `devices:` and `group_add:` entries in `docker-compose.yml`:

```yaml
devices:
  - /dev/ttyACM0:/dev/ttyACM0   # ESP32 USB serial
  - /dev/video0:/dev/video0     # camera, when applicable
group_add:
  - dialout
  - video
```

The default image omits Raspberry Pi `Picamera2` because it is only available from Raspberry Pi OS repositories. On a host that provides `python3-picamera2`, build with `docker build --build-arg WITH_PICAMERA2=1 -t azollasense .`, or set `WITH_PICAMERA2: "1"` under `build.args` in `docker-compose.yml`.

#### Wall-mounted kiosk

A display attached to the device itself can sign in automatically instead of stopping at the login page. Set `AZOLLASENSE_KIOSK_TOKEN` (any long random string) and optionally `AZOLLASENSE_KIOSK_USER` (a dedicated account, so the display keeps its own session while you use a phone), then load:

```
http://127.0.0.1:5000/kiosk?token=<AZOLLASENSE_KIOSK_TOKEN>
```

`/kiosk` creates a fresh session for that account and redirects to the dashboard. It only answers requests from loopback, so the Cloudflare tunnel or a reverse proxy cannot use it, and it does nothing when the token is unset. A minimal X session that keeps the dashboard on screen:

```sh
#!/bin/sh
xset s off; xset s noblank; xset -dpms
unclutter -idle 0.5 -root &
openbox-session &
. /etc/azollasense/kiosk.env          # exports AZOLLASENSE_KIOSK_TOKEN
until curl -fsS http://127.0.0.1:5000/api/auth/status >/dev/null; do sleep 2; done
while true; do
    chromium --kiosk --noerrdialogs --disable-infobars \
        --disable-session-crashed-bubble --no-first-run \
        "http://127.0.0.1:5000/kiosk?token=$AZOLLASENSE_KIOSK_TOKEN"
    sleep 2
done
```

#### Moving an existing native install into the container

If the device already ran the app natively, stop the old service first (`sudo systemctl stop azolla-server && sudo systemctl disable azolla-server`) so the SQLite files are consistent and port 5000 is free, then copy the state into the volumes before the first start:

```bash
sudo docker volume create azollasense_azollasense-data
sudo docker volume create azollasense_azollasense-captures
sudo docker run --rm -v azollasense_azollasense-data:/data \
    -v "$PWD/instance":/src:ro --entrypoint sh azollasense:latest \
    -c 'cp -a /src/. /data/ && chown -R 1000:1000 /data'
sudo docker run --rm -v azollasense_azollasense-captures:/caps \
    -v "$PWD/assets/captures":/src:ro --entrypoint sh azollasense:latest \
    -c 'cp -a /src/. /caps/ && chown -R 1000:1000 /caps'
```

Notes:

- Build for a different architecture with `docker build --platform linux/arm64 ...`; on a 64-bit Raspberry Pi the default build is already `linux/arm64`.
- The container runs as UID/GID 1000 (`azolla`). If you replace the named volumes with host bind mounts, make those paths writable by that user.
- Set `AZOLLASENSE_DATA_DIR` to a different container path only if you also change the mounted volume.
- If the build is killed with `cannot allocate memory`, `apt-get`/`dpkg` ran out of memory. The Dockerfile already serializes the builder and runtime stages; also run `docker builder prune -f` and give Docker Desktop at least 4 GB of memory before retrying.
- The first build downloads the Debian packages, PyTorch, and Ultralytics, so it is network-bound. Later builds reuse the cached layers.
- Torch and torchvision come from `https://download.pytorch.org/whl/cpu` on every architecture. PyPI's aarch64 torch wheel pulls CUDA packages (several GB) even on a CPU-only device, which exhausts small disks.

### Optional Node.js frontend proxy

The Flask backend serves the dashboard directly on port 5000. To use the Node.js static-file server in front of it, start the Python backend first, then run:

```bash
node server.js
```

The proxy listens on port `8080` by default. Configure `PORT` to change that port and `AZOLLASENSE_BACKEND_URL` to change the backend origin (default `http://127.0.0.1:5000`).

## ESP32 connection

Upload `firmware/esp32/azollasense_esp32/azollasense_esp32.ino` to an ESP32 using the Arduino IDE. Install the libraries listed in [firmware/README.md](firmware/README.md), check the pin assignments and actuator polarity for your hardware, and connect the ESP32 to the backend host over USB serial.

The backend auto-detects common serial devices. Set these environment variables if needed:

| Variable | Default | Description |
| --- | --- | --- |
| `AZOLLASENSE_SERIAL_PORT` | Automatic detection | Serial device, for example `/dev/ttyACM0` or `COM5`. |
| `AZOLLASENSE_SERIAL_BAUD` | `115200` | Serial link baud rate. |

See [firmware/README.md](firmware/README.md) for wiring, safety notes, rain sensing, calibration, and the serial protocol. Verify the relay, motor-driver, sensor voltage levels, and mechanical limits before connecting pond equipment.

## Model training

`AzollaML/train.py` trains a YOLO segmentation model, validates its best checkpoint, and exports it to NCNN. The script currently expects a dataset configuration at `AzollaSense.v2/data.yaml`, a CUDA-capable device (`device=0`), and the `yolo26n-seg.pt` base weights. The dataset and training checkpoint directories are not included in this repository; provide the dataset and required weights before training. Exported model files are placed by Ultralytics in the run output directory; copy the resulting NCNN model directory to `azolla_ncnn_model/` for backend use.

Install the listed Python dependencies before running training. Training settings such as epochs, image size, batch size, and device are configured in `AzollaML/train.py`.

## Local data and configuration

The backend creates `instance/` for local accounts, sessions, telemetry history, alerts, push subscriptions, sensor settings, and actuator preferences. Set `AZOLLASENSE_DATA_DIR` to store that state in a different directory, for example when running from a read-only source checkout. Captured images and capture metadata are written under `assets/captures/`. These are machine-specific runtime data and should be backed up or handled separately from the source code.

Accounts have `admin` and `user` roles. The first account created during setup is an admin; existing installations promote the `malik` account during the role migration. Admins can create accounts and change system controls and settings. Users can view the dashboard and telemetry. Admins receive an in-app alert when an account signs in, and can enable browser push notifications in App Settings.

Web push alerts are optional. Configure `AZOLLASENSE_VAPID_PUBLIC_KEY`, `AZOLLASENSE_VAPID_PRIVATE_KEY`, and `AZOLLASENSE_VAPID_SUBJECT` to enable push delivery. The dashboard and core monitoring do not require these keys.

For Raspberry Pi reboot controls, follow the restricted sudoers setup documented in [firmware/README.md](firmware/README.md).

## Tests

The backend regression tests cover static-file isolation, remote setup tokens, the pH exchange failsafes, and telemetry freshness. They use a temporary data directory and do not touch the live `instance/` state:

```bash
python -m unittest discover -s tests -v
```

## License

No project-wide license file is currently included. The exported model metadata identifies the model as AGPL-3.0; review the applicable model and dependency licenses before redistributing a deployment.
