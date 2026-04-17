// ===== MapMode: map mode manager based on zoom =====
// Tracks which geographic "level" the map is currently showing
// and notifies listeners when the mode changes.

const MapMode = (() => {
  // Mode definitions — inclusive zoom ranges
  const MODES = [
    { name: 'regional',  min: 6,  max: 9  },
    { name: 'municipal', min: 10, max: 12 },
    { name: 'zones',     min: 13, max: 14 },
    { name: 'activitat', min: 15, max: 20 },
  ];

  let currentMode = null;
  const listeners = {}; // event -> [fn, ...]

  function modeForZoom(zoom) {
    const z = Math.round(zoom);
    const found = MODES.find(m => z >= m.min && z <= m.max);
    return found ? found.name : 'regional';
  }

  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
  }

  function off(event, fn) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter(f => f !== fn);
  }

  function emit(event, data) {
    (listeners[event] || []).forEach(fn => fn(data));
  }

  /**
   * Call this on every Leaflet zoomend event.
   * Emits 'change' only when the mode actually switches.
   */
  function update(zoom) {
    const next = modeForZoom(zoom);
    if (next === currentMode) return;

    const prev = currentMode;
    currentMode = next;
    emit('change', { from: prev, to: next, zoom });
  }

  return {
    update,
    on,
    off,
    get current() { return currentMode; },
    modeForZoom,
  };
})();
