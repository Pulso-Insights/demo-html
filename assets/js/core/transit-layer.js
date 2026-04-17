// ===== TransitLayer =====
// Overlays TMB routes (shared) + stops (per transit preset) on the map.
//
// Two route layers:
//   transit-routes-line   — the full network, drawn faint so the area outside
//                           the polygon stays as context without noise.
//   transit-routes-inside — the same routes clipped to the active polygon and
//                           drawn at full strength. This is the visual "reach"
//                           layer the user actually parses.
//
// Layer order (bottom → top):
//   transit-routes-line      ← faint, below the iso fill
//   iso-halo-fill/line       ← created by Proximity
//   transit-routes-inside    ← clipped, above the iso so it pops
//   transit-stops-circle     ← topmost, stops should always read clearly
//
// The shared routes file is fetched once and cached. Stops and the clipped
// routes are recomputed per (location, minutes). The clip uses
// turf.lineSplit + a midpoint-in-polygon test; we cache the result by polygon
// reference so switching back to a preset we already computed is free.

const TransitLayer = (() => {
  const ROUTES_URL     = 'assets/data/transit/routes.geojson';
  const ROUTES_SRC     = 'transit-routes';
  const ROUTES_LINE    = 'transit-routes-line';
  const INSIDE_SRC     = 'transit-routes-inside';
  const INSIDE_LINE    = 'transit-routes-inside-line';
  const STOPS_SRC      = 'transit-stops';
  const STOPS_CIRCLE   = 'transit-stops-circle';
  const ISO_FILL_ID    = 'iso-halo-fill';

  const EMPTY_FC = { type: 'FeatureCollection', features: [] };

  let _initPromise = null;
  let _routesFC    = EMPTY_FC;
  let _lastStopsUrl  = null;
  let _lastPolygon   = null;       // Feature reference — used as cache key
  let _hoverMarker   = null;       // maplibregl.Marker for the current hover card
  let _hoverStopId   = null;       // id of the stop the card is pinned to
  let _hoverTimer    = null;       // timeout id for deferred hide
  const _clipCache   = new WeakMap();  // Feature → clipped FeatureCollection

  const colorExpr = [
    'case',
    ['all', ['has', 'color'], ['!=', ['get', 'color'], '']],
    ['get', 'color'],
    '#6366F1',
  ];

  const widthExpr = [
    'case',
    ['==', ['get', 'route_type'], 1], 2.5,
    1.2,
  ];

  async function _init(map) {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      _routesFC = await fetch(ROUTES_URL).then(r => r.ok ? r.json() : EMPTY_FC).catch(() => EMPTY_FC);

      // Base (faded) layer — full network, below iso fill.
      map.addSource(ROUTES_SRC, { type: 'geojson', data: _routesFC });
      const beforeIsoFill = map.getLayer(ISO_FILL_ID) ? ISO_FILL_ID : undefined;
      map.addLayer({
        id: ROUTES_LINE,
        type: 'line',
        source: ROUTES_SRC,
        layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'none' },
        paint: {
          'line-color':   colorExpr,
          'line-width':   widthExpr,
          'line-opacity': 0.18,
        },
      }, beforeIsoFill);

      // Clipped layer — routes trimmed to the active polygon, above iso.
      map.addSource(INSIDE_SRC, { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: INSIDE_LINE,
        type: 'line',
        source: INSIDE_SRC,
        layout: { 'line-cap': 'round', 'line-join': 'round', 'visibility': 'none' },
        paint: {
          'line-color':   colorExpr,
          'line-width':   widthExpr,
          'line-opacity': 0.9,
        },
      });

      // Stops on top.
      map.addSource(STOPS_SRC, { type: 'geojson', data: EMPTY_FC });
      map.addLayer({
        id: STOPS_CIRCLE,
        type: 'circle',
        source: STOPS_SRC,
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 3, 17, 5],
          'circle-color': '#ffffff',
          'circle-stroke-color': '#1F2937',
          'circle-stroke-width': 1.25,
        },
      });

      _wireStopHover(map);
    })();
    return _initPromise;
  }

  // --- Hover card on stops -------------------------------------------------
  // Mirrors the merchant hover behavior: mouseenter over the circle layer
  // shows a card anchored at the stop; mouseleave schedules a hide that the
  // card itself can cancel (so the cursor can travel onto the card without
  // flicker). MapLibre serializes nested feature properties to strings, so
  // `routes` arrives as JSON text we have to parse back.

  function _wireStopHover(map) {
    map.on('mouseenter', STOPS_CIRCLE, () => { map.getCanvas().style.cursor = 'default'; });
    map.on('mouseleave', STOPS_CIRCLE, () => {
      map.getCanvas().style.cursor = '';
      _scheduleHideHover();
    });
    map.on('mousemove', STOPS_CIRCLE, (e) => {
      const f = e.features?.[0];
      if (!f) return;
      _showHoverCard(map, f);
    });
  }

  function _showHoverCard(map, feat) {
    const props = feat.properties || {};
    const stopId = String(props.stop_id || '');
    clearTimeout(_hoverTimer);
    if (_hoverMarker && _hoverStopId === stopId) return;
    _hideHoverCard();

    let routes = [];
    try { routes = typeof props.routes === 'string' ? JSON.parse(props.routes) : (props.routes || []); }
    catch (_err) { routes = []; }

    const wrapper = document.createElement('div');
    wrapper.className = 'rc-wrapper';
    wrapper.style.zIndex = '1000';
    wrapper.innerHTML = _renderHoverCard(props.stop_name || '', routes);

    const cardEl = wrapper.querySelector('.rc');
    if (cardEl) {
      cardEl.classList.add('rc--open');
      cardEl.addEventListener('mouseenter', () => clearTimeout(_hoverTimer));
      cardEl.addEventListener('mouseleave', _scheduleHideHover);
    }

    _hoverMarker = new maplibregl.Marker({
      element: wrapper,
      anchor:  'top',
      offset:  [0, 10],
    })
      .setLngLat(feat.geometry.coordinates)
      .addTo(map);
    _hoverStopId = stopId;
  }

  function _scheduleHideHover() {
    clearTimeout(_hoverTimer);
    _hoverTimer = setTimeout(_hideHoverCard, 180);
  }

  function _hideHoverCard() {
    clearTimeout(_hoverTimer);
    if (_hoverMarker) {
      _hoverMarker.remove();
      _hoverMarker = null;
      _hoverStopId = null;
    }
  }

  function _renderHoverCard(stopName, routes) {
    const badges = routes.map(r => {
      const bg   = r.color && r.color.toLowerCase() !== '#010101' ? r.color : '#374151';
      const fg   = r.text_color || '#ffffff';
      const cls  = r.route_type === 1 ? 'rc-transit-badge rc-transit-badge--metro' : 'rc-transit-badge';
      const safe = _escape(r.short_name || '?');
      return `<span class="${cls}" style="background:${bg};color:${fg}">${safe}</span>`;
    }).join('');
    const safeName = _escape(stopName);
    return `
      <div class="rc rc--xs rc--transit">
        <div class="rc-transit-row">
          ${badges ? `<span class="rc-transit-badges">${badges}</span>` : ''}
          <span class="rc-transit-name">${safeName}</span>
        </div>
      </div>`;
  }

  function _escape(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // clipRoutesToPolygon walks each route LineString, splits at the polygon
  // boundary with turf.lineSplit, and keeps segments whose midpoint is inside.
  // Returns a FeatureCollection of the inside-only segments, with each route's
  // original properties preserved.
  function _clipRoutesToPolygon(polygon) {
    if (_clipCache.has(polygon)) return _clipCache.get(polygon);

    const features = [];
    for (const route of _routesFC.features) {
      const geom = route.geometry;
      if (!geom || geom.type !== 'LineString' || geom.coordinates.length < 2) continue;

      let pieces;
      try {
        pieces = turf.lineSplit(route, polygon).features;
      } catch (_e) {
        // lineSplit throws if the line doesn't cross the polygon. Fall back to
        // treating the line as one piece — the midpoint test decides if it's
        // fully inside or fully outside.
        pieces = [route];
      }
      if (!pieces.length) pieces = [route];

      for (const piece of pieces) {
        if (!piece.geometry || piece.geometry.coordinates.length < 2) continue;
        const len = turf.length(piece, { units: 'kilometers' });
        if (len <= 0) continue;
        const mid = turf.along(piece, len / 2, { units: 'kilometers' });
        if (turf.booleanPointInPolygon(mid, polygon)) {
          features.push({
            type: 'Feature',
            properties: route.properties,
            geometry: piece.geometry,
          });
        }
      }
    }

    const fc = { type: 'FeatureCollection', features };
    _clipCache.set(polygon, fc);
    return fc;
  }

  async function show(map, polygon, stopsUrl) {
    await _init(map);

    // Clipped routes — recompute only if polygon identity changed.
    if (polygon && polygon !== _lastPolygon) {
      const fc = _clipRoutesToPolygon(polygon);
      const src = map.getSource(INSIDE_SRC);
      if (src) src.setData(fc);
      _lastPolygon = polygon;
    } else if (!polygon && _lastPolygon !== null) {
      const src = map.getSource(INSIDE_SRC);
      if (src) src.setData(EMPTY_FC);
      _lastPolygon = null;
    }

    // Stops — refetch only if the URL changed. Close any stale popup so it
    // doesn't linger pointing at a stop that's about to leave the layer.
    if (stopsUrl !== _lastStopsUrl) {
      _hideHoverCard();
      const fc = stopsUrl
        ? await fetch(stopsUrl).then(r => r.ok ? r.json() : EMPTY_FC).catch(() => EMPTY_FC)
        : EMPTY_FC;
      const src = map.getSource(STOPS_SRC);
      if (src) src.setData(fc);
      _lastStopsUrl = stopsUrl;
    }

    map.setLayoutProperty(ROUTES_LINE,  'visibility', 'visible');
    map.setLayoutProperty(INSIDE_LINE,  'visibility', 'visible');
    map.setLayoutProperty(STOPS_CIRCLE, 'visibility', 'visible');
  }

  function hide(map) {
    if (!_initPromise) return;
    _hideHoverCard();
    if (map.getLayer(ROUTES_LINE))  map.setLayoutProperty(ROUTES_LINE,  'visibility', 'none');
    if (map.getLayer(INSIDE_LINE))  map.setLayoutProperty(INSIDE_LINE,  'visibility', 'none');
    if (map.getLayer(STOPS_CIRCLE)) map.setLayoutProperty(STOPS_CIRCLE, 'visibility', 'none');
  }

  return { show, hide };
})();
