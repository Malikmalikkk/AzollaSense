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
      const image = byId("browning-capture-image");
      if (image && capture.image) image.src = backendUrl(capture.image);
      const time = byId("browning-capture-time");
      if (time && capture.captured_at) {
        const date = new Date(capture.captured_at);
        time.textContent = `CAPTURED ${new Intl.DateTimeFormat("en-PH", {
          timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short"
        }).format(date)} PHT`;
      }
      const setText = (id, value) => { const el = byId(id); if (el) el.textContent = value; };
      const yoloUnavailable = capture.brown_cov == null || capture.green_cov == null;
      setText("capture-brown-coverage", yoloUnavailable ? "YOLO unavailable" : `${Number(capture.brown_cov).toFixed(2)}%`);
      setText("capture-green-coverage", yoloUnavailable ? "YOLO unavailable" : `${Number(capture.green_cov).toFixed(2)}%`);
      setText("capture-temperature", capture.temperature == null ? "—" : `${capture.temperature}°C`);
      setText("capture-water-level", capture.water_level == null ? "—" : `${capture.water_level} cm`);
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

  // Graceful fallback if Socket.IO is unavailable (offline PWA/static hosting).
  const socket = typeof io === "function" ? io(backendBase) : { emit() {}, on() {} };

  let streamRunning = false;
  let aiVisionOn = true;

  /* ------------------------------------------------------------------ */
  /* Toast notifications                                                */
  /* ------------------------------------------------------------------ */

  function showToast(message) {
    const container = byId("toast-container");
    if (!container) return;

    const existing = qs(".toast", container);
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<span aria-hidden="true">🌿</span> ${message}`;
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

  function resetVisionToggle() {
    aiVisionOn = true;
    if (!cvToggleBtn) return;
    cvToggleBtn.textContent = "AI Vision: ON";
    cvToggleBtn.classList.add("vision-on");
    cvToggleBtn.setAttribute("aria-pressed", "true");
  }

  function stopCameraStream(notify = true) {
    if (!streamRunning) return;

    // Ask the backend to release the USB camera.
    // keepalive lets the request survive page navigation.
    fetch(backendUrl("/stop_stream"), { method: "POST", keepalive: true })
      .then((response) => response.json())
      .catch(() => { /* camera already released or server offline */ });

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
    // sendBeacon survives page unload where fetch() may be cancelled
    navigator.sendBeacon(backendUrl("/stop_stream"), new Blob([], { type: "application/json" }));
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

  socket.on("telemetry_update", (data) => {
    const setValues = (selector, text) => qsa(selector).forEach((el) => { el.textContent = text; });

    if (data.water_level !== undefined) setValues(".val-water", `${data.water_level} cm`);
    if (data.temperature !== undefined) setValues(".val-temp", `${data.temperature}°C`);
    if (data.ph !== undefined) setValues(".val-ph", `${data.ph}`);
    if (data.total_cov !== undefined) setValues(".val-cov", `${data.total_cov}%`);

    qsa(".val-browning-sectors").forEach((el) => {
      const brownPct = Number(data.brown_cov) || 0;
      if (brownPct > 5.0) {
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
        temp > 37.0 || ph < 6.0 || brownPct > 10.0
          ? "System Alert: Action Required"
          : "System Status";
    }

  });


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
    });
  });

  const notifToggle = byId("setting-notif-toggle");
  const notifStatusText = byId("notif-status-text");
  if (notifToggle && notifStatusText) {
    notifToggle.addEventListener("change", () => {
      notifStatusText.textContent = notifToggle.checked ? "Enabled" : "Disabled";
    });
  }

  // Static info cards that simply acknowledge via toast
  qsa("[data-toast]").forEach((el) => {
    el.addEventListener("click", () => showToast(el.dataset.toast));
  });

  const saveSettingsBtn = byId("save-settings-btn");
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener("click", () => showToast("✓ Settings updated successfully"));
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

  const viewAllLogsBtn = byId("view-all-logs-btn");
  if (viewAllLogsBtn) {
    viewAllLogsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      openModal(logsModal);
    });
  }

  const statusLogsPill = byId("status-logs-pill");
  if (statusLogsPill) {
    statusLogsPill.addEventListener("click", () => openModal(logsModal));
  }

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

