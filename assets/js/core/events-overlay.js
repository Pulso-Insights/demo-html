// ===== EventsOverlay: synthetic event pins (zoom 8-13) =====
//
// Renders one small marker per event from events-murcia.json (or any file
// matching the same schema). Markers are colored by event type and show
// a tooltip on hover via a single shared maplibregl.Popup.
//
// Usage:
//   await EventsOverlay.init(map);   // reads url from PULSO_CONFIG.dataUrls.events
//   EventsOverlay.show();            // typically called for 'regional' / 'municipal' modes
//   EventsOverlay.hide();            // hidden in 'zones' / 'activitat' modes
//
// Design note: the marker DOM is intentionally just the visible dot. Earlier
// versions nested a hover-card inside each marker; that caused the pins to
// drift on zoom because MapLibre's anchor math is sensitive to the marker
// element's box. A single shared popup updated on hover keeps each marker
// minimal and rock-solid during camera moves.

const EventsOverlay = (() => {
  const _CFG = (typeof window !== 'undefined' && window.PULSO_CONFIG) || {};
  const _URL = _CFG.dataUrls || {};

  let map           = null;
  let events        = [];
  let markers       = [];     // maplibregl.Marker[]
  let active        = false;
  let loaded        = false;
  let starEventId   = _CFG.starEventId || null;
  let sharedPopup   = null;   // single popup reused for all markers

  // ---- Load ----

  async function init(mlMap) {
    map = mlMap;
    if (loaded) return events;

    const url = _URL.events;
    if (!url) {
      console.info('EventsOverlay: PULSO_CONFIG.dataUrls.events not set — skipping');
      return [];
    }

    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      events       = data.events || [];
      starEventId  = data.meta?.starEventId || starEventId;
      loaded       = true;
      console.log(`EventsOverlay: loaded ${events.length} events from ${url}`);
    } catch (e) {
      console.warn('EventsOverlay load failed:', e);
    }
    return events;
  }

  // ---- Build marker (dot only — tooltip is rendered into sharedPopup on hover) ----
  //
  // The icon is a Lucide name (e.g. "theater", "wine", "church"). We insert
  // <i data-lucide="..."> placeholders and replace them in bulk via
  // lucide.createIcons() after all markers are added. The SVG uses
  // stroke="currentColor" so it inherits the pin's text color (white).

  function buildMarkerEl(evt) {
    const dot = document.createElement('div');
    dot.className = 'evt-pin' + (evt.isStar ? ' evt-pin--star' : '');
    dot.style.setProperty('--evt-color', evt.color || '#2563EB');
    if (evt.icon) {
      const i = document.createElement('i');
      i.setAttribute('data-lucide', evt.icon);
      dot.appendChild(i);
    }
    dot.setAttribute('aria-label', `${evt.name} — ${evt.municipality}`);
    return dot;
  }

  function buildPopupHtml(evt) {
    const dateRange = evt.dates?.end && evt.dates.end !== evt.dates.start
      ? `${evt.dates.start} – ${evt.dates.end}`
      : (evt.dates?.start || '');
    const att = (evt.attendance || 0).toLocaleString('es-ES');
    return `
      <div class="evt-pop" style="--evt-color:${evt.color || '#2563EB'}">
        <div class="evt-pop-name">${evt.name}</div>
        <div class="evt-pop-meta">
          <span>${evt.municipality || ''}</span>
          <span class="evt-pop-sep"></span>
          <span>${evt.typeLabel || ''}</span>
        </div>
        <div class="evt-pop-foot">
          <span>${dateRange}</span>
          <span class="evt-pop-att">${att} asistentes</span>
        </div>
      </div>
    `;
  }

  function ensurePopup() {
    if (sharedPopup) return sharedPopup;
    sharedPopup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 14,
      anchor: 'bottom',
      className: 'evt-popup',
    });
    return sharedPopup;
  }

  // ---- Show / Hide ----

  function show() {
    if (!map || active || !loaded) return;
    active = true;
    ensurePopup();

    events.forEach(evt => {
      if (!evt.coordinates) return;
      const el = buildMarkerEl(evt);
      const lngLat = [evt.coordinates.lng, evt.coordinates.lat];

      // Hover handlers: update the shared popup so it follows the pointed pin.
      // Using mouseenter/leave on the DOM element keeps hover behavior
      // independent from MapLibre's canvas events.
      el.addEventListener('mouseenter', () => {
        sharedPopup
          .setLngLat(lngLat)
          .setHTML(buildPopupHtml(evt))
          .addTo(map);
      });
      el.addEventListener('mouseleave', () => {
        sharedPopup.remove();
      });

      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(lngLat)
        .addTo(map);
      markers.push(marker);
    });

    // Replace all <i data-lucide="..."> placeholders with their SVG.
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
      lucide.createIcons();
    }
  }

  function hide() {
    if (!active) return;
    active = false;
    if (sharedPopup) sharedPopup.remove();
    markers.forEach(m => m.remove());
    markers = [];
  }

  function isActive() { return active; }
  function getEvents() { return events; }
  function getStarEventId() { return starEventId; }

  return { init, show, hide, isActive, getEvents, getStarEventId };
})();
