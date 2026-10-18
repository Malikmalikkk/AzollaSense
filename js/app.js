/**
 * AzollaSense — Main Application Logic
 *
 * Dashboard telemetry, live camera stream control, AI vision toggle,
 * tab navigation, settings and modal dialogs.
 * All telemetry is server-driven: every value on screen originates from
 * the "telemetry_update" Socket.IO broadcast sent by app-server.py.
 */
(() => {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Helpers & element registry                                         */
  /* ------------------------------------------------------------------ */

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const byId = (id) => document.getElementById(id);

  // Set window.AZOLLASENSE_BACKEND_URL before this file when the backend is
  // hosted separately (for example, on a camera-connected Raspberry Pi).
  const backendBase = (window.AZOLLASENSE_BACKEND_URL || window.location.origin).replace(/\/$/, "");
  const backendUrl = (path) => `${backendBase}${path}`;

  async function loadLatestBrowningCapture() {
    try {
      const response = await fetch(backendUrl("/api/browning/latest"), { cache: "no-store" });
      if (!response.ok) return;
      const capture = await response.json();
      ["browning-capture-image", "status-browning-capture-image"].forEach((id) => {
        const image = byId(id);
        if (image && capture.image) image.src = backendUrl(capture.image);
      });
      if (capture.captured_at) {
        const date = new Date(capture.captured_at);
        const formattedTime = `CAPTURED ${new Intl.DateTimeFormat("en-PH", {
          timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short"
        }).format(date)} PHT`;
        ["browning-capture-time", "status-capture-time"].forEach((id) => {
          const time = byId(id);
          if (time) time.textContent = formattedTime;
        });
      }
      const yoloUnavailable = capture.brown_cov == null || capture.green_cov == null;
      const values = {
        "capture-brown-coverage": yoloUnavailable ? "YOLO unavailable" : `${Number(capture.brown_cov).toFixed(2)}%`,
        "capture-green-coverage": yoloUnavailable ? "YOLO unavailable" : `${Number(capture.green_cov).toFixed(2)}%`,
        "capture-temperature": capture.temperature == null ? "—" : `${capture.temperature}°C`,
        "capture-water-level": capture.water_level == null ? "—" : `${capture.water_level} cm`
      };
      Object.entries(values).forEach(([id, value]) => {
        [id, `status-${id}`].forEach((targetId) => {
          const element = byId(targetId);
          if (element) element.textContent = value;
        });
      });
    } catch (error) {
      console.warn("Could not load latest browning capture:", error);
    }
  }
  loadLatestBrowningCapture();

  const captureTrigger = byId("trigger-browning-capture");
  if (captureTrigger) {
    captureTrigger.addEventListener("click", async () => {
      captureTrigger.disabled = true;
      captureTrigger.textContent = "Capturing…";
      try {
        const response = await fetch(backendUrl("/api/browning/capture"), { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Capture failed.");
        await loadLatestBrowningCapture();
        showToast("Debug capture saved.");
      } catch (error) {
        showToast(error.message || "Could not capture image.");
      } finally {
        captureTrigger.disabled = false;
        captureTrigger.textContent = "Capture now";
      }
    });
  }

  // All live traffic stays on the Pi. Polling avoids a CDN-hosted Socket.IO
  // client dependency and keeps controls available without internet access.
  const localSocketHandlers = {};
  const socket = {
    on(event, callback) { localSocketHandlers[event] = callback; },
    emit(event, data, acknowledge) {
      const endpoint = event === "set_actuator" ? "/api/actuator" : "/api/vision";
      fetch(backendUrl(endpoint), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data || {}) })
        .then(async (response) => ({ response, result: await response.json() }))
        .then(({ response, result }) => acknowledge?.(response.ok ? result : { success: false, error: result.error }))
        .catch(() => acknowledge?.({ success: false, error: "Local Raspberry Pi server is unavailable." }));
    }
  };

  let streamRunning = false;
  let aiVisionOn = true;
  let sensorSettings = {};
  const dirtySensorSettings = new Set();

  function applySensorSettings(settings, force = false) {
    Object.entries(settings || {}).forEach(([key, value]) => {
      if (force || !dirtySensorSettings.has(key)) sensorSettings[key] = value;
    });
    qsa("[data-setting]").forEach((input) => {
      const key = input.dataset.setting;
      const value = sensorSettings[key];
      if (value !== undefined && (force || !dirtySensorSettings.has(key)) && document.activeElement !== input) input.value = value;
    });
  }

  qsa("[data-setting]").forEach((input) => {
    const markDirty = () => dirtySensorSettings.add(input.dataset.setting);
    input.addEventListener("input", markDirty);
    input.addEventListener("change", markDirty);
  });

  fetch(backendUrl("/api/settings"), { cache: "no-store" })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error("Could not load sensor settings.")))
    .then(applySensorSettings)
    .catch((error) => console.warn(error.message));

  const cloudSyncStatus = byId("cloud-sync-status");
  const cloudSyncBadge = byId("cloud-sync-badge");
  function isLocalHostname(hostname) {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal") || host.endsWith(".home") || host.endsWith(".home.arpa") || host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
    if (host.includes(":")) return false;
    const octets = host.split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return !host.includes(".");
    return octets[0] === 10 || octets[0] === 127 || octets[0] === 0 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
  }

  async function refreshCloudSyncStatus() {
    if (!cloudSyncStatus) return;
    const publicHost = !isLocalHostname(window.location.hostname);
    let connected = false;
    if (publicHost && navigator.onLine) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(backendUrl("/health"), { cache: "no-store", signal: controller.signal });
        connected = response.ok;
      } catch (_) { connected = false; }
      finally { window.clearTimeout(timeout); }
    }
    cloudSyncStatus.textContent = connected ? "Connected" : "Disconnected";
    cloudSyncStatus.title = connected ? "The app is being served from an online host." : "The app is available locally only, or the online service is unreachable.";
    if (cloudSyncBadge) cloudSyncBadge.classList.toggle("is-hidden", !connected);
  }
  refreshCloudSyncStatus();
  window.addEventListener("online", refreshCloudSyncStatus);
  window.addEventListener("offline", refreshCloudSyncStatus);
  window.setInterval(refreshCloudSyncStatus, 30000);

  /* ------------------------------------------------------------------ */
  /* Toast notifications                                                */
  /* ------------------------------------------------------------------ */

  function showToast(message) {
    const container = byId("toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "🌿";
    const text = document.createElement("span");
    text.textContent = message;
    toast.append(icon, text);
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  /* ------------------------------------------------------------------ */
  /* App loader (welcome splash)                                        */
  /* ------------------------------------------------------------------ */

  const appLoader = byId("app-loader");
  let loaderDismissed = false;

  function dismissLoader() {
    if (loaderDismissed || !appLoader) return;
    loaderDismissed = true;
    appLoader.classList.add("is-dismissed");
    appLoader.remove();
  }

  // Keep the welcome image visible for one second after app startup.
  setTimeout(dismissLoader, 1000);

  /* ------------------------------------------------------------------ */
  /* Live camera stream control                                         */
  /* ------------------------------------------------------------------ */

  const liveFeed = byId("live-pi-feed");
  const startBtn = byId("start-stream-btn");
  const stopBtn = byId("stop-stream-btn");
  const liveBadge = byId("feed-live-badge");
  const cvToggleBtn = byId("toggle-cv-overlay");

  function setStreamUI(running) {
    streamRunning = running;
    if (startBtn) startBtn.classList.toggle("is-hidden", running);
    if (stopBtn) stopBtn.classList.toggle("is-hidden", !running);
    if (liveBadge) liveBadge.classList.toggle("is-hidden", !running);
    if (cvToggleBtn) cvToggleBtn.classList.toggle("is-hidden", !running);
  }

  let lastSessionActivitySent = 0;
  function sendSessionActivity(force = false) {
    const now = Date.now();
    if (!force && now - lastSessionActivitySent < 60000) return;
    lastSessionActivitySent = now;
    fetch(backendUrl("/api/auth/activity"), { method: "POST", credentials: "same-origin", cache: "no-store" })
      .then((response) => {
        if (response.status === 401) location.replace("/login");
      })
      .catch(() => {});
  }

  ["pointerdown", "keydown", "touchstart", "wheel"].forEach((eventName) => {
    document.addEventListener(eventName, () => sendSessionActivity(), { passive: true });
  });
  function resetVisionToggle() {
    aiVisionOn = true;
    if (!cvToggleBtn) return;
    cvToggleBtn.textContent = "AI Vision: ON";
    cvToggleBtn.classList.add("vision-on");
    cvToggleBtn.setAttribute("aria-pressed", "true");
  }

  function stopCameraStream(notify = true) {
    if (!streamRunning) return;

    if (liveFeed) liveFeed.removeAttribute("src");

    resetVisionToggle();
    setStreamUI(false);

    if (notify) showToast("Camera stream stopped.");
  }

  if (startBtn && liveFeed) {
    startBtn.addEventListener("click", () => {
      // Cache-bust so the browser always opens a fresh MJPEG session
      liveFeed.src = backendUrl(`/video_feed?stream=${Date.now()}`);
      setStreamUI(true);
      showToast("Connecting to farm camera…");
    });
  }

  if (liveFeed) {
    liveFeed.addEventListener("error", () => {
      if (!streamRunning) return;
      setStreamUI(false);
      showToast("⚠ Could not reach the camera stream.");
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener("click", () => stopCameraStream());
  }

  window.addEventListener("beforeunload", () => {
    if (!streamRunning) return;
    // Closing this viewer's MJPEG response releases its shared-feed subscription.
    if (liveFeed) liveFeed.removeAttribute("src");
  });

  /* ------------------------------------------------------------------ */
  /* AI vision toggle                                                   */
  /* ------------------------------------------------------------------ */

  if (cvToggleBtn) {
    cvToggleBtn.addEventListener("click", () => {
      aiVisionOn = !aiVisionOn;

      socket.emit("toggle_ai_vision", { enabled: aiVisionOn });

      cvToggleBtn.textContent = aiVisionOn ? "AI Vision: ON" : "AI Vision: OFF";
      cvToggleBtn.classList.toggle("vision-on", aiVisionOn);
      cvToggleBtn.setAttribute("aria-pressed", String(aiVisionOn));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Fullscreen feed                                                    */
  /* ------------------------------------------------------------------ */

  const fullscreenBtn = byId("fullscreen-feed-btn");
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener("click", () => {
      const wrapper = fullscreenBtn.closest(".tank-image-wrapper");
      if (!wrapper) return;

      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        wrapper.requestFullscreen().catch((err) => console.error("Fullscreen failed:", err));
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Tab navigation                                                     */
  /* ------------------------------------------------------------------ */

  const tabButtons = qsa(".nav-tab-btn");
  const tabPanels = qsa(".tab-panel");

  function switchTab(targetTabId) {
    tabPanels.forEach((panel) => panel.classList.toggle("active", panel.id === `view-${targetTabId}`));
    tabButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === targetTabId));

    const scroller = qs(".screen-scroll-container");
    if (scroller) scroller.scrollTop = 0;
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Shortcut buttons that jump straight to a screen (e.g. dashboard chevron)
  qsa("[data-goto-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.gotoTab));
  });

  const brandLogo = byId("brand-logo-home");
  if (brandLogo) {
    brandLogo.addEventListener("click", (e) => {
      e.preventDefault();
      switchTab("dashboard");
    });
  }

  const statusBackBtn = byId("status-back-btn");
  if (statusBackBtn) {
    statusBackBtn.addEventListener("click", () => switchTab("dashboard"));
  }


  /* ------------------------------------------------------------------ */
  /* Socket.IO — connection state & live telemetry                      */
  /* ------------------------------------------------------------------ */

  socket.on("connect", () => {
    console.log("Socket.IO connected:", socket.id);
    showToast("✓ Connected to live AzollaSense stream");
    loadLatestBrowningCapture();
  });

  socket.on("disconnect", () => {
    console.warn("Socket.IO disconnected");
    showToast("⚠ Connection to farm unit lost");
  });

  socket.on("stream_preempted", () => {
    if (liveFeed) liveFeed.removeAttribute("src");
    resetVisionToggle();
    setStreamUI(false);
    showToast("Live stream stopped so the camera can capture an image.");
  });

  socket.on("browning_capture_updated", loadLatestBrowningCapture);

  let alertCursor = 0;
  const alertListenStartedAt = Date.now() / 1000;
  const recentNotifications = byId("recent-notifications");
  const recentAlertItems = new Map();

  function addRecentNotification(alert) {
    if (!recentNotifications || !alert || typeof alert.body !== "string") return;
    const id = alert.id ?? `${alert.created_at}-${alert.title}`;
    if (recentAlertItems.has(id)) return;
    const severity = ["success", "info", "warning", "error", "critical"].includes(alert.severity)
      ? alert.severity : "info";
    const item = document.createElement("article");
    item.className = `notification-card notification-${severity}`;
    item.dataset.alertId = String(id);
    const heading = document.createElement("div");
    heading.className = "notification-card-heading";
    const title = document.createElement("strong");
    title.textContent = alert.title || "System notification";
    const time = document.createElement("time");
    const createdAt = Number(alert.created_at);
    if (Number.isFinite(createdAt)) {
      const date = new Date(createdAt * 1000);
      time.dateTime = date.toISOString();
      time.textContent = new Intl.DateTimeFormat("en-PH", {
        timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short"
      }).format(date);
    }
    const body = document.createElement("p");
    body.textContent = alert.body;
    heading.append(title, time);
    item.append(heading, body);
    recentAlertItems.set(id, item);
    recentNotifications.querySelector(".notifications-empty")?.remove();
    recentNotifications.prepend(item);
    while (recentAlertItems.size > 10) {
      const oldestId = recentAlertItems.keys().next().value;
      recentAlertItems.get(oldestId)?.remove();
      recentAlertItems.delete(oldestId);
    }
  }

  function displaySystemAlert(alert) {
    addRecentNotification(alert);
    if (alert && typeof alert.body === "string") {
      showToast(`${alert.title ? `${alert.title}: ` : ""}${alert.body}`);
    }
  }

  function updateRainSensorDisplay(data) {
    if (!data || data.rain_sensor_raw === undefined) return;
    const setValues = (selector, text) => qsa(selector).forEach((el) => { el.textContent = text; });
    const raw = Number(data.rain_sensor_raw);
    if (data.rain_sensor_raw === null || !Number.isFinite(raw)) {
      setValues(".rain-sensor-reading", "ADC —");
      setValues(".rain-sensor-status", data.rain_protection_active
        ? "Sensor unavailable — canopy protection remains active"
        : "Waiting for sensor data");
      return;
    }

    setValues(".rain-sensor-reading", `ADC ${Math.round(raw)}`);
    let rainStatus = "Waiting for sensor data";
    let statusColor = "";
    if (data.rain_detected === true) {
      rainStatus = data.rain_protection_active
        ? "Wet — canopy protection active"
        : "Wet — confirming sensor reading";
      statusColor = "#1565c0";
    } else if (data.rain_protection_active && Number.isFinite(Number(data.rain_dry_remaining_seconds))) {
      const seconds = Math.max(0, Math.round(Number(data.rain_dry_remaining_seconds)));
      rainStatus = `Drying hold: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} remaining`;
      statusColor = "#ad6a00";
    } else if (data.rain_protection_active) {
      rainStatus = "Rain protection active";
      statusColor = "#1565c0";
    } else if (data.rain_detected === false) {
      rainStatus = "Dry — canopy protection released";
      statusColor = "#2e7d32";
    }
    setValues(".rain-sensor-status", rainStatus);
    qsa(".rain-sensor-status").forEach((el) => { el.style.color = statusColor; });
  }

  socket.on("telemetry_update", (data) => {
    const setValues = (selector, text) => qsa(selector).forEach((el) => { el.textContent = text; });

    if (data.sensor_updated_at) {
      const updatedAt = new Date(data.sensor_updated_at);
      if (!Number.isNaN(updatedAt.getTime())) {
        const formatted = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(updatedAt);
        qsa(".last-sensor-update").forEach((el) => {
          el.textContent = formatted;
          el.dateTime = updatedAt.toISOString();
        });
      }
    }

    if (data.water_level !== undefined) setValues(".val-water", `${data.water_level} cm`);
    if (data.temperature !== undefined) setValues(".val-temp", `${data.temperature}°C`);
    if (data.ph !== undefined) setValues(".val-ph", `${data.ph}`);
    if (data.ph_voltage !== undefined && data.ph_voltage !== null) {
      setValues(".val-ph-voltage", `${Number(data.ph_voltage).toFixed(3)} V`);
    }
    updateRainSensorDisplay(data);
    if (data.lux !== undefined && data.lux !== null && Number.isFinite(Number(data.lux))) {
      const lux = Math.max(0, Number(data.lux));
      setValues(".val-lux", `${Math.round(lux).toLocaleString()} lx`);
      const meter = qs(".light-meter-track");
      const meterFill = qs(".light-meter-fill");
      const lightStatus = qs(".light-intensity-status");
      if (meter) meter.setAttribute("aria-valuenow", String(Math.min(Math.round(lux), 60000)));
      if (meterFill) meterFill.style.width = `${Math.min(lux / 60000 * 100, 100)}%`;
      if (lightStatus) {
        lightStatus.textContent = lux >= (sensorSettings.canopy_deploy_lux ?? 45000)
          ? "Canopy deploy threshold reached"
          : "Below canopy deploy threshold";
      }
    }
    if (data.total_cov !== undefined) setValues(".val-cov", `${data.total_cov}%`);

    qsa(".val-browning-sectors").forEach((el) => {
      const brownPct = Number(data.brown_cov) || 0;
      if (brownPct >= (sensorSettings.browning_alert_pct ?? 10)) {
        el.textContent = `Browning Detected: ${brownPct}%`;
        el.style.color = "#e65100";
      } else {
        el.textContent = `Healthy (${brownPct}% browning)`;
        el.style.color = "#2e7d32";
      }
    });

    const badgeText = qs(".system-status-badge span");
    if (badgeText) {
      const temp = Number(data.temperature) || 0;
      const ph = Number(data.ph) || 7;
      const brownPct = Number(data.brown_cov) || 0;
      badgeText.textContent =
        temp > (sensorSettings.temperature_max_c ?? 34) ||
        ph < (sensorSettings.ph_min ?? 6.5) || ph > (sensorSettings.ph_max ?? 7.5) ||
        brownPct >= (sensorSettings.browning_alert_pct ?? 10) ||
        (data.water_level !== undefined && (data.water_level < (sensorSettings.water_min_cm ?? 20) || data.water_level > (sensorSettings.water_max_cm ?? 30)))
          ? "System Alert: Action Required"
          : "System Status";
    }

  });

  socket.on("rain_sensor_update", updateRainSensorDisplay);

  socket.on("system_alert", displaySystemAlert);

  const actuatorInputs = {
    motor: byId("motor-switch"),
    solenoid: byId("solenoid-switch"),
    pump: byId("pump-switch"),
    ph_auto: byId("ph-auto-switch"),
    canopy_auto: byId("canopy-auto-switch")
  };
  Object.entries(actuatorInputs).forEach(([name, input]) => {
    if (!input) return;
    input.addEventListener("change", () => {
      input.disabled = true;
      socket.emit("set_actuator", { name, enabled: input.checked }, (reply) => {
        input.disabled = false;
        if (!reply || !reply.success) {
          input.checked = !input.checked;
          showToast(reply?.error || "Could not send command to the ESP32.");
        }
      });
    });
  });

  socket.on("actuator_update", (data) => {
    Object.entries(actuatorInputs).forEach(([name, input]) => {
      const stateKey = name === "pump" ? "pump_manual" : name;
      if (input && data[stateKey] !== undefined) input.checked = Boolean(data[stateKey]);
    });
    const connection = byId("device-connection-status");
    if (connection) {
      connection.textContent = data.device_connected ? "Connected" : "Disconnected";
      connection.style.color = data.device_connected ? "#2e7d32" : "#c62828";
    }
  });

  socket.on("sensor_settings", applySensorSettings);

  async function refreshLocalState() {
    try {
      const query = alertCursor === 0
        ? "?alerts_recent=10"
        : `?alerts_after=${encodeURIComponent(alertCursor)}&alerts_since=${encodeURIComponent(alertListenStartedAt)}`;
      const response = await fetch(backendUrl(`/api/state${query}`), { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401) { location.replace("/login"); return; }
      if (!response.ok) throw new Error("Local server unavailable");
      const data = await response.json();
      (data.alerts || []).forEach((alert) => {
        if (alertCursor === 0) addRecentNotification(alert);
        else displaySystemAlert(alert);
      });
      alertCursor = data.alert_cursor ?? alertCursor;
      localSocketHandlers.telemetry_update?.(data.telemetry);
      localSocketHandlers.actuator_update?.(data.actuators);
      localSocketHandlers.sensor_settings?.(data.settings);
      if (!localSocketHandlers.connected) {
        localSocketHandlers.connected = true;
        localSocketHandlers.connect?.();
      }
    } catch (_) {
      if (localSocketHandlers.connected) {
        localSocketHandlers.connected = false;
        localSocketHandlers.disconnect?.();
      }
    }
  }
  refreshLocalState();
  window.setInterval(refreshLocalState, 1500);

  const logoutButton = byId("logout-btn");
  fetch(backendUrl("/api/auth/status"), { cache: "no-store", credentials: "same-origin" })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error("Not signed in")))
    .then((account) => {
      const name = byId("profile-username");
      const profile = byId("profile-btn");
      if (name && account.username) name.textContent = account.username;
      if (profile && account.username) profile.title = `Signed in as ${account.username}`;
      if (account.is_admin) {
        const accountTab = byId("account-management-tab");
        if (accountTab) accountTab.classList.remove("is-hidden");
        loadManagedUsers();
      }
    })
    .catch(() => { location.replace("/login"); });

  qsa("[data-device-reboot]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = button.dataset.deviceReboot;
      const label = target === "esp32" ? "ESP32" : "Raspberry Pi";
      if (!window.confirm(`Reboot the ${label} now?`)) return;
      button.disabled = true;
      try {
        const response = await fetch(backendUrl("/api/devices/reboot"), {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Could not reboot ${label}.`);
        showToast(result.message || `${label} reboot requested.`);
      } catch (error) {
        showToast(error.message || `Could not reboot ${label}.`);
      } finally {
        button.disabled = false;
      }
    });
  });

  if (logoutButton) logoutButton.addEventListener("click", async () => {
    logoutButton.disabled = true;
    try {
      await fetch(backendUrl("/api/auth/logout"), { method: "POST", credentials: "same-origin" });
      location.replace("/login");
    } catch (_) { logoutButton.disabled = false; showToast("Could not reach the local server."); }
  });

  const addUserForm = byId("add-user-form");
  if (addUserForm) addUserForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = byId("add-user-message");
    const submit = addUserForm.querySelector('button[type="submit"]');
    const formData = new FormData(addUserForm);
    message.textContent = "Creating account…";
    message.classList.remove("is-error");
    if (submit) submit.disabled = true;
    try {
      const response = await fetch(backendUrl("/api/auth/users"), {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: formData.get("username"), password: formData.get("password") })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not create account.");
      addUserForm.reset();
      message.textContent = "Account created on this Raspberry Pi.";
      loadManagedUsers();
    } catch (error) {
      message.textContent = error.message || "Could not reach the local server.";
      message.classList.add("is-error");
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  async function loadManagedUsers() {
    const list = byId("managed-user-list");
    if (!list) return;
    try {
      const response = await fetch(backendUrl("/api/auth/users"), { cache: "no-store", credentials: "same-origin" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load accounts.");
      list.replaceChildren();
      (result.users || []).forEach((user) => {
        const row = document.createElement("div");
        row.className = "account-list-row";
        const details = document.createElement("div");
        const username = document.createElement("strong");
        username.textContent = user.username;
        const created = document.createElement("span");
        created.className = "account-created-at";
        const createdDate = new Date(user.created_at);
        created.textContent = `Created ${Number.isNaN(createdDate.getTime()) ? user.created_at : createdDate.toLocaleDateString()}`;
        const status = document.createElement("span");
        status.className = `account-status ${user.active ? "is-active" : "is-inactive"}`;
        status.textContent = user.active ? "Active session" : "Signed out";
        details.append(username, status, created);
        row.append(details);
        if (user.active) {
          const signOut = document.createElement("button");
          signOut.className = "account-logout-btn";
          signOut.type = "button";
          signOut.textContent = "Sign out";
          signOut.setAttribute("aria-label", `Sign out ${user.username}`);
          signOut.addEventListener("click", async () => {
            signOut.disabled = true;
            try {
              const response = await fetch(backendUrl(`/api/auth/users/${user.id}/logout`), {
                method: "POST", credentials: "same-origin"
              });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error || "Could not sign out account.");
              loadManagedUsers();
              showToast(`Signed out ${user.username}.`);
            } catch (error) {
              signOut.disabled = false;
              showToast(error.message || "Could not reach the local server.");
            }
          });
          row.append(signOut);
        }
        if (user.username.toLowerCase() === "malik") {
          const role = document.createElement("span");
          role.className = "account-admin-label";
          role.textContent = "System administrator";
          row.append(role);
        } else {
          const remove = document.createElement("button");
          remove.className = "account-delete-btn";
          remove.type = "button";
          remove.textContent = "Remove";
          remove.setAttribute("aria-label", `Remove account ${user.username}`);
          remove.addEventListener("click", async () => {
            if (!window.confirm(`Remove the account “${user.username}”? This signs it out immediately.`)) return;
            remove.disabled = true;
            try {
              const deletion = await fetch(backendUrl(`/api/auth/users/${user.id}`), { method: "DELETE", credentials: "same-origin" });
              const deletionResult = await deletion.json();
              if (!deletion.ok) throw new Error(deletionResult.error || "Could not remove account.");
              loadManagedUsers();
              showToast(`Account ${user.username} removed.`);
            } catch (error) {
              remove.disabled = false;
              showToast(error.message || "Could not reach the local server.");
            }
          });
          row.append(remove);
        }
        list.append(row);
      });
      if (!result.users?.length) {
        const empty = document.createElement("p");
        empty.className = "setting-help-text";
        empty.textContent = "No user accounts found.";
        list.append(empty);
      }
    } catch (error) {
      list.textContent = error.message || "Could not load accounts.";
    }
  }


  /* ------------------------------------------------------------------ */
  /* Settings screen                                                    */
  /* ------------------------------------------------------------------ */

  const settingSegments = qsa(".settings-segmented-bar .segment-item");
  const settingGroups = qsa(".settings-subgroup");

  settingSegments.forEach((segment) => {
    segment.addEventListener("click", () => {
      settingSegments.forEach((s) => s.classList.toggle("active", s === segment));
      const category = segment.dataset.category;
      settingGroups.forEach((group) => {
        group.classList.toggle("is-hidden", group.dataset.group !== category);
      });
      const saveButton = byId("save-settings-btn");
      if (saveButton) saveButton.classList.toggle("is-hidden", category === "accounts");
    });
  });

  const notifToggle = byId("setting-notif-toggle");
  const notifStatusText = byId("notif-status-text");
  function decodeVapidKey(encoded) {
    const output = String(encoded || "").trim();
    const match = output.match(/(?:Application Server Key\s*=\s*)?([A-Za-z0-9_-]+={0,2})$/i);
    if (!match) throw new Error("The server's VAPID public key is malformed. Check AZOLLASENSE_VAPID_PUBLIC_KEY.");
    const base64 = match[1].replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  }
  async function getPushSubscriptionStatus(subscription) {
    const endpoint = subscription?.endpoint || "";
    const response = await fetch(backendUrl(`/api/push/status?endpoint=${encodeURIComponent(endpoint)}`), { cache: "no-store", credentials: "same-origin" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not check notification setup.");
    return result;
  }
  async function enablePushNotifications() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      throw new Error("This browser does not support push notifications.");
    }
    if (!window.isSecureContext) throw new Error("Notifications require HTTPS or localhost.");
    const registration = await navigator.serviceWorker.ready;
    const current = await registration.pushManager.getSubscription();
    const status = await getPushSubscriptionStatus(current);
    if (!status.available || !status.public_key) throw new Error("Browser push is not configured on this server.");
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was denied. Allow notifications in browser settings to enable alerts.");
    const subscription = current || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(status.public_key)
    });
    const response = await fetch(backendUrl("/api/push/subscription"), {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON())
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      if (!current) await subscription.unsubscribe().catch(() => {});
      throw new Error(result.error || "Could not save this browser's notification subscription.");
    }
  }
  async function disablePushNotifications() {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const response = await fetch(backendUrl("/api/push/subscription"), {
      method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not disable browser notifications.");
    await subscription.unsubscribe();
  }
  if (notifToggle && notifStatusText) {
    if ("serviceWorker" in navigator) navigator.serviceWorker.ready.then(async (registration) => {
      try {
        const subscription = await registration.pushManager.getSubscription();
        const status = await getPushSubscriptionStatus(subscription);
        notifToggle.checked = Boolean(subscription && status.subscribed);
        notifStatusText.textContent = notifToggle.checked ? "Enabled" : "Disabled";
        if (!status.available && !notifToggle.checked) notifStatusText.title = "Server push settings are not configured.";
      } catch (error) { console.warn("Could not load notification preference:", error); }
    });
    notifToggle.addEventListener("change", async () => {
      const enabling = notifToggle.checked;
      notifToggle.disabled = true;
      try {
        if (enabling) await enablePushNotifications();
        else await disablePushNotifications();
        notifStatusText.textContent = enabling ? "Enabled" : "Disabled";
        notifStatusText.title = "";
        showToast(enabling ? "Background push alerts enabled." : "Background push alerts disabled.");
      } catch (error) {
        notifToggle.checked = !enabling;
        notifStatusText.textContent = notifToggle.checked ? "Enabled" : "Disabled";
        showToast(error.message || "Could not update notification settings.");
      } finally { notifToggle.disabled = false; }
    });
  }

  // Static info cards that simply acknowledge via toast
  qsa("[data-toast]").forEach((el) => {
    el.addEventListener("click", () => showToast(el.dataset.toast));
  });

  const saveSettingsBtn = byId("save-settings-btn");
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener("click", async () => {
      const settings = {};
      let valid = true;
      qsa("[data-setting]").forEach((input) => {
        const value = Number(input.value);
        if (!input.value.trim() || !Number.isFinite(value) || !input.checkValidity()) {
          input.setAttribute("aria-invalid", "true"); valid = false;
        } else { input.removeAttribute("aria-invalid"); settings[input.dataset.setting] = value; }
      });
      if (!valid) return showToast("Check the highlighted settings values.");
      saveSettingsBtn.disabled = true;
      const originalLabel = saveSettingsBtn.textContent;
      saveSettingsBtn.textContent = "Saving…";
      qsa("[data-setting]").forEach((input) => { input.disabled = true; });
      try {
        const response = await fetch(backendUrl("/api/settings"), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || "Could not save settings.");
        dirtySensorSettings.clear();
        applySensorSettings(result.settings, true);
        showToast("Settings saved on the Raspberry Pi.");
      } catch (error) {
        console.error("Could not save sensor settings:", error);
        showToast(error.message || "Could not save settings.");
      }
      finally {
        qsa("[data-setting]").forEach((input) => { input.disabled = false; });
        saveSettingsBtn.disabled = false;
        saveSettingsBtn.textContent = originalLabel;
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Modals (event logs & operator profile)                             */
  /* ------------------------------------------------------------------ */

  const modalBackdrops = qsa(".modal-backdrop");
  const logsModal = byId("logs-modal");
  const profileModal = byId("profile-modal");

  function openModal(modal) {
    if (modal) modal.classList.add("open");
  }

  function closeModals() {
    modalBackdrops.forEach((modal) => modal.classList.remove("open"));
  }

  const logsForm = byId("logs-filter-form");
  const logsStartDate = byId("logs-start-date");
  const logsEndDate = byId("logs-end-date");
  const logsTableBody = byId("logs-table-body");
  const logsTableStatus = byId("logs-table-status");
  const logsPageStatus = byId("logs-page-status");
  const logsPreviousPage = byId("logs-prev-page");
  const logsNextPage = byId("logs-next-page");
  const LOGS_PAGE_SIZE = 30;
  let logsOffset = 0;
  let logsTotal = 0;

  function manilaDateString(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }

  function logsDateQuery() {
    return new URLSearchParams({ start: logsStartDate.value, end: logsEndDate.value });
  }

  function displayLogValue(value, digits = 2) {
    if (value === null || value === undefined || value === "") return "—";
    return typeof value === "number" ? value.toFixed(digits) : String(value);
  }

  async function loadTelemetryLogs() {
    if (!logsTableBody || !logsStartDate?.value || !logsEndDate?.value) return;
    if (logsStartDate.value > logsEndDate.value) {
      logsTableStatus.textContent = "The start date must not be after the end date.";
      return;
    }
    logsTableStatus.textContent = "Loading readings…";
    logsTableBody.replaceChildren();
    try {
      const query = logsDateQuery();
      query.set("limit", String(LOGS_PAGE_SIZE));
      query.set("offset", String(logsOffset));
      const response = await fetch(backendUrl(`/api/logs?${query}`), { cache: "no-store", credentials: "same-origin" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load telemetry history.");
      logsTotal = result.total;
      result.entries.forEach((entry) => {
        const row = document.createElement("tr");
        const timestamp = new Date(entry.timestamp);
        const values = [
          Number.isNaN(timestamp.getTime()) ? entry.timestamp : new Intl.DateTimeFormat("en-PH", {
            timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "medium"
          }).format(timestamp),
          displayLogValue(entry.ph), displayLogValue(entry.water_level),
          displayLogValue(entry.temperature), displayLogValue(entry.lux, 0),
          displayLogValue(entry.canopy_status), displayLogValue(entry.browning_pct),
          displayLogValue(entry.occupancy_pct)
        ];
        values.forEach((value) => {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        });
        logsTableBody.append(row);
      });
      const first = logsTotal ? logsOffset + 1 : 0;
      const last = Math.min(logsOffset + result.entries.length, logsTotal);
      logsPageStatus.textContent = logsTotal ? `Showing ${first}–${last} of ${logsTotal}` : "0 readings";
      logsTableStatus.textContent = logsTotal ? "Readings are stored locally for up to 90 days." : "No readings saved for these dates.";
      logsPreviousPage.disabled = logsOffset === 0;
      logsNextPage.disabled = logsOffset + result.entries.length >= logsTotal;
    } catch (error) {
      logsTableStatus.textContent = error.message || "Could not load telemetry history.";
      logsPageStatus.textContent = "—";
      logsPreviousPage.disabled = true;
      logsNextPage.disabled = true;
    }
  }

  function openLogsModal() {
    if (!logsStartDate.value) logsStartDate.value = manilaDateString();
    if (!logsEndDate.value) logsEndDate.value = manilaDateString();
    logsOffset = 0;
    openModal(logsModal);
    loadTelemetryLogs();
  }

  if (logsForm) {
    logsForm.addEventListener("submit", (event) => {
      event.preventDefault();
      logsOffset = 0;
      loadTelemetryLogs();
    });
  }
  if (logsPreviousPage) {
    logsPreviousPage.addEventListener("click", () => {
      logsOffset = Math.max(0, logsOffset - LOGS_PAGE_SIZE);
      loadTelemetryLogs();
    });
  }
  if (logsNextPage) {
    logsNextPage.addEventListener("click", () => {
      if (logsOffset + LOGS_PAGE_SIZE < logsTotal) logsOffset += LOGS_PAGE_SIZE;
      loadTelemetryLogs();
    });
  }
  const logsExportButton = byId("logs-export-btn");
  if (logsExportButton) {
    logsExportButton.addEventListener("click", async () => {
      if (!logsForm.reportValidity() || logsStartDate.value > logsEndDate.value) {
        logsTableStatus.textContent = "Choose a valid date range before downloading.";
        return;
      }
      const exportButtonText = logsExportButton.textContent;
      logsExportButton.disabled = true;
      logsExportButton.textContent = "Preparing CSV…";
      try {
        const response = await fetch(backendUrl(`/api/logs/export?${logsDateQuery()}`), { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) {
          const result = await response.json();
          throw new Error(result.error || "Could not export telemetry history.");
        }
        const blob = await response.blob();
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = `azollasense-logs-${logsStartDate.value}-to-${logsEndDate.value}.csv`;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      } catch (error) {
        logsTableStatus.textContent = error.message || "Could not export telemetry history.";
      } finally {
        logsExportButton.disabled = false;
        logsExportButton.textContent = exportButtonText;
      }
    });
  }

  const viewAllLogsBtn = byId("view-all-logs-btn");
  if (viewAllLogsBtn) {
    viewAllLogsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      openLogsModal();
    });
  }

  const statusLogsPill = byId("status-logs-pill");
  if (statusLogsPill) {
    statusLogsPill.addEventListener("click", openLogsModal);
  }

  const openTelemetryHistory = byId("open-telemetry-history");
  if (openTelemetryHistory) openTelemetryHistory.addEventListener("click", openLogsModal);

  const profileBtn = byId("profile-btn");
  if (profileBtn) {
    profileBtn.addEventListener("click", () => openModal(profileModal));
  }

  qsa(".modal-close").forEach((btn) => {
    btn.addEventListener("click", closeModals);
  });

  modalBackdrops.forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModals();
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModals();
  });
})();

