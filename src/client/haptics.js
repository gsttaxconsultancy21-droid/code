// Vibration feedback. The Android wrapper exposes a native bridge because
// WebView ignores navigator.vibrate; browsers use the Vibration API.
export const haptics = {
  enabled: true,

  buzz(pattern) {
    if (!this.enabled) return;
    try {
      const bridge = window.InklandNative;
      if (bridge && bridge.vibrate) bridge.vibrate(Array.isArray(pattern) ? pattern.join(',') : String(pattern));
      else if (navigator.vibrate) navigator.vibrate(pattern);
    } catch {
      // Vibration is optional.
    }
  },

  capture(pct) {
    this.buzz(pct >= 3 ? [0, 25, 40, 35] : 18);
  },
  kill() {
    this.buzz([0, 40, 50, 70]);
  },
  death() {
    this.buzz(220);
  },
  powerup() {
    this.buzz(30);
  },
  warn() {
    this.buzz([0, 15, 60, 15]);
  },
};
