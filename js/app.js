/**
 * AzollaSense - Main Application Logic & User Interaction
 */

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const tabButtons = document.querySelectorAll('.nav-tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');
  const presentationToggle = document.getElementById('toggle-view-mode');
  const deviceContainer = document.getElementById('device-container');
  const simToggleBtn = document.getElementById('toggle-sim-btn');
  const simulatorPanel = document.getElementById('simulator-panel');
  const simCloseBtn = document.getElementById('sim-close-btn');

  // Welcome Screen actions
  const welcomeCta = document.getElementById('welcome-cta');
  const brandLogoHome = document.getElementById('brand-logo-home');

  // CV Browning Detection overlay
  const cvToggleBtn = document.getElementById('toggle-cv-overlay');
  const cvOverlayLayer = document.getElementById('cv-overlay-layer');

  // Status Screen back button
  const statusBackBtn = document.getElementById('status-back-btn');

  // Settings elements
  const settingsSegments = document.querySelectorAll('.settings-segmented-bar .segment-item');
  const settingsGroups = document.querySelectorAll('.settings-subgroup');
  const notifToggle = document.getElementById('setting-notif-toggle');
  const notifStatusText = document.getElementById('notif-status-text');
  const saveSettingsBtn = document.getElementById('save-settings-btn');

  // Modals & Drawers
  const viewAllLogsBtn = document.getElementById('view-all-logs-btn');
  const statusLogsPill = document.getElementById('status-logs-pill');
  const logsModal = document.getElementById('logs-modal');
  const modalCloseBtns = document.querySelectorAll('.modal-close');
  const profileBtn = document.getElementById('profile-btn');
  const profileModal = document.getElementById('profile-modal');

  // 1. Navigation Tab Switching
  function switchTab(targetTabId) {
    // Hide all panels
    tabPanels.forEach(panel => panel.classList.remove('active'));
    tabButtons.forEach(btn => btn.classList.remove('active'));

    // Show target panel
    const activePanel = document.getElementById(`view-${targetTabId}`);
    if (activePanel) {
      activePanel.classList.add('active');
    }

    // Highlight nav button if applicable
    const activeBtn = document.querySelector(`.nav-tab-btn[data-tab="${targetTabId}"]`);
    if (activeBtn) {
      activeBtn.classList.add('active');
    }

    // Scroll to top
    const scrollContainer = document.querySelector('.screen-scroll-container');
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
    }
  }

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      switchTab(target);
    });
  });

  // Welcome CTA dismisses the splash overlay
  const welcomeOverlay = document.getElementById('view-welcome');
  if (welcomeCta && welcomeOverlay) {
    welcomeCta.addEventListener('click', () => {
      welcomeOverlay.classList.add('hidden');
      // Remove from DOM after transition completes
      setTimeout(() => {
        welcomeOverlay.style.display = 'none';
      }, 650);
    });
  }

  if (brandLogoHome) {
    brandLogoHome.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab('dashboard');
      
      // Toggle IoT Simulator toolbar visibility
      const presentationBar = document.querySelector('.presentation-bar');
      if (presentationBar) {
        if (presentationBar.style.display === 'flex') {
          presentationBar.style.display = 'none';
        } else {
          presentationBar.style.display = 'flex';
        }
      }
    });
  }

  if (statusBackBtn) {
    statusBackBtn.addEventListener('click', () => switchTab('dashboard'));
  }

  // 2. View Mode Toggle (Mobile Mockup vs Desktop Expanded)
  if (presentationToggle && deviceContainer) {
    presentationToggle.addEventListener('click', () => {
      const isDesktop = deviceContainer.classList.toggle('mode-desktop');
      if (isDesktop) {
        presentationToggle.innerHTML = `<span>📱</span> Mobile View`;
      } else {
        presentationToggle.innerHTML = `<span>🖥️</span> Expanded View`;
      }
    });
  }

  // 3. IoT Simulator Drawer Toggle
  if (simToggleBtn && simulatorPanel) {
    simToggleBtn.addEventListener('click', () => {
      simulatorPanel.classList.toggle('open');
      simToggleBtn.classList.toggle('active');
    });
  }

  if (simCloseBtn) {
    simCloseBtn.addEventListener('click', () => {
      simulatorPanel.classList.remove('open');
      simToggleBtn.classList.remove('active');
    });
  }

  // 4. Computer Vision Overlay Toggle
  if (cvToggleBtn && cvOverlayLayer) {
    cvToggleBtn.addEventListener('click', () => {
      const isActive = cvOverlayLayer.classList.toggle('active');
      if (isActive) {
        cvToggleBtn.innerHTML = `<span>👁️</span> AI Vision: ON`;
        cvToggleBtn.style.background = '#2e7d32';
        cvToggleBtn.style.color = '#ffffff';
      } else {
        cvToggleBtn.innerHTML = `<span>👁️</span> AI Vision`;
        cvToggleBtn.style.background = 'rgba(255,255,255,0.9)';
        cvToggleBtn.style.color = 'var(--primary-dark)';
      }
    });
  }

  // 5. Settings Screen Interactivity
  settingsSegments.forEach(segment => {
    segment.addEventListener('click', () => {
      settingsSegments.forEach(s => s.classList.remove('active'));
      segment.classList.add('active');

      const targetCategory = segment.getAttribute('data-category');
      settingsGroups.forEach(grp => {
        if (grp.getAttribute('data-group') === targetCategory) {
          grp.style.display = 'block';
        } else {
          grp.style.display = 'none';
        }
      });
    });
  });

  if (notifToggle && notifStatusText) {
    notifToggle.addEventListener('change', (e) => {
      notifStatusText.textContent = e.target.checked ? 'Enabled' : 'Disabled';
      window.AzollaEngine.state.notifications = e.target.checked;
    });
  }

  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', () => {
      showToast('✓ Settings updated successfully');
    });
  }

  // 6. Modals (Logs & Profile)
  function openModal(modal) {
    if (modal) modal.classList.add('open');
  }

  function closeModals() {
    document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('open'));
  }

  if (viewAllLogsBtn) viewAllLogsBtn.addEventListener('click', () => openModal(logsModal));
  if (statusLogsPill) statusLogsPill.addEventListener('click', () => openModal(logsModal));
  if (profileBtn) profileBtn.addEventListener('click', () => openModal(profileModal));

  modalCloseBtns.forEach(btn => {
    btn.addEventListener('click', closeModals);
  });

  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModals();
    });
  });

  // 7. Connect Simulator Sliders & Presets to UI
  const simWater = document.getElementById('sim-water');
  const simTemp = document.getElementById('sim-temp');
  const simPh = document.getElementById('sim-ph');
  const simCov = document.getElementById('sim-cov');

  if (simWater) {
    simWater.addEventListener('input', (e) => {
      document.getElementById('sim-water-val').textContent = `${e.target.value} cm`;
      window.AzollaEngine.setWaterLevel(e.target.value);
    });
  }

  if (simTemp) {
    simTemp.addEventListener('input', (e) => {
      document.getElementById('sim-temp-val').textContent = `${e.target.value}°C`;
      window.AzollaEngine.setTemperature(e.target.value);
    });
  }

  if (simPh) {
    simPh.addEventListener('input', (e) => {
      document.getElementById('sim-ph-val').textContent = e.target.value;
      window.AzollaEngine.setPhLevel(e.target.value);
    });
  }

  if (simCov) {
    simCov.addEventListener('input', (e) => {
      document.getElementById('sim-cov-val').textContent = `${e.target.value}%`;
      window.AzollaEngine.setCoverage(e.target.value);
    });
  }

  // Presets
  document.querySelectorAll('.sim-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.getAttribute('data-preset');
      window.AzollaEngine.applyPreset(preset);
      showToast(`Preset: ${preset.toUpperCase()} activated`);
    });
  });

  // 8. State Listener to Update All View Elements
  window.AzollaEngine.subscribe((state) => {
    // Water level
    document.querySelectorAll('.val-water').forEach(el => el.textContent = `${state.waterLevel} cm`);
    if (simWater) {
      simWater.value = state.waterLevel;
      const lbl = document.getElementById('sim-water-val');
      if (lbl) lbl.textContent = `${state.waterLevel} cm`;
    }

    // Temperature
    document.querySelectorAll('.val-temp').forEach(el => el.textContent = `${state.temperature}°C`);
    if (simTemp) {
      simTemp.value = state.temperature;
      const lbl = document.getElementById('sim-temp-val');
      if (lbl) lbl.textContent = `${state.temperature}°C`;
    }

    // pH Level
    document.querySelectorAll('.val-ph').forEach(el => el.textContent = `${state.phLevel}`);
    if (simPh) {
      simPh.value = state.phLevel;
      const lbl = document.getElementById('sim-ph-val');
      if (lbl) lbl.textContent = `${state.phLevel}`;
    }

    // Pond Coverage
    document.querySelectorAll('.val-cov').forEach(el => el.textContent = `${state.pondCoverage}%`);
    if (simCov) {
      simCov.value = state.pondCoverage;
      const lbl = document.getElementById('sim-cov-val');
      if (lbl) lbl.textContent = `${state.pondCoverage}%`;
    }

    // Browning sectors
    document.querySelectorAll('.val-browning-sectors').forEach(el => {
      el.textContent = `${state.browningSectors} Sectors Affected`;
    });

    // Update status badge if anomaly
    const statusBadge = document.querySelector('.system-status-badge span');
    if (statusBadge) {
      if (state.temperature > 37 || state.phLevel < 6.0 || state.browningSectors >= 3) {
        statusBadge.textContent = 'System Alert: Heat Stress';
      } else {
        statusBadge.textContent = 'System Status';
      }
    }
  });

  // Toast Helper
  function showToast(msg) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span>🌿</span> ${msg}`;

    const container = document.getElementById('toast-container');
    if (container) {
      container.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }
  }

  window.showToast = showToast;
});
