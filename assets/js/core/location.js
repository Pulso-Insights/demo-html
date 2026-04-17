// ===== LocationStore =====
// Holds the list of user saved places + an ad-hoc "current location" that the
// user can drop on the map. One of them is always active (drives the halo and
// the nearby list). Listeners are notified on every change.

const LocationStore = (() => {
  let _saved     = [];
  let _current   = null;   // { id:'current', label, icon:'📍', coordinates, isCurrent:true }
  let _activeId  = null;
  let _listeners = [];

  async function load(url = 'assets/data/user-locations.json') {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`LocationStore load failed: HTTP ${resp.status}`);
    const data = await resp.json();
    _saved = data.locations || [];
    await _resolveIsochrones(_saved);
    if (_saved.length && !_activeId) _activeId = _saved[0].id;
    _emit();
    return _saved;
  }

  // Inline GeoJSON Features referenced by path in user-locations.json so
  // Proximity.getIsochrone can use them synchronously. A missing or failing
  // fetch becomes null, which falls back to a circle.
  async function _resolveIsochrones(locations) {
    const jobs = [];
    for (const loc of locations) {
      if (!loc.isochrones) continue;
      for (const byMin of Object.values(loc.isochrones)) {
        for (const [min, val] of Object.entries(byMin)) {
          if (typeof val !== 'string') continue;
          jobs.push(
            fetch(val)
              .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
              .then(feat => { byMin[min] = feat; })
              .catch(err => {
                console.warn('[LocationStore] isochrone fetch failed', val, err);
                byMin[min] = null;
              })
          );
        }
      }
    }
    if (jobs.length) {
      await Promise.all(jobs);
      const hydrated = jobs.length;
      console.log(`[LocationStore] hydrated ${hydrated} isochrone feature(s)`);
    }
  }

  function getSaved()   { return _saved.slice(); }
  function hasCurrent() { return !!_current; }

  function getActive() {
    if (_activeId === 'current') return _current;
    return _saved.find(l => l.id === _activeId) || null;
  }

  function setActive(id) {
    if (id === 'current' && !_current) return;
    if (id !== _activeId) {
      _activeId = id;
      _emit();
    }
  }

  function setCurrent(coordinates, label = 'La meva ubicació') {
    _current = {
      id: 'current',
      label,
      icon: '📍',
      coordinates,
      isCurrent: true,
      isochrones: null,
    };
    _activeId = 'current';
    _emit();
  }

  function clearCurrent() {
    if (!_current) return;
    _current = null;
    if (_activeId === 'current') {
      _activeId = _saved[0]?.id || null;
    }
    _emit();
  }

  function onChange(fn) {
    _listeners.push(fn);
    return () => { _listeners = _listeners.filter(l => l !== fn); };
  }

  function _emit() {
    const active = getActive();
    _listeners.forEach(fn => fn(active));
  }

  return {
    load,
    getSaved, getActive,
    setActive, setCurrent, clearCurrent, hasCurrent,
    onChange,
  };
})();
