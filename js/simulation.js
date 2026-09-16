/**
 * AzollaSense - IoT Telemetry & Hardware Simulation Engine
 * Handles live sensor stream, micro-fluctuations, anomaly triggers, and real-time state.
 */

class AzollaSimulator {
  constructor() {
    this.state = {
      waterLevel: 26,     // cm
      temperature: 36,    // °C
      phLevel: 7.2,       // pH
      pondCoverage: 75,   // %
      browningSectors: 2, // count
      pumpStatus: 'Active (Level Low)',
      canopyStatus: 'Deployed',
      cloudSync: true,
      notifications: true,
      updateInterval: 10, // minutes
      language: 'English',
      timeFormat: '12-Hour'
    };

    this.subscribers = [];
    this.isAutoDrift = true;
    this.timer = null;

    this.init();
  }

  init() {
    // Start natural environmental sensor micro-drift
    this.timer = setInterval(() => {
      if (this.isAutoDrift) {
        this.microFluctuate();
      }
    }, 4000);
  }

  subscribe(callback) {
    this.subscribers.push(callback);
    callback(this.state);
  }

  notify() {
    this.subscribers.forEach(cb => cb(this.state));
  }

  microFluctuate() {
    // Micro-variations within realistic bounds
    const tempDelta = (Math.random() * 0.4 - 0.2);
    const phDelta = (Math.random() * 0.04 - 0.02);
    
    this.state.temperature = parseFloat((this.state.temperature + tempDelta).toFixed(1));
    this.state.phLevel = parseFloat((this.state.phLevel + phDelta).toFixed(1));

    this.notify();
  }

  setWaterLevel(val) {
    this.state.waterLevel = parseInt(val, 10);
    this.notify();
  }

  setTemperature(val) {
    this.state.temperature = parseFloat(parseFloat(val).toFixed(1));
    this.notify();
  }

  setPhLevel(val) {
    this.state.phLevel = parseFloat(parseFloat(val).toFixed(1));
    this.notify();
  }

  setCoverage(val) {
    this.state.pondCoverage = parseInt(val, 10);
    this.notify();
  }

  setBrowningSectors(val) {
    this.state.browningSectors = parseInt(val, 10);
    this.notify();
  }

  // Pre-configured Environmental Presets
  applyPreset(type) {
    switch (type) {
      case 'optimal':
        this.state.waterLevel = 28;
        this.state.temperature = 24.5;
        this.state.phLevel = 6.9;
        this.state.pondCoverage = 85;
        this.state.browningSectors = 0;
        this.state.pumpStatus = 'Standby';
        this.state.canopyStatus = 'Retracted';
        break;

      case 'heatwave':
        this.state.waterLevel = 21;
        this.state.temperature = 38.2;
        this.state.phLevel = 7.6;
        this.state.pondCoverage = 68;
        this.state.browningSectors = 3;
        this.state.pumpStatus = 'Cooling Active';
        this.state.canopyStatus = 'Deployed (Sunlight Protection)';
        break;

      case 'acidic':
        this.state.waterLevel = 25;
        this.state.temperature = 31.0;
        this.state.phLevel = 5.4;
        this.state.pondCoverage = 72;
        this.state.browningSectors = 2;
        this.state.pumpStatus = 'Buffer Dosing Active';
        this.state.canopyStatus = 'Deployed';
        break;

      case 'mockup':
      default:
        this.state.waterLevel = 26;
        this.state.temperature = 36.0;
        this.state.phLevel = 7.2;
        this.state.pondCoverage = 75;
        this.state.browningSectors = 2;
        this.state.pumpStatus = 'Active (Water Level Low)';
        this.state.canopyStatus = 'Deployed (Sunlight Duration Met)';
        break;
    }
    this.notify();
  }
}

// Global singleton instance
window.AzollaEngine = new AzollaSimulator();
