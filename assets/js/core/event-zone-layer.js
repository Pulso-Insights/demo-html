// ===== EventZoneLayer: event influence zones (zoom 14–15) — MapLibre GL JS =====
// Intermediate level between municipal cards and individual merchants.
// Shows event influence zones as colored blobs + summary cards.
// Clicking a zone card flies to zoom 16, entering 'activitat' mode.

const EventZoneLayer = (() => {
  // Region-specific zones come from PULSO_CONFIG.eventZones; default to BCN.
  const _CFG = (typeof window !== 'undefined' && window.PULSO_CONFIG) || {};

  let map           = null;
  let active        = false;
  let createdIds    = [];              // layer/source ids added on show()
  let cardMarkers   = [];              // maplibregl.Marker[]
  let cardElements  = new Map();       // zone.id → .rc DOM element
  let onSelectCb    = null;
  let isochrones    = {};              // realEventId → GeoJSON feature (5-min walk)

  const TAG_CLASS = {
    'Gastronòmic': 'gastronomic',
    'Cultural':    'cultural',
    'Festa Major': 'festa',
    'Mercat':      'mercat',
  };

  // ---- Demo event zones ----

  const EVENT_ZONES = _CFG.eventZones || [
    {
      id:           'ruta-gastronomica',
      realEventId:  'platillos-2025',
      name:         'A la tardor, platillos',
      subtitle:     "L'Hospitalet · 3 zones",
      icon:         '🍽',
      color:        '#FF6B00',
      tags:         ['Gastronòmic', 'Mercat'],
      merchants:    28,
      participants: 312,
      interest:     92,
      points: [
        [41.3589, 2.0991],
        [41.3618, 2.1032],
        [41.3654, 2.1010],
        [41.3682, 2.1311],
        [41.3516, 2.1115],
      ],
      radius:   0.30,
      zoomTo:   15,
      centerTo: [41.362, 2.108],
    },
  ];

  // ---- Zone polygon ----

  function buildZonePolygon(evt) {
    if (evt.realEventId && isochrones[evt.realEventId]) {
      return isochrones[evt.realEventId];
    }

    if (typeof turf === 'undefined') return null;
    const buffers = evt.points.map(([lat, lng]) =>
      turf.buffer(turf.point([lng, lat]), evt.radius, { units: 'kilometers', steps: 32 })
    );
    let merged = buffers[0];
    for (let i = 1; i < buffers.length; i++) {
      try { merged = turf.union(turf.featureCollection([merged, buffers[i]])); }
      catch (_) {}
    }
    return merged;
  }

  // ---- Card HTML (Pulso Card primitive — .rc) ----

  const TAG_ACCENT = {
    'Gastronòmic': 'gastro',
    'Cultural':    'cultural',
    'Festa Major': 'festa',
    'Mercat':      'mercat',
  };

  function buildCardHtml(evt, animDelay) {
    const tagsHtml = evt.tags.map(t => {
      const cls = TAG_ACCENT[t] || 'gastro';
      return `<span class="rc-tag rc-tag--${cls}">${t}</span>`;
    }).join('');

    const accent = TAG_ACCENT[evt.tags[0]] || 'gastro';

    const interestHtml = evt.interest
      ? `<div class="rc-interest">
           <div class="rc-interest-track"><div class="rc-interest-fill" style="width:${evt.interest}%"></div></div>
           <div class="rc-interest-val">${evt.interest}%</div>
         </div>`
      : '';

    return `
      <div class="rc rc--sm" data-accent="${accent}" data-event-id="${evt.id}"
           style="--rc-d:${animDelay}ms">
        <div class="rc-head">
          <div class="rc-title-block">
            <div class="rc-name">${evt.name}</div>
            <div class="rc-sub">${evt.subtitle}</div>
          </div>
          <div class="rc-live" aria-label="En viu"></div>
        </div>
        <div class="rc-summary">
          <span><strong>${evt.merchants}</strong> establiments</span>
          <span class="rc-summary-sep"></span>
          <span><strong>${evt.participants}</strong> participants</span>
        </div>
        <div class="rc-body">
          ${interestHtml}
          <div class="rc-tags">${tagsHtml}</div>
        </div>
        <div class="rc-hint">Clic per explorar
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h6M7 3l3 3-3 3"/></svg>
        </div>
      </div>`;
  }

  // ---- Show / Hide ----

  function show() {
    if (!map || active) return;
    active = true;

    EVENT_ZONES.forEach((evt, idx) => {
      const geo = buildZonePolygon(evt);
      if (geo) {
        const srcId  = `evtzone-src-${evt.id}`;
        const fillId = `evtzone-fill-${evt.id}`;
        const lineId = `evtzone-line-${evt.id}`;

        map.addSource(srcId, { type: 'geojson', data: geo });
        map.addLayer({
          id: fillId, type: 'fill', source: srcId,
          paint: { 'fill-color': evt.color, 'fill-opacity': 0.10 },
        });
        map.addLayer({
          id: lineId, type: 'line', source: srcId,
          paint: { 'line-color': evt.color, 'line-opacity': 0.45, 'line-width': 2 },
        });
        createdIds.push(srcId, fillId, lineId);

        map.on('mousemove', fillId, () => {
          map.getCanvas().style.cursor = 'pointer';
          map.setPaintProperty(fillId, 'fill-opacity', 0.22);
          map.setPaintProperty(lineId, 'line-opacity', 0.70);
          map.setPaintProperty(lineId, 'line-width',   2.5);
          cardElements.get(evt.id)?.classList.add('rc--open');
        });
        map.on('mouseleave', fillId, () => {
          map.getCanvas().style.cursor = '';
          map.setPaintProperty(fillId, 'fill-opacity', 0.10);
          map.setPaintProperty(lineId, 'line-opacity', 0.45);
          map.setPaintProperty(lineId, 'line-width',   2);
          cardElements.get(evt.id)?.classList.remove('rc--open');
        });
        map.on('click', fillId, (e) => {
          e.originalEvent.preventDefault();
          _selectZone(evt);
        });
      }

      // Card marker at centerTo — data convention is [lat, lng], MapLibre expects [lng, lat]
      const wrapper = document.createElement('div');
      wrapper.className = 'rc-wrapper';
      wrapper.innerHTML = buildCardHtml(evt, idx * 90);

      const marker = new maplibregl.Marker({
        element: wrapper,
        anchor: 'center',
      })
        .setLngLat([evt.centerTo[1], evt.centerTo[0]])
        .addTo(map);
      cardMarkers.push(marker);

      const card = wrapper.querySelector('.rc');
      if (card) {
        cardElements.set(evt.id, card);
        card.addEventListener('click', e => {
          e.stopPropagation();
          _selectZone(evt);
        });
      }
    });
  }

  function hide() {
    if (!active) return;
    active = false;

    // Remove in reverse order: layers first, then sources
    createdIds.reverse().forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
      else if (map.getSource(id)) map.removeSource(id);
    });
    createdIds = [];

    cardMarkers.forEach(m => m.remove());
    cardMarkers = [];
    cardElements.clear();
  }

  function _selectZone(zone) {
    map.flyTo({
      center: [zone.centerTo[1], zone.centerTo[0]],
      zoom: zone.zoomTo,
      duration: 1000,
    });
    if (onSelectCb) onSelectCb(zone);
  }

  function init(mlMap, isochroneData) {
    map = mlMap;
    if (isochroneData) {
      Object.entries(isochroneData).forEach(([eventId, features]) => {
        const inner = features[features.length - 1];
        if (inner) isochrones[eventId] = inner;
      });
    }
  }

  function getZones() { return EVENT_ZONES; }

  function onSelect(cb) { onSelectCb = cb; }

  return { init, show, hide, getZones, onSelect };
})();
