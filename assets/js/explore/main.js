// ===== Explore: new multi-level demo orchestrator (MapLibre GL JS) =====
// Manages the full lifecycle of the explore.html experience:
//   - MapLibre map at full screen, initial zoom 8 (regional view)
//   - MapMode drives hierarchy layers and sidebar visibility
//   - FocusMode for single-event overlay
//   - Sidebar slides in/out based on mode (desktop) or bottom-sheet (mobile)
//
// Basemap: OpenFreeMap "positron" style (vector tiles, free, no API key).
// For production, swap BASEMAP_STYLE_URL for a self-hosted .pmtiles + custom Protomaps theme.

const Explore = (() => {

  // ---- Basemap ----
  const BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

  // ---- State ----
  let map           = null;
  let merchantMarkers = [];   // maplibregl.Marker[]
  let markers       = {};     // merchantId -> { marker, lngLat }
  let zoneLayerIds  = [];     // ordered list of MapLibre layer ids for zones (for z-ordering)
  let zoneSourceIds = [];
  let zoneLayerMap  = new Map(); // eventId → { primaryLayerId, styleBase, styleFocused, styleDimmed }
  let zoneGeoJsons  = [];        // [{eventId, geojson}] for overlap detection
  let overlapLayerIds = [];
  let events        = [];
  let allMerchants  = [];
  let merchantEventMap = {};
  let activeMerchantId    = null;
  let hoverTimeout        = null;
  let cardHideTimeout     = null;
  let merchantsLoaded     = false;
  let merchantsVisible    = false;
  let pendingFocusEventId = null;
  let isochroneData       = {};  // eventId → walk features sorted outermost→innermost
  // True while a programmatic camera animation (focus-enter fitBounds) is in
  // flight. Suppresses mode-change transitions so the animation landing at
  // zoom 14 can't bounce us from 'activitat' back to 'zones'.
  let focusTransitioning  = false;

  const TAG_CLASS_SB = {
    'Gastronòmic': 'gastro',
    'Cultural':    'cultural',
    'Festa Major': 'festa',
    'Mercat':      'mercat',
  };

  const CENTER_REGIONAL = [1.50, 41.60]; // Catalonia center [lng, lat]
  const ZOOM_INITIAL    = 8;
  const ZOOM_MIN        = 6;
  const ZOOM_MAX        = 18;

  // ---- Boot ----

  async function init() {
    initMap();
    await new Promise(resolve => {
      if (map.loaded()) resolve();
      else map.once('load', resolve);
    });

    MapMode.update(ZOOM_INITIAL);

    // Wire the shared detail drawer. Explore-specific side effects on close
    // (reset lists/markers, re-fit camera if focus is active) run in the hook.
    DetailDrawer.configure({
      onClose: () => {
        resetListStates();
        resetMarkerStates();
        if (FocusMode.isActive() && FocusMode.active) {
          fitToEvent(FocusMode.active, 800);
        }
      },
    });

    try {
      const resp = await fetch('assets/data/platillos-merchants.json');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      events = data.events;
      events.forEach(evt => {
        evt.merchants.forEach(m => {
          m._event = evt;
          allMerchants.push(m);
          merchantEventMap[m.id] = evt;
        });
      });

      // Preload isochrone GeoJSON files
      try {
        const isoResp = await fetch('assets/data/platillos-isochrones.json');
        if (isoResp.ok) {
          const isoGeo = await isoResp.json();
          const feat5min = isoGeo.features.find(
            f => f.properties.mode === 'walk' && f.properties.minutes === 5
          );
          if (feat5min) isochroneData['platillos-2025'] = [feat5min];
        }
      } catch (_) {}

      await HierarchyLayer.init(map);
      EventZoneLayer.init(map, isochroneData);

      // Wire EventZoneLayer zone selection → auto-focus on activitat entry
      EventZoneLayer.onSelect(zone => {
        if (zone.realEventId) pendingFocusEventId = zone.realEventId;
      });

      // Start in regional mode — fit tight to the 4 Catalan provinces
      HierarchyLayer.setMode('regional');
      HierarchyLayer.fitToLevel('regional');

      document.getElementById('map-loading').classList.add('hidden');
    } catch (err) {
      console.error('Explore init error:', err);
      const loading = document.getElementById('map-loading');
      loading.classList.add('error');
      loading.querySelector('p').textContent = 'Error carregant les dades.';
    }
  }

  // ---- Map initialization ----

  function initMap() {
    map = new maplibregl.Map({
      container: 'map',
      style: BASEMAP_STYLE_URL,
      center: CENTER_REGIONAL,
      zoom: ZOOM_INITIAL,
      minZoom: ZOOM_MIN,
      maxZoom: ZOOM_MAX,
      attributionControl: { compact: true },
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    // Click empty map → close modal first, else exit focus
    map.on('click', (e) => {
      // Ignore clicks consumed by feature handlers (they set defaultPrevented)
      if (e.originalEvent.defaultPrevented) return;
      const drawer = document.getElementById('detail-drawer');
      if (drawer && !drawer.classList.contains('detail-drawer--hidden')) {
        resetAllStates();
        closeModal();
        return;
      }
      if (FocusMode.isActive()) {
        FocusMode.exit();
        return;
      }
      resetAllStates();
      closeModal();
    });

    // zoomend: update mode
    map.on('zoomend', () => {
      MapMode.update(map.getZoom());
    });

    // Mode transitions
    MapMode.on('change', ({ from, to }) => onModeChange(from, to));
  }

  // ---- Mode transitions ----

  function _showMerchants() {
    merchantMarkers.forEach(m => m.addTo(map));
    zoneLayerIds.forEach(id => _setLayerVisible(id, true));
    merchantsVisible = true;
  }

  function _hideMerchants() {
    merchantMarkers.forEach(m => m.remove());
    _hideMerchantHoverCard();
    zoneLayerIds.forEach(id => _setLayerVisible(id, false));
    overlapLayerIds.forEach(id => _setLayerVisible(id, false));
    zoneLayerMap.clear();
    merchantsVisible = false;
    if (FocusMode.isActive()) FocusMode.exit();
    resetAllStates();
    closeModal();
  }

  function _setLayerVisible(id, visible) {
    if (!map.getLayer(id)) return;
    map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }

  function onModeChange(from, to) {
    if (focusTransitioning) return;
    if (to === 'activitat') {
      HierarchyLayer.hide();
      EventZoneLayer.hide();
      if (!merchantsLoaded) {
        loadMerchants();
        merchantsLoaded = true;
        merchantsVisible = true;
      } else {
        _showMerchants();
        _tryPendingFocus();
      }

    } else if (to === 'zones') {
      if (from === 'activitat') _hideMerchants();
      hideSidebar();
      HierarchyLayer.setGhost('municipal');
      EventZoneLayer.show();
      showSidebar('zones');

    } else {
      if (from === 'activitat') _hideMerchants();
      if (from === 'zones') { EventZoneLayer.hide(); hideSidebar(); }
      HierarchyLayer.setMode(to);
    }
  }

  function _tryPendingFocus() {
    if (!pendingFocusEventId) return;
    const id  = pendingFocusEventId;
    pendingFocusEventId = null;
    const evt = events.find(e => e.id === id);
    if (evt) setTimeout(() => enterFocus(evt), 400);
  }

  // ---- Merchant loading (ACTIVITAT mode) ----

  function loadMerchants() {
    events.forEach(evt => {
      addMerchants(evt.merchants, evt.color);
      drawInfluenceZone(evt.merchants, evt.color, evt.id);
    });

    // Detect overlaps between zones for overlap picker
    detectAndDrawOverlap();

    lucide.createIcons();
    updateOpenCount();
    startLiveCounters();
    startRippleLoop();

    _tryPendingFocus();
  }

  // ---- Influence zone (Turf) ----

  function drawInfluenceZone(merchantList, color, eventId) {
    const precomp = isochroneData[eventId];

    if (precomp && precomp.length > 0) {
      _drawIsochroneLayers(precomp, color, eventId);
      return;
    }

    if (typeof turf === 'undefined') return;

    const pts = merchantList
      .filter(m => m.coordinates && !(m.coordinates.lat === 0 && m.coordinates.lng === 0))
      .map(m => turf.point([m.coordinates.lng, m.coordinates.lat]));
    if (pts.length === 0) return;

    const fc = turf.featureCollection(pts);
    let shape = null;
    if (pts.length >= 3) {
      try { shape = turf.concave(fc, { maxEdge: 1.2, units: 'kilometers' }); } catch (_) {}
    }
    if (!shape) { try { shape = turf.convex(fc); } catch (_) {} }
    if (!shape)   shape = turf.buffer(turf.centroid(fc), 0.42, { units: 'kilometers', steps: 48 });

    const merged = turf.buffer(shape, 0.42, { units: 'kilometers', steps: 48 });
    if (!merged) return;

    _addZoneLayer(merged, color, eventId, true, null);
  }

  function _drawIsochroneLayers(features, color, eventId) {
    const outerConfigs = [
      { fillOpacity: 0.04, lineOpacity: 0.18, lineWidth: 1, dash: [6, 4] },
      { fillOpacity: 0.07, lineOpacity: 0.28, lineWidth: 1, dash: [3, 3] },
    ];

    features.slice(0, -1).forEach((feat, idx) => {
      const cfg = outerConfigs[Math.min(idx, outerConfigs.length - 1)];
      _addZoneLayer(feat, color, eventId, false, cfg);
    });

    _addZoneLayer(features[features.length - 1], color, eventId, true, null);
  }

  function _addZoneLayer(geojson, color, eventId, isPrimary, decorativeCfg) {
    const suffix = `${eventId}-${zoneSourceIds.length}`;
    const srcId = `zone-src-${suffix}`;
    const fillId = `zone-fill-${suffix}`;
    const lineId = `zone-line-${suffix}`;

    map.addSource(srcId, { type: 'geojson', data: geojson });
    zoneSourceIds.push(srcId);

    if (decorativeCfg) {
      // Decorative outer rings (non-interactive)
      map.addLayer({
        id: fillId, type: 'fill', source: srcId,
        paint: { 'fill-color': color, 'fill-opacity': decorativeCfg.fillOpacity },
      });
      map.addLayer({
        id: lineId, type: 'line', source: srcId,
        paint: {
          'line-color': color,
          'line-opacity': decorativeCfg.lineOpacity,
          'line-width': decorativeCfg.lineWidth,
          'line-dasharray': decorativeCfg.dash,
        },
      });
      zoneLayerIds.push(fillId, lineId);
      return;
    }

    // Primary (interactive) zone
    const styleBase    = { fillOpacity: 0.12, lineOpacity: 0.40, lineWidth: 2 };
    const styleHover   = { fillOpacity: 0.22, lineOpacity: 0.65, lineWidth: 2.5 };
    const styleFocused = { fillOpacity: 0.25, lineOpacity: 0.70, lineWidth: 2.5 };
    const styleDimmed  = { fillOpacity: 0.03, lineOpacity: 0.10, lineWidth: 1   };

    map.addLayer({
      id: fillId, type: 'fill', source: srcId,
      paint: { 'fill-color': color, 'fill-opacity': styleBase.fillOpacity },
    });
    map.addLayer({
      id: lineId, type: 'line', source: srcId,
      paint: { 'line-color': color, 'line-opacity': styleBase.lineOpacity, 'line-width': styleBase.lineWidth },
    });
    zoneLayerIds.push(fillId, lineId);

    // Hover / click interactions
    map.on('mousemove', fillId, () => {
      if (FocusMode.isActive()) return;
      map.getCanvas().style.cursor = 'pointer';
      _applyZoneStyle(fillId, lineId, color, styleHover);
    });
    map.on('mouseleave', fillId, () => {
      if (FocusMode.isActive()) return;
      map.getCanvas().style.cursor = '';
      const entry = zoneLayerMap.get(eventId);
      if (entry && FocusMode.active?.id) {
        _applyZoneStyle(fillId, lineId, color,
          eventId === FocusMode.active.id ? styleFocused : styleDimmed);
      } else {
        _applyZoneStyle(fillId, lineId, color, styleBase);
      }
    });
    map.on('click', fillId, (e) => {
      e.originalEvent.preventDefault();
      const evt = events.find(ev => ev.id === eventId);
      if (!evt) return;
      if (FocusMode.isActive()) {
        if (FocusMode.active?.id === eventId) return;
        FocusMode.exit();
      }
      enterFocus(evt);
    });

    if (isPrimary) {
      zoneLayerMap.set(eventId, { fillId, lineId, color, styleBase, styleFocused, styleDimmed });
      zoneGeoJsons.push({ eventId, geojson });
    }
  }

  function _applyZoneStyle(fillId, lineId, color, s) {
    if (map.getLayer(fillId)) map.setPaintProperty(fillId, 'fill-opacity', s.fillOpacity);
    if (map.getLayer(lineId)) {
      map.setPaintProperty(lineId, 'line-opacity', s.lineOpacity);
      map.setPaintProperty(lineId, 'line-width',   s.lineWidth);
    }
  }

  function _applyZoneStyles(focusedEventId) {
    zoneLayerMap.forEach((entry, evtId) => {
      const { fillId, lineId, color, styleBase, styleFocused, styleDimmed } = entry;
      if (focusedEventId === null)         _applyZoneStyle(fillId, lineId, color, styleBase);
      else if (evtId === focusedEventId)   _applyZoneStyle(fillId, lineId, color, styleFocused);
      else                                 _applyZoneStyle(fillId, lineId, color, styleDimmed);
    });
  }

  // ---- Overlap detection & picker ----

  function detectAndDrawOverlap() {
    if (zoneGeoJsons.length < 2 || typeof turf === 'undefined') return;

    for (let i = 0; i < zoneGeoJsons.length; i++) {
      for (let j = i + 1; j < zoneGeoJsons.length; j++) {
        const a = zoneGeoJsons[i];
        const b = zoneGeoJsons[j];

        let intersection = null;
        try {
          intersection = turf.intersect(turf.featureCollection([a.geojson, b.geojson]));
        } catch (_) {}

        if (!intersection) continue;

        const suffix = `${i}-${j}`;
        const srcId  = `overlap-src-${suffix}`;
        const fillId = `overlap-fill-${suffix}`;

        map.addSource(srcId, { type: 'geojson', data: intersection });
        map.addLayer({
          id: fillId, type: 'fill', source: srcId,
          paint: { 'fill-opacity': 0, 'fill-color': '#000' },
        });
        overlapLayerIds.push(fillId);

        const evtA = events.find(e => e.id === a.eventId);
        const evtB = events.find(e => e.id === b.eventId);

        map.on('mousemove', fillId, (e) => {
          if (FocusMode.isActive()) return;
          OverlapPicker.show([evtA, evtB], e.point.x, e.point.y);
        });
        map.on('mouseleave', fillId, () => {
          OverlapPicker.scheduleHide(400);
        });

        wirePickerButtons(evtA, evtB);
      }
    }
  }

  function wirePickerButtons(evtA, evtB) {
    const picker = document.getElementById('overlap-picker');
    if (!picker) return;

    const observer = new MutationObserver(() => {
      picker.querySelectorAll('.overlap-picker-btn').forEach(btn => {
        btn.onclick = () => {
          const id = btn.dataset.eventId;
          const evt = id === evtA.id ? evtA : evtB;
          OverlapPicker.hide();
          enterFocus(evt);
        };
      });
    });
    observer.observe(picker, { childList: true });
  }

  // ---- Focus Mode wiring ----

  // Fit the camera to an event's merchant bounds, accounting for the left
  // focus sidebar. Sets the focusTransitioning guard so the final zoom of the
  // animation (possibly 14) can't bounce us back to 'zones' mode.
  function fitToEvent(evt, duration = 1100) {
    const coords = evt.merchants
      .filter(m => m.coordinates?.lat && m.coordinates?.lng)
      .map(m => [m.coordinates.lng, m.coordinates.lat]);
    if (coords.length === 0) return false;
    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0])
    );
    focusTransitioning = true;
    map.fitBounds(bounds, {
      padding: { top: 80, left: 360, right: 80, bottom: 100 },
      maxZoom: 16,
      duration,
    });
    map.once('idle', () => { focusTransitioning = false; });
    return true;
  }

  function enterFocus(evt) {
    FocusMode.enter(evt, {
      onEnter: (activeEvt) => {
        showSidebar('focus', activeEvt);
        _applyZoneStyles(activeEvt.id);

        allMerchants.forEach(m => {
          if (m._event.id !== activeEvt.id)
            updateMarkerElement(m.id, 'add', 'marker-out-of-focus');
        });

        document.getElementById('app-new')?.classList.add('focus-active');

        // fitToEvent handles the focusTransitioning guard so the animation
        // settling at zoom 14 can't retrigger 'zones' mode.
        fitToEvent(activeEvt);
      },
      onExit: () => {
        document.getElementById('app-new')?.classList.remove('focus-active');
        showSidebar('zones');
        _applyZoneStyles(null);
        allMerchants.forEach(m =>
          updateMarkerElement(m.id, 'remove', 'marker-out-of-focus')
        );
        resetAllStates();
      },
    });
  }

  // ---- Merchant markers ----

  function createMarker(merchant, eventColor) {
    if (!merchant.coordinates ||
        (merchant.coordinates.lat === 0 && merchant.coordinates.lng === 0)) return null;

    const { lat, lng } = merchant.coordinates;
    const lngLat = [lng, lat];
    const now = new Date();
    const status = Status.getOpenStatus(merchant, now);

    const wrapper = document.createElement('div');
    wrapper.className = 'merchant-dot-wrapper';
    const dot = document.createElement('div');
    dot.className = `merchant-dot merchant-dot--${status.status}`;
    dot.dataset.merchantId = merchant.id;
    if (eventColor) dot.style.setProperty('--event-color', eventColor);
    wrapper.appendChild(dot);

    const marker = new maplibregl.Marker({ element: wrapper, anchor: 'center' })
      .setLngLat(lngLat)
      .addTo(map);

    markers[merchant.id] = { marker, lngLat };
    merchantMarkers.push(marker);

    wrapper.addEventListener('mouseenter', () => {
      highlightListItem(merchant.id);
      updateMarkerElement(merchant.id, 'add', 'marker-hover');
      _showMerchantHoverCard(merchant);
    });
    wrapper.addEventListener('mouseleave', () => {
      unhighlightListItem();
      updateMarkerElement(merchant.id, 'remove', 'marker-hover');
      _scheduleHideMerchantHoverCard();
    });
    wrapper.addEventListener('click', (e) => {
      e.stopPropagation();
      setActive(merchant.id);
      setActiveItem(merchant.id);
      panTo(merchant.id, true);
      openModal(merchant);
    });

    return marker;
  }

  function addMerchants(merchantList, eventColor) {
    merchantList.forEach(m => createMarker(m, eventColor));
  }

  // ---- Label layout: place names below dots, offset + leader line when overlapping ----

  // Map a merchant's tags to a .rc accent category. First matching tag wins;
  // defaults to 'gastro'.
  const MERCHANT_ACCENT = {
    'Gastronòmic': 'gastro',
    'Cultural':    'cultural',
    'Festa Major': 'festa',
    'Mercat':      'mercat',
  };
  function _merchantAccent(m) {
    if (!m.tags || !m.tags.length) return 'gastro';
    for (const t of m.tags) {
      if (MERCHANT_ACCENT[t]) return MERCHANT_ACCENT[t];
    }
    return 'gastro';
  }

  function _shortName(name, max = 22) {
    return name.length > max ? name.slice(0, max - 1) + '…' : name;
  }

  function _buildMerchantCardHtml(m, status) {
    const accent = _merchantAccent(m);
    const dish = m.dish?.name
      ? (m.dish.price ? `${m.dish.name} · ${m.dish.price}` : m.dish.name)
      : '';
    return `
      <div class="rc rc--xs" data-merchant-id="${m.id}" data-accent="${accent}">
        <div class="rc-head">
          <div class="rc-title-block">
            <div class="rc-name">${_shortName(m.name, 22)}</div>
          </div>
          <span class="rc-status-dot rc-status-dot--${status.status}" aria-label="${status.label}"></span>
        </div>
        ${dish ? `<div class="rc-body"><div class="rc-meta">${dish}</div></div>` : ''}
      </div>`;
  }

  // ---- Merchant hover card (.rc--xs, shown only while cursor is on dot/card) ----
  // A single reusable MapLibre Marker attached to the hovered merchant. No
  // persistent labels — density stays legible at dense merchant clusters.

  let hoverCardMarker     = null;
  let hoverCardMerchantId = null;
  let hoverCardHideTimer  = null;

  function _showMerchantHoverCard(m) {
    clearTimeout(hoverCardHideTimer);
    if (hoverCardMerchantId === m.id && hoverCardMarker) return; // already shown
    _hideMerchantHoverCard();

    const entry = markers[m.id];
    if (!entry) return;

    const status  = Status.getOpenStatus(m, new Date());
    const wrapper = document.createElement('div');
    wrapper.className = 'rc-wrapper';
    wrapper.style.zIndex = '1000';
    wrapper.innerHTML = _buildMerchantCardHtml(m, status);

    const cardEl = wrapper.querySelector('.rc');
    if (cardEl) {
      cardEl.classList.add('rc--open'); // show expanded content right away
      // Mirror dot state so an active/out-of-focus merchant's card reflects it.
      const dot = getMarkerEl(m.id);
      if (dot) {
        ['marker-out-of-focus', 'marker-active', 'marker-hover'].forEach(cls => {
          if (dot.classList.contains(cls)) cardEl.classList.add(cls);
        });
      }
      cardEl.addEventListener('mouseenter', () => clearTimeout(hoverCardHideTimer));
      cardEl.addEventListener('mouseleave', () => _scheduleHideMerchantHoverCard());
      cardEl.addEventListener('click', (e) => {
        e.stopPropagation();
        setActive(m.id);
        setActiveItem(m.id);
        panTo(m.id, true);
        openModal(m);
      });
    }

    hoverCardMarker = new maplibregl.Marker({
      element: wrapper,
      anchor:  'top',       // card sits below the lngLat, growing downward
      offset:  [0, 12],     // 12 px gap between dot bottom and card top
    })
      .setLngLat(entry.lngLat)
      .addTo(map);
    hoverCardMerchantId = m.id;
  }

  function _scheduleHideMerchantHoverCard() {
    clearTimeout(hoverCardHideTimer);
    hoverCardHideTimer = setTimeout(_hideMerchantHoverCard, 180);
  }

  function _hideMerchantHoverCard() {
    clearTimeout(hoverCardHideTimer);
    if (hoverCardMarker) {
      hoverCardMarker.remove();
      hoverCardMarker = null;
      hoverCardMerchantId = null;
    }
  }

  function getMarkerEl(merchantId) {
    return document.querySelector(`.merchant-dot[data-merchant-id="${merchantId}"]`);
  }

  function updateMarkerElement(id, action, cls) {
    const el = getMarkerEl(id);
    if (!el) return;
    if (action === 'add') el.classList.add(cls);
    else el.classList.remove(cls);
    // Mirror onto the merchant hover card if it happens to be open for this id.
    if (hoverCardMerchantId === id && hoverCardMarker) {
      const cardEl = hoverCardMarker.getElement().querySelector('.rc');
      if (cardEl) {
        if (action === 'add') cardEl.classList.add(cls);
        else cardEl.classList.remove(cls);
      }
    }
  }

  function setActive(merchantId) {
    resetMarkerStates();
    activeMerchantId = merchantId;
    Object.keys(markers).forEach(id => {
      const nid = Number(id);
      if (nid === merchantId) {
        updateMarkerElement(nid, 'add', 'marker-active');
        updateMarkerElement(nid, 'remove', 'marker-out-of-focus');
      } else {
        updateMarkerElement(nid, 'add', 'marker-out-of-focus');
        updateMarkerElement(nid, 'remove', 'marker-active');
      }
    });
  }

  function resetMarkerStates() {
    activeMerchantId = null;
    Object.keys(markers).forEach(id => {
      const nid = Number(id);
      updateMarkerElement(nid, 'remove', 'marker-active');
      updateMarkerElement(nid, 'remove', 'marker-out-of-focus');
      updateMarkerElement(nid, 'remove', 'marker-hover');
    });
  }

  function resetAllStates() {
    resetMarkerStates();
    hideCard();
    resetListStates();
  }

  // Returns the pixel offset to apply when centering a merchant, so it ends up
  // in the visible strip between the focus sidebar (left) and the detail modal
  // (right). Values track the CSS: sidebar = 16+296 px, modal = 320+16 px.
  function _computeCenterShift(forModal) {
    const sidebarOpen = FocusMode.isActive();
    const leftPad  = sidebarOpen ? 312 : 0;
    const rightPad = forModal    ? 336 : 0;
    return (rightPad - leftPad) / 2;
  }

  function panTo(merchantId, offsetForModal = false) {
    const entry = markers[merchantId];
    if (!entry) return;
    const zoom = Math.max(map.getZoom(), 16);

    const shiftPx = _computeCenterShift(offsetForModal);
    if (shiftPx !== 0) {
      const targetPt = map.project(entry.lngLat);
      targetPt.x += shiftPx;
      const offsetLngLat = map.unproject([targetPt.x, targetPt.y]);
      map.flyTo({ center: [offsetLngLat.lng, offsetLngLat.lat], zoom, duration: 500 });
    } else {
      map.flyTo({ center: entry.lngLat, zoom, duration: 500 });
    }
  }

  function triggerRipple(merchantId) {
    const el = getMarkerEl(merchantId);
    if (!el) return;
    const ripple = document.createElement('div');
    ripple.className = 'ripple-ring';
    el.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  }

  // ---- Hover Card ----

  function photoSrc(merchant) {
    const pid = merchant.id > 100 ? merchant.id - 100 : merchant.id;
    return `assets/images/merchants/${pid}.png`;
  }

  function showCard(merchant, marker) {
    const card = document.getElementById('merchant-card');
    const now = new Date();
    const status = Status.getOpenStatus(merchant, now);
    const popularity = Status.getPopularity(merchant.stats.visits);

    document.getElementById('card-photo').innerHTML =
      `<img src="${photoSrc(merchant)}" alt="${merchant.name}" class="card-photo-img" onerror="this.parentElement.style.display='none'">`;

    const badgeEl = document.getElementById('card-badge');
    badgeEl.innerHTML = popularity.icon
      ? `<span class="merchant-popular-badge">${popularity.level === 'very-popular' ? 'Molt popular' : 'Popular'}</span>`
      : '';

    document.getElementById('card-name').textContent = merchant.name;
    document.getElementById('card-dish').textContent =
      merchant.dish.name + (merchant.dish.price ? ' · ' + merchant.dish.price : '');
    document.getElementById('card-address').innerHTML =
      `<i data-lucide="map-pin" class="lucide-sm"></i> ${merchant.address}`;
    lucide.createIcons({ attrs: { class: 'lucide-sm' }, nameAttr: 'data-lucide' });

    const statusEl = document.getElementById('card-status');
    statusEl.innerHTML = Status.getStatusBadge(status);
    statusEl.className = `card-status ${status.status}`;

    document.getElementById('card-tags').innerHTML = merchant.tags.map(t =>
      `<span class="card-tag">${Status.getTagLabel(t)}</span>`
    ).join('');

    document.getElementById('card-btn-route').onclick = (e) => {
      e.stopPropagation();
      openRoute(merchant);
    };
    document.getElementById('card-btn-detail').onclick = (e) => {
      e.stopPropagation();
      hideCard();
      panTo(merchant.id, true);
      openModal(merchant);
    };

    const entry = markers[merchant.id];
    const containerPt = map.project(entry ? entry.lngLat : marker.getLngLat().toArray());
    positionCard(card, containerPt.x, containerPt.y);

    card.classList.remove('hidden');
    card.classList.add('visible');
    card.onmouseenter = () => clearTimeout(cardHideTimeout);
    card.onmouseleave = () => { cardHideTimeout = setTimeout(() => hideCard(), 200); };
  }

  function positionCard(card, x, y) {
    const mapContainer = document.getElementById('map-container');
    const mapRect = mapContainer.getBoundingClientRect();
    const cardW = 300;
    const cardH = card.offsetHeight || 280;
    let left = x - cardW / 2;
    let top  = y - cardH - 28;
    if (left < 8) left = 8;
    if (left + cardW > mapRect.width - 8) left = mapRect.width - cardW - 8;
    if (top < 8) top = y + 28;
    card.style.left = `${mapRect.left + left}px`;
    card.style.top  = `${mapRect.top  + top}px`;
  }

  function hideCard() {
    const card = document.getElementById('merchant-card');
    card.classList.remove('visible');
    card.classList.add('hidden');
  }

  function openRoute(merchant) {
    const { lat, lng } = merchant.coordinates;
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, '_blank');
  }

  // ---- Sidebar ----

  function showSidebar(mode, evt) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    if (mode === 'zones')         _renderZonesList();
    else if (mode === 'focus' && evt) _renderFocusList(evt);
    sidebar.classList.remove('hidden-sidebar');
    void sidebar.offsetWidth;
    sidebar.classList.add('visible');
  }

  function hideSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    sidebar.classList.remove('visible');
    sidebar.classList.add('hidden-sidebar');
  }

  function _renderZonesList() {
    const inner = document.getElementById('sidebar-inner');
    if (!inner) return;
    const zones = EventZoneLayer.getZones();

    inner.innerHTML = `
      <div class="sb-header">
        <div class="sb-eyebrow">Descobreix</div>
        <div class="sb-title">Esdeveniments a la zona</div>
      </div>
      <div class="sb-list">
        ${zones.map(z => `
          <div class="sb-event-item" data-zone-id="${z.id}" style="--sb-color:${z.color}">
            <span class="sb-event-icon">${z.icon}</span>
            <div class="sb-event-info">
              <span class="sb-event-name">${z.name}</span>
              <span class="sb-event-meta">${z.subtitle} · ${z.merchants} establiments</span>
              <div class="sb-event-tags">
                ${z.tags.map(t =>
                  `<span class="rc-tag rc-tag--${TAG_CLASS_SB[t] || 'gastro'}">${t}</span>`
                ).join('')}
              </div>
            </div>
            <span class="sb-arrow">→</span>
          </div>
        `).join('')}
      </div>`;

    inner.querySelectorAll('.sb-event-item').forEach(item => {
      item.addEventListener('click', () => {
        const zone = zones.find(z => z.id === item.dataset.zoneId);
        if (!zone) return;
        // zone.centerTo is [lat, lng] per data convention; convert for MapLibre
        map.flyTo({
          center: [zone.centerTo[1], zone.centerTo[0]],
          zoom: zone.zoomTo,
          duration: 900,
        });

        if (MapMode.current === 'activitat') {
          const evt = zone.realEventId ? events.find(e => e.id === zone.realEventId) : null;
          if (evt) enterFocus(evt);
        } else {
          if (zone.realEventId) pendingFocusEventId = zone.realEventId;
        }
      });
    });
  }

  function _renderFocusList(evt) {
    const inner = document.getElementById('sidebar-inner');
    if (!inner) return;
    const now = new Date();

    const zone = EventZoneLayer.getZones().find(z => z.realEventId === evt.id);

    const interestHtml = zone?.interest ? `
      <div class="sb-focus-interest">
        <div class="rc-interest-track">
          <div class="rc-interest-fill" style="width:${zone.interest}%;background:${evt.color}"></div>
        </div>
        <span class="sb-focus-interest-val" style="color:${evt.color}">${zone.interest}% interès</span>
      </div>` : '';

    const tagsHtml = zone?.tags?.length ? `
      <div class="rc-tags sb-focus-tags">
        ${zone.tags.map(t => {
          const cls = TAG_CLASS_SB[t] || 'gastro';
          return `<span class="rc-tag rc-tag--${cls}">${t}</span>`;
        }).join('')}
      </div>` : '';

    const statsHtml = `
      <div class="sb-focus-stats">
        <div class="sb-focus-stat">
          <span class="sb-focus-stat-num">${evt.merchants.length}</span>
          <span class="sb-focus-stat-lbl">establiments</span>
        </div>
        ${zone?.participants ? `
        <div class="sb-focus-stat">
          <span class="sb-focus-stat-num">${zone.participants}</span>
          <span class="sb-focus-stat-lbl">participants</span>
        </div>` : ''}
      </div>`;

    const merchantsHtml = evt.merchants.map(m => {
      const status = Status.getOpenStatus(m, now);
      const popularity = Status.getPopularity(m.stats?.visits ?? 0);
      const pid = m.id > 100 ? m.id - 100 : m.id;
      const photo = `assets/images/merchants/${pid}.png`;
      const dish = m.dish?.name
        ? (m.dish.price ? `${m.dish.name} · ${m.dish.price}` : m.dish.name)
        : '';
      const mTagsHtml = (m.tags || []).slice(0, 2)
        .map(t => `<span class="sb-mcard-tag">${Status.getTagLabel(t)}</span>`).join('');
      const popularHtml = popularity.icon
        ? `<span class="sb-mcard-popular">${popularity.label}</span>` : '';

      return `
        <div class="sb-merchant-card" data-merchant-id="${m.id}">
          <div class="sb-mcard-photo" style="background-image:url('${photo}')"></div>
          <div class="sb-mcard-body">
            <div class="sb-mcard-top">
              <span class="sb-mcard-name">${m.name}</span>
              <span class="sb-mcard-signal sb-mcard-signal--${status.status}"></span>
            </div>
            ${dish ? `<div class="sb-mcard-dish">${dish}</div>` : ''}
            <div class="sb-mcard-footer">
              <span class="sb-mcard-status sb-mcard-status--${status.status}">${status.label}</span>
              ${popularHtml}
              ${mTagsHtml}
            </div>
          </div>
        </div>`;
    }).join('');

    inner.innerHTML = `
      <button class="sb-back-btn" id="sb-back-btn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5M12 5l-7 7 7 7"/>
        </svg>
        Tots els esdeveniments
      </button>
      <div class="sb-focus-hero" style="--focus-color:${evt.color}">
        <div class="sb-focus-hero-top">
          <span class="sb-focus-hero-icon">${evt.icon}</span>
          <div class="sb-focus-hero-title">
            <span class="sb-focus-hero-name">${evt.name}</span>
            ${evt.location ? `<span class="sb-focus-hero-loc">${evt.location}</span>` : ''}
          </div>
        </div>
        ${evt.description ? `<p class="sb-focus-hero-desc">${evt.description}</p>` : ''}
        ${statsHtml}
        ${interestHtml}
        ${tagsHtml}
      </div>
      <div class="sb-section-label">Establiments participants</div>
      <div class="sb-list">${merchantsHtml}</div>`;

    document.getElementById('sb-back-btn')?.addEventListener('click', () => {
      FocusMode.exit();
    });

    inner.querySelectorAll('.sb-merchant-card').forEach(item => {
      const id = Number(item.dataset.merchantId);
      item.addEventListener('click', () => {
        const merchant = allMerchants.find(m => m.id === id);
        if (!merchant) return;
        setActive(id);
        setActiveItem(id);
        panTo(id, true);
        openModal(merchant);
      });
      item.addEventListener('mouseenter', () => {
        if (activeMerchantId !== null) return;
        updateMarkerElement(id, 'add', 'marker-hover');
      });
      item.addEventListener('mouseleave', () => {
        updateMarkerElement(id, 'remove', 'marker-hover');
      });
    });
  }

  // ---- Sidebar list state ----

  function setActiveItem(merchantId) {
    activeMerchantId = merchantId;
    document.querySelectorAll('.sb-merchant-card').forEach(item => {
      const id = Number(item.dataset.merchantId);
      item.classList.toggle('active', id === merchantId);
      item.classList.toggle('out-of-focus', id !== merchantId);
    });
    hideCard();
    document.querySelector(`.sb-merchant-card[data-merchant-id="${merchantId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function resetListStates() {
    activeMerchantId = null;
    document.querySelectorAll('.sb-merchant-card').forEach(item => {
      item.classList.remove('active', 'out-of-focus');
    });
  }

  function highlightListItem(merchantId) {
    document.querySelectorAll('.sb-merchant-card').forEach(el => el.classList.remove('hover-from-map'));
    const item = document.querySelector(`.sb-merchant-card[data-merchant-id="${merchantId}"]`);
    if (item) {
      item.classList.add('hover-from-map');
      item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function unhighlightListItem() {
    document.querySelectorAll('.sb-merchant-card.hover-from-map')
      .forEach(el => el.classList.remove('hover-from-map'));
  }

  // ---- Stats ----

  function updateOpenCount() {
    const count = Status.countOpen(allMerchants);
    const el = document.getElementById('open-count');
    if (el) el.textContent = count;
  }

  // ---- Live counters ----

  function startLiveCounters() {
    let explorers = 8;

    setInterval(() => {
      const change = Math.random() > 0.5 ? 1 : -1;
      explorers = Math.max(3, Math.min(15, explorers + change));
      const el = document.getElementById('explorers-count');
      if (!el) return;
      el.style.opacity = '0';
      setTimeout(() => { el.textContent = explorers; el.style.opacity = '1'; }, 150);
    }, 4000);

    setInterval(updateOpenCount, 60000);

    setInterval(() => {
      const now = new Date();
      document.querySelectorAll('.sb-merchant-card').forEach(item => {
        const id = Number(item.dataset.merchantId);
        const merchant = allMerchants.find(m => m.id === id);
        if (!merchant) return;
        const status = Status.getOpenStatus(merchant, now);
        const statusEl = item.querySelector('.sb-mcard-status');
        if (!statusEl) return;
        statusEl.className = `sb-mcard-status sb-mcard-status--${status.status}`;
        statusEl.textContent = status.label;
        const signalEl = item.querySelector('.sb-mcard-signal');
        if (signalEl) {
          signalEl.className = `sb-mcard-signal sb-mcard-signal--${status.status}`;
        }
      });
    }, 60000);
  }

  // ---- Ripple loop ----

  function startRippleLoop() {
    function doRipple() {
      const popular = allMerchants.filter(m => m.stats.visits > 10);
      if (popular.length === 0) return;
      const rand = popular[Math.floor(Math.random() * popular.length)];
      triggerRipple(rand.id);
    }
    setInterval(() => {
      setTimeout(doRipple, 7000 + Math.random() * 3000);
    }, 10000);
  }

  // ---- Modal (thin wrappers over shared DetailDrawer) ----

  function openModal(merchant) {
    DetailDrawer.open(merchant, merchantEventMap[merchant.id]);
  }

  function closeModal() {
    DetailDrawer.close();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Two-level Escape: close modal first (keep focus active), then exit focus
    const drawer = document.getElementById('detail-drawer');
    if (drawer && !drawer.classList.contains('detail-drawer--hidden')) {
      closeModal();
      return;
    }
    if (FocusMode.isActive()) { FocusMode.exit(); return; }
  });

  // ---- Mobile bottom sheet drag ----

  function initBottomSheet() {
    const sidebar = document.getElementById('sidebar');
    const handle  = document.getElementById('sidebar-handle');
    if (!sidebar || !handle || window.innerWidth > 768) return;

    let startY = 0;
    let startH = 0;

    handle.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
      startH = sidebar.offsetHeight;
    }, { passive: true });

    handle.addEventListener('touchmove', (e) => {
      const dy = startY - e.touches[0].clientY;
      const newH = Math.max(80, Math.min(window.innerHeight * 0.85, startH + dy));
      sidebar.style.height = `${newH}px`;
    }, { passive: true });

    handle.addEventListener('touchend', () => {
      const h = sidebar.offsetHeight;
      const vh = window.innerHeight;
      if (h < vh * 0.25)       sidebar.style.height = '80px';
      else if (h < vh * 0.60)  sidebar.style.height = `${Math.round(vh * 0.45)}px`;
      else                      sidebar.style.height = `${Math.round(vh * 0.80)}px`;
    });
  }

  // ---- Public ----

  return { init };
})();

// Boot
document.addEventListener('DOMContentLoaded', () => {
  Explore.init();

  setTimeout(() => {
    const sidebar = document.getElementById('sidebar');
    const handle  = document.getElementById('sidebar-handle');
    if (!sidebar || !handle || window.innerWidth > 768) return;
  }, 0);
});
