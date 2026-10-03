/**
 * AzollaSense - Main Application Logic & User Interaction
 */

document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const tabButtons = document.querySelectorAll(".nav-tab-btn");
  const tabPanels = document.querySelectorAll(".tab-panel");
  const presentationToggle = document.getElementById("toggle-view-mode");
  const deviceContainer = document.getElementById("device-container");
  const simToggleBtn = document.getElementById("toggle-sim-btn");
  const simulatorPanel = document.getElementById("simulator-panel");
  const simCloseBtn = document.getElementById("sim-close-btn");

  // Welcome Screen actions
  const welcomeCta = document.getElementById("welcome-cta");
  const brandLogoHome = document.getElementById("brand-logo-home");

  // CV Browning Detection overlay
  const cvOverlayLayer = document.getElementById("cv-overlay-layer");
  const fullscreenFeedBtn = document.getElementById("fullscreen-feed-btn");

  // Status Screen back button
  const statusBackBtn = document.getElementById("status-back-btn");

  // Settings elements
  const settingsSegments = document.querySelectorAll(
    ".settings-segmented-bar .segment-item",
  );
  const settingsGroups = document.querySelectorAll(".settings-subgroup");
  const notifToggle = document.getElementById("setting-notif-toggle");
  const notifStatusText = document.getElementById("notif-status-text");
  const saveSettingsBtn = document.getElementById("save-settings-btn");

  // Modals & Drawers
  const viewAllLogsBtn = document.getElementById("view-all-logs-btn");
  const statusLogsPill = document.getElementById("status-logs-pill");
  const logsModal = document.getElementById("logs-modal");
  const modalCloseBtns = document.querySelectorAll(".modal-close");
  const profileBtn = document.getElementById("profile-btn");
  const profileModal = document.getElementById("profile-modal");

  // 1. Navigation Tab Switching
  function switchTab(targetTabId) {
    // Hide all panels
    tabPanels.forEach((panel) => panel.classList.remove("active"));
    tabButtons.forEach((btn) => btn.classList.remove("active"));

    // Show target panel
    const activePanel = document.getElementById(`view-${targetTabId}`);
    if (activePanel) {
      activePanel.classList.add("active");
    }

    // Highlight nav button if applicable
    const activeBtn = document.querySelector(
      `.nav-tab-btn[data-tab="${targetTabId}"]`,
    );
    if (activeBtn) {
      activeBtn.classList.add("active");
    }

    // Scroll to top
    const scrollContainer = document.querySelector(".screen-scroll-container");
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
    }
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-tab");
      switchTab(target);
    });
  });

  // Welcome CTA dismisses the splash overlay
  const welcomeOverlay = document.getElementById("view-welcome");
  if (welcomeCta && welcomeOverlay) {
    welcomeCta.addEventListener("click", () => {
      welcomeOverlay.classList.add("hidden");
      // Remove from DOM after transition completes
      setTimeout(() => {
        welcomeOverlay.style.display = "none";
      }, 650);
    });
  }

  if (brandLogoHome) {
    brandLogoHome.addEventListener("click", (e) => {
      e.preventDefault();
      switchTab("dashboard");

      // Toggle IoT Simulator toolbar visibility
      const presentationBar = document.querySelector(".presentation-bar");
      if (presentationBar) {
        if (presentationBar.style.display === "flex") {
          presentationBar.style.display = "none";
        } else {
          presentationBar.style.display = "flex";
        }
      }
    });
  }

  if (statusBackBtn) {
    statusBackBtn.addEventListener("click", () => switchTab("dashboard"));
  }

  // 2. View Mode Toggle (Mobile Mockup vs Desktop Expanded)
  if (presentationToggle && deviceContainer) {
    presentationToggle.addEventListener("click", () => {
      const isDesktop = deviceContainer.classList.toggle("mode-desktop");
      if (isDesktop) {
        presentationToggle.innerHTML = `<span>📱</span> Mobile View`;
      } else {
        presentationToggle.innerHTML = `<span>🖥️</span> Expanded View`;
      }
    });
  }

  // 3. IoT Simulator Drawer Toggle
  if (simToggleBtn && simulatorPanel) {
    simToggleBtn.addEventListener("click", () => {
      simulatorPanel.classList.toggle("open");
      simToggleBtn.classList.toggle("active");
    });
  }

  if (simCloseBtn) {
    simCloseBtn.addEventListener("click", () => {
      simulatorPanel.classList.remove("open");
      simToggleBtn.classList.remove("active");
    });
  }

    // 4. Stream Play & AI Toggle Logic
  const startStreamBtn = document.getElementById('start-stream-btn');
  const livePiFeed = document.getElementById('live-pi-feed');
  const feedLiveBadge = document.getElementById('feed-live-badge');
  const cvToggleBtn = document.getElementById('toggle-cv-overlay'); // New Button

  if (startStreamBtn && livePiFeed) {
  startStreamBtn.addEventListener('click', () => {
    livePiFeed.src = "/video_feed";
    startStreamBtn.style.display = 'none';
    if (feedLiveBadge) feedLiveBadge.style.display = 'inline-flex';
    
    // Reveal the AI toggle button once stream starts
    if (cvToggleBtn) cvToggleBtn.style.display = 'inline-flex';
    
    showToast('Connecting to farm camera...');
  });
  }

  // Handle AI Toggle Clicks
  if (cvToggleBtn) {
  let aiVisionState = true;

  cvToggleBtn.addEventListener('click', () => {
    aiVisionState = !aiVisionState;
    
    // Send signal to Python backend
    socket.emit('toggle_ai_vision', { enabled: aiVisionState });
    
    // Update UI button colors
    if (aiVisionState) {
      cvToggleBtn.innerHTML = `AI Vision: ON`;
      cvToggleBtn.style.background = '#2e7d32';
      cvToggleBtn.style.color = '#ffffff';
    } else {
      cvToggleBtn.innerHTML = `AI Vision: OFF`;
      cvToggleBtn.style.background = 'rgba(255,255,255,0.9)';
      cvToggleBtn.style.color = 'var(--primary-dark)';
    }
  });
  }

  // 5. Fullscreen Feed Toggle
  if (fullscreenFeedBtn) {
    fullscreenFeedBtn.addEventListener("click", () => {
      // Find the closest wrapper to make fullscreen
      const wrapper = fullscreenFeedBtn.closest(".tank-image-wrapper");
      if (!wrapper) return;

      if (!document.fullscreenElement) {
        wrapper.requestFullscreen().catch((err) => {
          console.error(
            `Error attempting to enable fullscreen: ${err.message}`,
          );
        });
      } else {
        document.exitFullscreen();
      }
    });
  }

  // 5. Settings Screen Interactivity
  settingsSegments.forEach((segment) => {
    segment.addEventListener("click", () => {
      settingsSegments.forEach((s) => s.classList.remove("active"));
      segment.classList.add("active");

      const targetCategory = segment.getAttribute("data-category");
      settingsGroups.forEach((grp) => {
        if (grp.getAttribute("data-group") === targetCategory) {
          grp.style.display = "block";
        } else {
          grp.style.display = "none";
        }
      });
    });
  });

  if (notifToggle && notifStatusText) {
    notifToggle.addEventListener("change", (e) => {
      notifStatusText.textContent = e.target.checked ? "Enabled" : "Disabled";
      window.AzollaEngine.state.notifications = e.target.checked;
    });
  }

  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener("click", () => {
      showToast("✓ Settings updated successfully");
    });
  }

  // 6. Modals (Logs & Profile)
  function openModal(modal) {
    if (modal) modal.classList.add("open");
  }

  function closeModals() {
    document
      .querySelectorAll(".modal-backdrop")
      .forEach((m) => m.classList.remove("open"));
  }

  if (viewAllLogsBtn)
    viewAllLogsBtn.addEventListener("click", () => openModal(logsModal));
  if (statusLogsPill)
    statusLogsPill.addEventListener("click", () => openModal(logsModal));
  if (profileBtn)
    profileBtn.addEventListener("click", () => openModal(profileModal));

  modalCloseBtns.forEach((btn) => {
    btn.addEventListener("click", closeModals);
  });

  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModals();
    });
  });

  // ====================================================================
  // 7. LIVE RASPBERRY PI BACKEND CONNECTION (Socket.IO)
  // ====================================================================

  // Since the Flask server serves this web app, io() automatically connects
  // to the current host (works locally and through Cloudflare Tunnel).
  const socket = io();

  socket.on("connect", () => {
    console.log("Connected to Raspberry Pi 5 telemetry backend!");
    showToast("✓ Connected to Live AzollaSense Stream");
  });

  socket.on("disconnect", () => {
    showToast("⚠ Connection to farm unit lost");
  });

  // Listen for the live data payload from app_server.py
  socket.on("telemetry_update", (data) => {
    // 1. Update Water Level
    document.querySelectorAll(".val-water").forEach((el) => {
      el.textContent = `${data.water_level} cm`;
    });

    // 2. Update Temperature
    document.querySelectorAll(".val-temp").forEach((el) => {
      el.textContent = `${data.temperature}°C`;
    });

    // 3. Update pH Level
    document.querySelectorAll(".val-ph").forEach((el) => {
      el.textContent = `${data.ph}`;
    });

    // 4. Update Pond Surface Coverage (Total % detected by YOLO)
    document.querySelectorAll(".val-cov").forEach((el) => {
      el.textContent = `${data.total_cov}%`;
    });

    // 5. Update Browning Sector Warning text
    document.querySelectorAll(".val-browning-sectors").forEach((el) => {
      if (data.brown_cov > 5.0) {
        el.textContent = `Browning Detected: ${data.brown_cov}%`;
        el.style.color = "#e65100"; // Orange warning color
      } else {
        el.textContent = `Healthy (${data.brown_cov}% browning)`;
        el.style.color = "#2e7d32"; // Green healthy color
      }
    });

    // 6. Update global status badge logic
    const statusBadge = document.querySelector(".system-status-badge span");
    if (statusBadge) {
      if (data.temperature > 37.0 || data.ph < 6.0 || data.brown_cov > 10.0) {
        statusBadge.textContent = "System Alert: Action Required";
      } else {
        statusBadge.textContent = "System Status";
      }
    }
  });

  // Toast Helper
  function showToast(msg) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<span>🌿</span> ${msg}`;

    const container = document.getElementById("toast-container");
    if (container) {
      container.appendChild(toast);
      setTimeout(() => toast.remove(), 3500);
    }
  }

  window.showToast = showToast;
});
