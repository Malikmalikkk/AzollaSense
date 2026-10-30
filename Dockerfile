# syntax=docker/dockerfile:1

# AzollaSense production image.
#
# Debian 13 "Trixie" slim (the 64-bit variant for the build host architecture)
# mirrors the Debian/Raspberry Pi OS production target while staying minimal.
# The Python dependencies are installed once in a builder stage and copied into
# a runtime stage that only carries the shared libraries they need.

ARG DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
# Builder: install Python dependencies into a self-contained virtualenv.
# ---------------------------------------------------------------------------
FROM debian:trixie-slim AS builder

ARG DEBIAN_FRONTEND=noninteractive
# Set to 1 on Raspberry Pi OS-based hosts that provide python3-picamera2.
ARG WITH_PICAMERA2=0

# All application dependencies ship manylinux wheels, so no compiler toolchain
# is required. Keeping this layer small matters on memory-constrained builders.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        python3 python3-venv ca-certificates \
 && if [ "$WITH_PICAMERA2" = "1" ]; then \
        apt-get install -y --no-install-recommends python3-picamera2; \
    fi \
 && rm -rf /var/lib/apt/lists/*

# --system-site-packages lets an apt-installed python3-picamera2 be imported
# while the venv still owns the application dependencies.
RUN python3 -m venv --system-site-packages /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN pip install --no-cache-dir --no-compile --upgrade pip setuptools wheel

# PyPI's Linux torch wheels bundle CUDA libraries. Production runs on CPU, so
# install the CPU build first on x86_64 to keep the image small. On arm64 the
# PyPI wheels are already CPU-only.
RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        pip install --no-cache-dir --no-compile torch torchvision \
            --index-url https://download.pytorch.org/whl/cpu \
        || echo "CPU torch wheels unavailable; falling back to PyPI"; \
    fi

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --no-compile --prefer-binary -r /tmp/requirements.txt

# ---------------------------------------------------------------------------
# Runtime: only the libraries and the prebuilt virtualenv.
# ---------------------------------------------------------------------------
FROM debian:trixie-slim AS runtime

ARG DEBIAN_FRONTEND=noninteractive
ARG WITH_PICAMERA2=0

# Copy the virtualenv first so this stage waits for the builder to finish before
# running apt. That keeps only one apt/dpkg process in memory at a time, which
# avoids OOM kills on small Docker Desktop VMs and CI runners.
COPY --from=builder /opt/venv /opt/venv

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        python3 \
        libgl1 libglib2.0-0 libgomp1 libsm6 \
        curl ca-certificates \
 && if [ "$WITH_PICAMERA2" = "1" ]; then \
        apt-get install -y --no-install-recommends python3-picamera2; \
    fi \
 && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AZOLLASENSE_DATA_DIR=/data

WORKDIR /app

# Application shell, backend, and the exported NCNN model. Mutable state is
# provided by volumes instead of being baked into the image.
COPY app-server.py index.html login.html manifest.json sw.js ./
COPY css ./css
COPY js ./js
COPY assets ./assets
COPY azolla_ncnn_model ./azolla_ncnn_model

# Run as an unprivileged user. The named volumes inherit these permissions on
# first use, and the serial/video groups allow device access when mapped.
RUN groupadd --gid 1000 azolla \
 && useradd --uid 1000 --gid 1000 --groups dialout,video \
        --create-home --shell /usr/sbin/nologin azolla \
 && mkdir -p /data /app/assets/captures \
 && chown -R azolla:azolla /data /app/assets/captures

USER azolla

VOLUME ["/data", "/app/assets/captures"]
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://127.0.0.1:5000/api/auth/status >/dev/null || exit 1

# Exec form so SIGTERM reaches the app's shutdown handler.
CMD ["python", "app-server.py"]
