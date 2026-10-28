/**
 * AzollaSense — Main Application Logic
 *
 * Dashboard telemetry, live camera stream control, AI vision toggle,
 * tab navigation, settings and modal dialogs.
 * Telemetry and actuator state are polled from the local Flask backend.
 */
(() => {
  "use strict";

  // A restored installed-app page can execute cached scripts again. Keep one
  // dashboard instance so it owns a single socket connection and event set.
  if (window.__azollaSenseDashboardStarted) return;
  window.__azollaSenseDashboardStarted = true;

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
  const notificationSound = new Audio("./assets/notification_sound.mp3");
  notificationSound.preload = "auto";

  function playNotificationSound() {
    // A browser may block audio until the user has interacted with the page.
    // Ignore that restriction here so alert rendering is never interrupted.
    notificationSound.pause();
    notificationSound.currentTime = 0;
    notificationSound.play().catch(() => {});
  }

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
  window.setInterval(() => {
    if (!document.hidden) loadLatestBrowningCapture();
  }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadLatestBrowningCapture();
  });

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

  // Use the compatible Socket.IO v4 client to receive backend events; REST
  // polling and command fallbacks remain available if the client cannot load.
  const dashboardHandlers = {};
  const liveSocket = typeof window.io === "function"
    ? window.io({ transports: ["polling"], upgrade: false, reconnection: true })
    : null;
  const dashboardEvents = {
    on(event, callback) {
      dashboardHandlers[event] = callback;
      liveSocket?.on(event, callback);
    },
    emit(event, data, acknowledge) {
      if (liveSocket?.connected) {
        liveSocket.emit(event, data, acknowledge);
        return;
      }
      const endpoints = { set_actuator: "/api/actuator", toggle_ai_vision: "/api/vision" };
      const endpoint = endpoints[event];
      if (!endpoint) {
        acknowledge?.({ success: false, error: "Unsupported dashboard command." });
        return;
      }
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
  const feedLoading = byId("feed-loading");
  const visionToggleLoader = cvToggleBtn?.querySelector(".vision-toggle-loader");
  const visionToggleLabel = byId("vision-toggle-label");
  const feedWrapper = liveFeed?.closest(".tank-image-wrapper");
  let streamStartedAt = 0;
  let streamLoading = false;

  function saveLastFeedFrame() {
    if (!liveFeed || !feedWrapper || !liveFeed.naturalWidth || !liveFeed.naturalHeight) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = liveFeed.naturalWidth;
      canvas.height = liveFeed.naturalHeight;
      canvas.getContext("2d").drawImage(liveFeed, 0, 0);
      feedWrapper.style.setProperty("--stopped-feed-frame", `url("${canvas.toDataURL("image/jpeg", 0.82)}")`);
      feedWrapper.classList.add("has-stopped-frame");
    } catch (error) {
      console.warn("Could not save the last camera frame.", error);
    }
  }

  function setStreamUI(running) {
    streamRunning = running;
    if (startBtn) startBtn.classList.toggle("is-hidden", running);
    if (stopBtn) stopBtn.classList.toggle("is-hidden", !running);
    if (liveBadge) liveBadge.classList.toggle("is-hidden", !running);
    if (cvToggleBtn) cvToggleBtn.classList.toggle("is-hidden", !running);
    if (!running) streamLoading = false;
    if (feedLoading) feedLoading.classList.toggle("is-hidden", !streamLoading);
    if (feedWrapper) {
      feedWrapper.classList.toggle("is-stream-stopped", !running);
      if (running) {
        feedWrapper.classList.remove("has-stopped-frame");
        feedWrapper.style.removeProperty("--stopped-feed-frame");
      }
    }
  }

  let lastSessionActivitySent = 0;
  function sendSessionActivity() {
    const now = Date.now();
    if (now - lastSessionActivitySent < 15000) return;
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
    if (!aiVisionOn) dashboardEvents.emit("toggle_ai_vision", { enabled: true });
    setVisionUI(true);
  }

  function setVisionUI(enabled) {
    aiVisionOn = enabled;
    if (!cvToggleBtn) return;
    if (visionToggleLabel) visionToggleLabel.textContent = `AI Vision: ${enabled ? "ON" : "OFF"}`;
    else cvToggleBtn.textContent = `AI Vision: ${enabled ? "ON" : "OFF"}`;
    cvToggleBtn.classList.toggle("vision-on", enabled);
    cvToggleBtn.setAttribute("aria-pressed", String(enabled));
  }

  function stopCameraStream() {
    if (!streamRunning) return;

    saveLastFeedFrame();
    if (liveFeed) liveFeed.removeAttribute("src");

    resetVisionToggle();
    setStreamUI(false);

    showToast("Camera stream stopped.");
  }

  if (startBtn && liveFeed) {
    startBtn.addEventListener("click", () => {
      // Cache-bust so the browser always opens a fresh MJPEG session
      streamStartedAt = Date.now();
      streamLoading = true;
      liveFeed.src = backendUrl(`/video_feed?stream=${Date.now()}`);
      setStreamUI(true);
      showToast("Connecting to farm camera…");
    });
  }

  if (liveFeed) {
    liveFeed.addEventListener("load", () => {
      if (!streamRunning) return;
      streamLoading = false;
      if (feedLoading) feedLoading.classList.add("is-hidden");
    });
    liveFeed.addEventListener("error", () => {
      if (!streamRunning) return;
      resetVisionToggle();
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
      if (cvToggleBtn.disabled) return;
      const enabled = !aiVisionOn;
      cvToggleBtn.disabled = true;
      cvToggleBtn.classList.add("is-loading");
      if (visionToggleLoader) visionToggleLoader.classList.remove("is-hidden");
      dashboardEvents.emit("toggle_ai_vision", { enabled }, (reply) => {
        if (reply?.success) setVisionUI(enabled);
        else showToast(reply?.error || "Could not update AI vision.");
        cvToggleBtn.disabled = false;
        cvToggleBtn.classList.remove("is-loading");
        if (visionToggleLoader) visionToggleLoader.classList.add("is-hidden");
      });
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
  /* Backend connection state & live telemetry                           */
  /* ------------------------------------------------------------------ */

  let connectionToastShown = false;
  dashboardEvents.on("connect", () => {
    localStateConnected = true;
    if (!connectionToastShown) {
      connectionToastShown = true;
      showToast("Connected to the AzollaSense server.");
    }
    loadLatestBrowningCapture();
  });

  dashboardEvents.on("disconnect", () => {
    localStateConnected = false;
    showToast("Connection to the AzollaSense server was lost.");
  });

  let alertCursor = 0;
  const alertListenStartedAt = Date.now() / 1000;
  const recentNotifications = byId("recent-notifications");
  const recentAlertItems = new Map();

  function addRecentNotification(alert) {
    if (!recentNotifications || !alert || typeof alert.body !== "string") return false;
    const id = alert.id ?? `${alert.created_at}-${alert.title}`;
    if (recentAlertItems.has(id)) return false;
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
    while (recentAlertItems.size > 100) {
      const oldestId = recentAlertItems.keys().next().value;
      recentAlertItems.get(oldestId)?.remove();
      recentAlertItems.delete(oldestId);
    }
    return true;
  }

  function displaySystemAlert(alert) {
    const isNewAlert = addRecentNotification(alert);
    if (isNewAlert && alert && typeof alert.body === "string") {
      playNotificationSound();
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

  dashboardEvents.on("telemetry_update", (data) => {
    const setValues = (selector, text) => qsa(selector).forEach((el) => { el.textContent = text; });

    if (data.sensor_updated_at !== undefined) {
      const updatedAt = data.sensor_updated_at ? new Date(data.sensor_updated_at) : null;
      if (updatedAt && !Number.isNaN(updatedAt.getTime())) {
        const formatted = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(updatedAt);
        qsa(".last-sensor-update").forEach((el) => {
          el.textContent = formatted;
          el.dateTime = updatedAt.toISOString();
        });
      } else {
        qsa(".last-sensor-update").forEach((el) => {
          el.textContent = "Waiting for sensor data";
          el.removeAttribute("datetime");
        });
      }
    }

    if (data.water_level !== undefined) setValues(".val-water", data.water_level == null ? "— cm" : `${Number(data.water_level).toFixed(1)} cm`);
    if (data.temperature !== undefined) setValues(".val-temp", data.temperature == null ? "—°C" : `${Number(data.temperature).toFixed(1)}°C`);
    if (data.ph !== undefined) setValues(".val-ph", data.ph == null ? "—" : Number(data.ph).toFixed(2));
    if (data.ph_voltage !== undefined) {
      setValues(".val-ph-voltage", data.ph_voltage == null ? "— V" : `${Number(data.ph_voltage).toFixed(3)} V`);
    }
    updateRainSensorDisplay(data);
    if (data.lux !== undefined) {
      const meter = qs(".light-meter-track");
      const meterFill = qs(".light-meter-fill");
      const lightStatus = qs(".light-intensity-status");
      const lux = Number(data.lux);
      if (data.lux == null || !Number.isFinite(lux)) {
        setValues(".val-lux", "— lx");
        if (meter) meter.setAttribute("aria-valuenow", "0");
        if (meterFill) meterFill.style.width = "0%";
        if (lightStatus) lightStatus.textContent = "Waiting for sensor data";
      } else {
        const safeLux = Math.max(0, lux);
        setValues(".val-lux", `${Math.round(safeLux).toLocaleString()} lx`);
        if (meter) meter.setAttribute("aria-valuenow", String(Math.min(Math.round(safeLux), 60000)));
        if (meterFill) meterFill.style.width = `${Math.min(safeLux / 60000 * 100, 100)}%`;
        if (lightStatus) {
          lightStatus.textContent = safeLux >= (sensorSettings.canopy_deploy_lux ?? 45000)
            ? "Canopy deploy threshold reached"
            : "Below canopy deploy threshold";
        }
      }
    }
    if (data.total_cov !== undefined) setValues(".val-cov", data.total_cov == null ? "—" : `${Number(data.total_cov).toFixed(2)}%`);

    const badgeText = qs(".system-status-badge span");
    if (badgeText) {
      const temp = Number(data.temperature);
      const ph = Number(data.ph);
      const brownPct = Number(data.brown_cov);
      const water = Number(data.water_level);
      const lux = Number(data.lux);
      const hasAlert =
        (data.temperature != null && temp > (sensorSettings.temperature_max_c ?? 34)) ||
        (data.ph != null && (ph < (sensorSettings.ph_min ?? 6.5) || ph > (sensorSettings.ph_max ?? 7.5))) ||
        (data.brown_cov != null && brownPct >= (sensorSettings.browning_alert_pct ?? 10)) ||
        (data.water_level != null && (water < (sensorSettings.water_min_cm ?? 20) || water > (sensorSettings.water_max_cm ?? 30))) ||
        (data.lux != null && lux >= (sensorSettings.canopy_deploy_lux ?? 45000)) ||
        data.rain_protection_active === true;
      const hasReading = [data.temperature, data.ph, data.brown_cov, data.water_level, data.lux, data.rain_detected].some((value) => value != null);
      badgeText.textContent = hasAlert
        ? "System Alert: Action Required"
        : hasReading ? "System Status: Normal" : "Waiting for sensor data";
      const badge = badgeText.closest(".system-status-badge");
      badge?.classList.toggle("is-alert", hasAlert);
      badge?.classList.toggle("is-normal", !hasAlert && hasReading);
    }

  });

  const actuatorInputs = {
    motor: byId("motor-switch"),
    solenoid: byId("solenoid-switch"),
    pump: byId("pump-switch"),
    ph_auto: byId("ph-auto-switch"),
    canopy_auto: byId("canopy-auto-switch")
  };
  function setSwitchPending(input, pending) {
    const control = input.closest(".switch-control");
    if (control) {
      control.classList.toggle("is-pending", pending);
      control.setAttribute("aria-busy", String(pending));
    }
    input.disabled = pending;
  }
  Object.entries(actuatorInputs).forEach(([name, input]) => {
    if (!input) return;
    input.addEventListener("change", () => {
      setSwitchPending(input, true);
      dashboardEvents.emit("set_actuator", { name, enabled: input.checked }, (reply) => {
        setSwitchPending(input, false);
        if (!reply || !reply.success) {
          input.checked = !input.checked;
          showToast(reply?.error || "Could not send command to the ESP32.");
        }
      });
    });
  });

  dashboardEvents.on("actuator_update", (data) => {
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

  dashboardEvents.on("sensor_settings", applySensorSettings);
  dashboardEvents.on("vision_state", (data) => {
    if (typeof data?.enabled === "boolean") setVisionUI(data.enabled);
  });
  dashboardEvents.on("system_alert", displaySystemAlert);
  dashboardEvents.on("browning_capture_updated", loadLatestBrowningCapture);

  let localStateConnected = false;
  let stopStatePolling = false;
  async function refreshLocalState() {
    try {
      const query = alertCursor === 0
        ? "?alerts_recent=100"
        : `?alerts_after=${encodeURIComponent(alertCursor)}&alerts_since=${encodeURIComponent(alertListenStartedAt)}`;
      const response = await fetch(backendUrl(`/api/state${query}`), { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401) {
        stopStatePolling = true;
        location.replace("/login");
        return;
      }
      if (!response.ok) throw new Error("Local server unavailable");
      const data = await response.json();
      (data.alerts || []).forEach((alert) => {
        if (alertCursor === 0) addRecentNotification(alert);
        else displaySystemAlert(alert);
      });
      alertCursor = data.alert_cursor ?? alertCursor;
      if (!liveSocket?.connected) {
        dashboardHandlers.telemetry_update?.(data.telemetry);
        dashboardHandlers.actuator_update?.(data.actuators);
        dashboardHandlers.sensor_settings?.(data.settings);
        if (typeof data.ai_vision_enabled === "boolean") setVisionUI(data.ai_vision_enabled);
      }
      if (streamRunning && data.streaming === false && Date.now() - streamStartedAt > 5000) {
        saveLastFeedFrame();
        liveFeed?.removeAttribute("src");
        resetVisionToggle();
        setStreamUI(false);
        showToast(data.capture_in_progress
          ? "Live stream stopped so the camera can capture an image."
          : "The camera stream ended.");
      }
      if (!localStateConnected && !liveSocket?.connected) {
        localStateConnected = true;
        dashboardHandlers.connect?.();
      }
    } catch (_) {
      if (localStateConnected) {
        localStateConnected = false;
        dashboardHandlers.disconnect?.();
      }
    } finally {
      if (!stopStatePolling) window.setTimeout(refreshLocalState, liveSocket?.connected ? 15000 : 1500);
    }
  }
  refreshLocalState();

  const farmNameDisplay = byId("profile-farm-name");
  const farmNameForm = byId("farm-name-form");
  const farmNameInput = byId("farm-name-input");
  async function loadFarmProfile() {
    try {
      const response = await fetch(backendUrl("/api/farm-profile"), { cache: "no-store", credentials: "same-origin" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load the farm name.");
      if (farmNameDisplay) farmNameDisplay.textContent = result.farm_name;
      if (farmNameInput) farmNameInput.value = result.farm_name;
    } catch (error) {
      console.warn(error.message || "Could not load the farm name.");
    }
  }

  if (farmNameForm) farmNameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = byId("farm-name-message");
    const saveButton = byId("farm-name-save");
    const value = farmNameInput?.value.trim() || "";
    message.textContent = "Saving…";
    message.classList.remove("is-error");
    if (saveButton) saveButton.disabled = true;
    try {
      const response = await fetch(backendUrl("/api/farm-profile"), {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ farm_name: value })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save the farm name.");
      if (farmNameDisplay) farmNameDisplay.textContent = result.farm_name;
      if (farmNameInput) farmNameInput.value = result.farm_name;
      message.textContent = "Farm name saved.";
    } catch (error) {
      message.textContent = error.message || "Could not reach the local server.";
      message.classList.add("is-error");
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  });

  const logoutButton = byId("logout-btn");
  let currentAccountId = null;
  fetch(backendUrl("/api/auth/status"), { cache: "no-store", credentials: "same-origin" })
    .then((response) => response.ok ? response.json() : Promise.reject(new Error("Not signed in")))
    .then(async (account) => {
      currentAccountId = account.user_id;
      const isAdmin = account.role === "admin";
      document.body.classList.remove("role-pending");
      document.body.classList.toggle("role-admin", isAdmin);
      document.body.classList.toggle("role-user", !isAdmin);
      await loadFarmProfile();
      const name = byId("profile-username");
      const profile = byId("profile-btn");
      if (name && account.username) name.textContent = account.username;
      if (profile && account.username) profile.title = `Signed in as ${account.username}`;
      if (isAdmin) {
        if (farmNameForm) farmNameForm.classList.remove("is-hidden");
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
      showToast(`Requesting ${label} reboot…`);
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
        body: JSON.stringify({ username: formData.get("username"), password: formData.get("password"), role: formData.get("role") })
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

  let managedUsersSnapshot = "";
  async function loadManagedUsers() {
    const list = byId("managed-user-list");
    if (!list) return;
    try {
      const response = await fetch(backendUrl("/api/auth/users"), { cache: "no-store", credentials: "same-origin" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load accounts.");
      const snapshot = JSON.stringify(result.users || []);
      if (snapshot === managedUsersSnapshot) return;
      managedUsersSnapshot = snapshot;
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
        status.className = `account-status is-${user.session_status}`;
        status.textContent = user.session_status === "active" ? "Active now" : user.session_status === "idle" ? "Idle · can be used on another device" : "Signed out";
        details.append(username, status, created);
        row.append(details);
        if (user.session_status !== "signed_out") {
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
        const role = document.createElement("span");
        role.className = `account-role-label is-${user.role}`;
        role.textContent = user.role === "admin" ? "Admin" : "User";
        row.append(role);
        if (user.id !== currentAccountId) {
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
      managedUsersSnapshot = "";
      list.textContent = error.message || "Could not load accounts.";
    }
  }

  window.setInterval(() => {
    const accountPanel = byId("account-management-panel");
    if (accountPanel && !accountPanel.classList.contains("is-hidden")) loadManagedUsers();
  }, 2000);


  /* ------------------------------------------------------------------ */
  /* Settings screen                                                    */
  /* ------------------------------------------------------------------ */

  const settingSegments = qsa(".settings-segmented-bar .segment-item");
  const settingGroups = qsa(".settings-subgroup");
  const settingsBar = qs("#view-settings .settings-segmented-bar");
  const screenScroller = qs(".screen-scroll-container");
  if (settingsBar && screenScroller) {
    let dockCheckPending = false;
    const updateSettingsBarDock = () => {
      dockCheckPending = false;
      if (!settingsBar.closest("#view-settings").classList.contains("active")) {
        settingsBar.classList.remove("is-docked");
        return;
      }
      const stickyOffset = Number.parseFloat(window.getComputedStyle(settingsBar).top) || 0;
      const scrollTop = screenScroller.getBoundingClientRect().top + stickyOffset;
      const isDocked = settingsBar.getBoundingClientRect().top <= scrollTop + 1;
      settingsBar.classList.toggle("is-docked", isDocked);
    };
    screenScroller.addEventListener("scroll", () => {
      if (dockCheckPending) return;
      dockCheckPending = true;
      window.requestAnimationFrame(updateSettingsBarDock);
    }, { passive: true });
    window.addEventListener("resize", updateSettingsBarDock);
    updateSettingsBarDock();
  }

  settingSegments.forEach((segment) => {
    segment.addEventListener("click", () => {
      settingSegments.forEach((s) => s.classList.toggle("active", s === segment));
      const category = segment.dataset.category;
      settingGroups.forEach((group) => {
        group.classList.toggle("is-hidden", group.dataset.group !== category);
      });
      const saveButton = byId("save-settings-btn");
      if (saveButton) saveButton.classList.toggle("is-hidden", category === "accounts");
      if (category === "accounts") loadManagedUsers();
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
        let status = await getPushSubscriptionStatus(subscription);
        if (subscription && status.available && "Notification" in window && Notification.permission === "granted" && !status.subscribed) {
          const bindResponse = await fetch(backendUrl("/api/push/subscription"), {
            method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(subscription.toJSON())
          });
          if (bindResponse.ok) status = await getPushSubscriptionStatus(subscription);
        }
        notifToggle.checked = Boolean(subscription && status.subscribed);
        notifStatusText.textContent = notifToggle.checked ? "Enabled" : "Disabled";
        if (!status.available && !notifToggle.checked) notifStatusText.title = "Server push settings are not configured.";
      } catch (error) { console.warn("Could not load notification preference:", error); }
    });
    notifToggle.addEventListener("change", async () => {
      const enabling = notifToggle.checked;
      setSwitchPending(notifToggle, true);
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
      } finally { setSwitchPending(notifToggle, false); }
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

