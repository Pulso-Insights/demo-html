// ===== HierarchyLayer: territorial polygon layers (MapLibre GL JS) =====
// Two levels:
//   regional  (zoom 6-10)  → 4 Catalan provinces  (provinces-cat.json)
//   municipal (zoom 11-13) → Barcelona municipalities (municipalities-bcn.json)

const HierarchyLayer = (() => {
  let map  = null;
  let data = {};

  let activeLevel   = null;          // 'regional' | 'municipal' | null
  let activeGhost   = null;          // levelKey currently in ghost mode
  let activeMarkers = [];            // [{marker, p}] — maplibregl.Marker instances
  let cardElements  = new Map();     // feature code → .rc DOM element
  let overlapTimer  = null;
  let moveHandler   = null;
  let hoveredCode   = null;
  // When the cursor is over a card (DOM marker stacked above the canvas), mouse
  // events still bubble to the map container and MapLibre's layer-specific
  // mousemove fires for any polygon that happens to be below the card. This
  // flag lets us ignore those events so hovering card A can't expand card B.
  let overCardCode  = null;

  const COLOR = '#FF6B00';

  const SRC = { regional: 'hierarchy-regional', municipal: 'hierarchy-municipal' };
  const FILL = { regional: 'hierarchy-regional-fill', municipal: 'hierarchy-municipal-fill' };
  const LINE = { regional: 'hierarchy-regional-line', municipal: 'hierarchy-municipal-line' };

  // ---- Demo data overlays ----

  const PROVINCE_DEMO = {
    '34090800000': {
      events: 12, municipalities: 4, participants: 312, interest: 92,
      tags: ['Gastronòmic', 'Cultural', 'Festa Major'],
      zoomTo: 11, centerTo: [41.44, 2.16],
    },
    '34091700000': {
      events: 4,  municipalities: 2, participants: 84,  interest: 64,
      tags: ['Gastronòmic', 'Mercat'],
      zoomTo: 12, centerTo: [41.98, 2.82], labelOffset: [0.45, 0],
    },
    '34092500000': {
      events: 1,  municipalities: 1, participants: 28,  interest: 28,
      tags: ['Cultural'],
      zoomTo: 12, centerTo: [41.62, 1.00],
    },
    '34094300000': {
      events: 3,  municipalities: 1, participants: 62,  interest: 51,
      tags: ['Gastronòmic', 'Festa Major'],
      zoomTo: 12, centerTo: [41.12, 1.25], labelOffset: [0.40, 0],
    },
  };

  const MUNI_DEMO = {
    '34090808101': { events: 2, active: true,  tags: ['Gastronòmic', 'Mercat'], zoomTo: 14, centerTo: [41.3585, 2.0997] },
    '34090808019': { events: 1, active: false, tags: ['Gastronòmic'],           zoomTo: 14, centerTo: [41.3851, 2.1734] },
    '34090808187': { events: 1, active: false, tags: ['Cultural'],              zoomTo: 14, centerTo: [41.5456, 2.1088] },
    '34090808015': { events: 1, active: false, tags: ['Festa Major'],           zoomTo: 14, centerTo: [41.4494, 2.2426] },
  };

  // ---- Style computation ----
  // Each feature gets precomputed _fillOpacity, _lineOpacity, _lineWidth so paint
  // expressions can read them via ['get', ...] — much simpler than case chains.

  function computeStyle(events, level) {
    if (level === 'municipal') {
      if (events >= 2) return { fillOpacity: 0.50, lineOpacity: 1.00, lineWidth: 2   };
      if (events >= 1) return { fillOpacity: 0.28, lineOpacity: 0.85, lineWidth: 1.5 };
      return              { fillOpacity: 0.03, lineOpacity: 0.30, lineWidth: 1   };
    }
    if (events >= 12) return { fillOpacity: 0.55, lineOpacity: 1.00, lineWidth: 2   };
    if (events >= 4)  return { fillOpacity: 0.35, lineOpacity: 0.80, lineWidth: 2   };
    if (events >= 1)  return { fillOpacity: 0.20, lineOpacity: 0.60, lineWidth: 1.5 };
    return                   { fillOpacity: 0.04, lineOpacity: 0.22, lineWidth: 1   };
  }

  // ---- Init ----

  async function init(mlMap) {
    map = mlMap;

    let provGeo, muniGeo;
    try {
      const [provResp, muniResp] = await Promise.all([
        fetch('assets/data/provinces-cat.json'),
        fetch('assets/data/municipalities-bcn.json'),
      ]);
      if (!provResp.ok) throw new Error(`provinces fetch: HTTP ${provResp.status}`);
      if (!muniResp.ok) throw new Error(`municipalities fetch: HTTP ${muniResp.status}`);
      [provGeo, muniGeo] = await Promise.all([provResp.json(), muniResp.json()]);
    } catch (e) {
      console.error('HierarchyLayer init failed:', e);
      return;
    }

    enrichFeatures(provGeo, PROVINCE_DEMO, 'regional');
    enrichFeatures(muniGeo, MUNI_DEMO, 'municipal');

    data.regional  = provGeo;
    data.municipal = muniGeo;

    // Register sources (data stays cached; only visibility toggles)
    map.addSource(SRC.regional,  { type: 'geojson', data: provGeo, promoteId: 'code' });
    map.addSource(SRC.municipal, { type: 'geojson', data: muniGeo, promoteId: 'code' });

    ['regional', 'municipal'].forEach(level => {
      map.addLayer({
        id: FILL[level],
        type: 'fill',
        source: SRC[level],
        layout: { visibility: 'none' },
        paint: {
          'fill-color': COLOR,
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            ['min', ['+', ['coalesce', ['get', '_fillOpacity'], 0.04], 0.15], 0.75],
            ['coalesce', ['get', '_fillOpacity'], 0.04],
          ],
        },
      });
      map.addLayer({
        id: LINE[level],
        type: 'line',
        source: SRC[level],
        layout: { visibility: 'none' },
        paint: {
          'line-color': COLOR,
          'line-opacity': ['coalesce', ['get', '_lineOpacity'], 0.22],
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            ['+', ['coalesce', ['get', '_lineWidth'], 1], 0.5],
            ['coalesce', ['get', '_lineWidth'], 1],
          ],
        },
      });
    });

    // Wire hover/click on both fill layers
    ['regional', 'municipal'].forEach(level => {
      const fillId = FILL[level];

      map.on('mousemove', fillId, (e) => {
        // While over a card, layer-specific events still fire because they
        // bubble up to the map container. Suppress them so the hovered card
        // stays uniquely highlighted.
        if (overCardCode != null) return;
        if (!e.features.length) return;
        const code = e.features[0].id;
        if (hoveredCode === code) return;
        if (hoveredCode != null) {
          _setHover(level, hoveredCode, false);
          cardElements.get(String(hoveredCode))?.classList.remove('rc--open');
        }
        hoveredCode = code;
        _setHover(level, code, true);
        cardElements.get(String(code))?.classList.add('rc--open');
      });

      map.on('mouseleave', fillId, () => {
        if (hoveredCode != null) {
          _setHover(level, hoveredCode, false);
          cardElements.get(String(hoveredCode))?.classList.remove('rc--open');
        }
        hoveredCode = null;
      });

      map.on('click', fillId, (e) => {
        if (!e.features.length) return;
        e.originalEvent.preventDefault();
        const code = String(e.features[0].id);
        const feature = data[level].features.find(f => String(f.properties.code) === code);
        if (feature) flyToFeature(feature.properties);
      });
    });

    console.log(
      `HierarchyLayer ready — provinces: ${provGeo.features.length}, municipalities: ${muniGeo.features.length}`
    );
  }

  function _setHover(level, code, on) {
    if (code == null) return;
    map.setFeatureState({ source: SRC[level], id: code }, { hover: on });
  }

  function enrichFeatures(geojson, demoMap, level) {
    geojson.features.forEach(f => {
      const extra = demoMap[f.properties.code] || {};
      const props = { ...f.properties, events: 0, interest: 0, active: false, tags: [], ...extra };
      const s = computeStyle(props.events || 0, level);
      props._fillOpacity = s.fillOpacity;
      props._lineOpacity = s.lineOpacity;
      props._lineWidth   = s.lineWidth;
      f.properties = props;
    });
  }

  // ---- Visibility ----

  function _clearCards() {
    if (moveHandler) {
      map.off('moveend', moveHandler);
      moveHandler = null;
    }
    if (overlapTimer) {
      clearTimeout(overlapTimer);
      overlapTimer = null;
    }
    activeMarkers.forEach(({ marker }) => marker.remove());
    activeMarkers = [];
    cardElements.clear();
    hoveredCode = null;
    overCardCode = null;
  }

  function _hideAllLayers() {
    ['regional', 'municipal'].forEach(level => {
      if (map.getLayer(FILL[level])) map.setLayoutProperty(FILL[level], 'visibility', 'none');
      if (map.getLayer(LINE[level])) map.setLayoutProperty(LINE[level], 'visibility', 'none');
    });
  }

  function _showLevelLayers(level, ghost) {
    ['regional', 'municipal'].forEach(lv => {
      const show = lv === level;
      if (map.getLayer(FILL[lv])) {
        map.setLayoutProperty(FILL[lv], 'visibility', show ? 'visible' : 'none');
        if (show) {
          map.setPaintProperty(FILL[lv], 'fill-opacity', ghost
            ? 0.03
            : [
                'case',
                ['boolean', ['feature-state', 'hover'], false],
                ['min', ['+', ['coalesce', ['get', '_fillOpacity'], 0.04], 0.15], 0.75],
                ['coalesce', ['get', '_fillOpacity'], 0.04],
              ]);
        }
      }
      if (map.getLayer(LINE[lv])) {
        map.setLayoutProperty(LINE[lv], 'visibility', show ? 'visible' : 'none');
        if (show) {
          map.setPaintProperty(LINE[lv], 'line-opacity', ghost ? 0.18 : ['coalesce', ['get', '_lineOpacity'], 0.22]);
          map.setPaintProperty(LINE[lv], 'line-width',   ghost ? 1    : [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            ['+', ['coalesce', ['get', '_lineWidth'], 1], 0.5],
            ['coalesce', ['get', '_lineWidth'], 1],
          ]);
        }
      }
    });
  }

  function setMode(mode) {
    _clearCards();
    activeGhost = null;

    const levelKey = (mode === 'regional') ? 'regional' : (mode === 'municipal') ? 'municipal' : null;
    if (!levelKey) { _hideAllLayers(); activeLevel = null; return; }
    activeLevel = levelKey;

    const geojson = data[levelKey];
    if (!geojson) {
      console.warn(`HierarchyLayer.setMode('${mode}'): data not loaded yet`);
      return;
    }

    _showLevelLayers(levelKey, false);

    // Place cards at centroids, sorted by events desc for staggered animation
    const sorted = [...geojson.features]
      .filter(f => f.properties.centroid && (levelKey === 'regional' || f.properties.events > 0))
      .sort((a, b) => (b.properties.events || 0) - (a.properties.events || 0));

    sorted.forEach((feature, idx) => {
      const p = feature.properties;
      const [lng, lat] = p.centroid;
      const labelLat   = lat + (p.labelOffset ? p.labelOffset[0] : 0);
      const labelLng   = lng + (p.labelOffset ? p.labelOffset[1] : 0);

      const wrapper = document.createElement('div');
      wrapper.className = 'rc-wrapper';
      wrapper.innerHTML = buildCardHtml(p, levelKey, idx * 60);

      const marker = new maplibregl.Marker({
        element: wrapper,
        anchor: 'center',
      })
        .setLngLat([labelLng, labelLat])
        .addTo(map);

      const card = wrapper.querySelector('.rc');
      if (card) {
        cardElements.set(String(p.code), card);

        // When the cursor enters the card (a DOM marker stacked above the canvas),
        // the canvas stops receiving mousemove, so MapLibre's fillId 'mouseleave'
        // may not fire reliably. Clear polygon hover state here so the card's own
        // :hover CSS takes over cleanly, and collapsing works on leave.
        card.addEventListener('mouseenter', () => {
          wrapper.style.setProperty('z-index', '1000', 'important');
          overCardCode = p.code;
          if (hoveredCode != null && activeLevel) {
            _setHover(activeLevel, hoveredCode, false);
            cardElements.get(String(hoveredCode))?.classList.remove('rc--open');
            hoveredCode = null;
          }
        });
        card.addEventListener('mouseleave', () => {
          wrapper.style.removeProperty('z-index');
          if (overCardCode === p.code) overCardCode = null;
        });

        if (p.centerTo && p.zoomTo) {
          card.addEventListener('click', e => {
            e.stopPropagation();
            flyToFeature(p);
          });
        }
      }

      activeMarkers.push({ marker, p });
    });

    overlapTimer = setTimeout(() => {
      resolveCardOverlaps();
      overlapTimer = null;
    }, 120);

    moveHandler = () => resolveCardOverlaps();
    map.on('moveend', moveHandler);

    console.log(`HierarchyLayer: showing ${levelKey} layer (${geojson.features.length} features)`);
  }

  function flyToFeature(p) {
    if (!p.centerTo || !p.zoomTo) return;

    // From regional → municipal: fit tight to all active municipalities
    // (events > 0) so we never cut off a card at the edge of the viewport.
    // Falls back to centerTo/zoomTo if the province has no active children
    // in the loaded municipal dataset.
    if (activeLevel === 'regional' && p.zoomTo <= 13 && data.municipal) {
      const munis = data.municipal.features.filter(
        f => (f.properties.events || 0) > 0 && f.properties.centroid
      );
      if (munis.length > 0) {
        const bounds = new maplibregl.LngLatBounds();
        munis.forEach(f => bounds.extend(f.properties.centroid));
        // Cards are centered on their centroid and can grow ~160px tall when
        // hovered — give generous asymmetric padding so the northernmost card
        // (Sabadell) isn't clipped on either collapsed or expanded states.
        map.fitBounds(bounds, {
          padding: { top: 180, bottom: 140, left: 160, right: 160 },
          maxZoom: 13,
          duration: 1200,
        });
        return;
      }
    }

    // p.centerTo is [lat, lng] by existing data convention — convert for MapLibre.
    map.flyTo({
      center: [p.centerTo[1], p.centerTo[0]],
      zoom: p.zoomTo,
      duration: 1200,
    });
  }

  // Fit the camera tight around all features of a level. Useful on initial load.
  function fitToLevel(levelKey, opts = {}) {
    const geojson = data[levelKey];
    if (!geojson) return;
    const bounds = new maplibregl.LngLatBounds();
    let empty = true;
    const extend = (coords) => {
      if (typeof coords[0] === 'number') { bounds.extend(coords); empty = false; }
      else coords.forEach(extend);
    };
    geojson.features.forEach(f => { if (f.geometry?.coordinates) extend(f.geometry.coordinates); });
    if (empty) return;
    map.fitBounds(bounds, { padding: 60, duration: 0, ...opts });
  }

  // ---- Overlap resolution ----

  function resolveCardOverlaps() {
    const CARD_W = 200;
    const CARD_H = 72;
    const PAD    = 12;

    const items = activeMarkers.map(({ marker, p }) => {
      const lngLat = marker.getLngLat();
      return {
        pt:     map.project([lngLat.lng, lngLat.lat]),
        el:     marker.getElement().querySelector('.rc'),
        events: p.events || 0,
      };
    }).filter(x => x.el);

    items.forEach(x => x.el.classList.remove('rc--suppressed'));

    const suppressed = new Set();
    for (let i = 0; i < items.length; i++) {
      if (suppressed.has(i)) continue;
      for (let j = i + 1; j < items.length; j++) {
        if (suppressed.has(j)) continue;
        const dx = Math.abs(items[i].pt.x - items[j].pt.x);
        const dy = Math.abs(items[i].pt.y - items[j].pt.y);
        if (dx < CARD_W + PAD && dy < CARD_H + PAD) {
          suppressed.add(j);
        }
      }
    }

    suppressed.forEach(i => items[i].el.classList.add('rc--suppressed'));
  }

  // ---- Card HTML (Revent Card primitive — .rc) ----

  const TAG_CLASS = {
    'Gastronòmic': 'gastro',
    'Cultural':    'cultural',
    'Festa Major': 'festa',
    'Mercat':      'mercat',
  };

  function buildTagsHtml(tags) {
    if (!tags || !tags.length) return '';
    const pills = tags.map(t => {
      const cls = TAG_CLASS[t] || 'gastro';
      return `<span class="rc-tag rc-tag--${cls}">${t}</span>`;
    }).join('');
    return `<div class="rc-tags">${pills}</div>`;
  }

  function pickAccent(tags) {
    if (!tags || !tags.length) return 'gastro';
    return TAG_CLASS[tags[0]] || 'gastro';
  }

  function buildCardHtml(p, level, animDelay) {
    const evtCount   = p.events || 0;
    const isLive     = evtCount > 0;
    const isRegional = level === 'regional';
    const levelLabel = isRegional ? 'Província' : 'Municipi';
    const accent     = pickAccent(p.tags);

    // Summary: "N events · N municipis" (regional) or "N events actius" (municipal)
    let summaryHtml = '';
    if (isLive) {
      if (isRegional) {
        const muniPart = p.municipalities
          ? `<span class="rc-summary-sep"></span><span><strong>${p.municipalities}</strong> municipis</span>`
          : '';
        summaryHtml = `
          <div class="rc-summary">
            <span><strong>${evtCount}</strong> event${evtCount !== 1 ? 's' : ''}</span>
            ${muniPart}
          </div>`;
      } else {
        summaryHtml = `
          <div class="rc-summary">
            <span><strong>${evtCount}</strong> event${evtCount !== 1 ? 's' : ''} actiu${evtCount !== 1 ? 's' : ''}</span>
          </div>`;
      }
    } else {
      summaryHtml = `<div class="rc-summary"><span>Sense activitat</span></div>`;
    }

    // Body (hover / open): interest bar + tags
    const tagsHtml = buildTagsHtml(p.tags);
    const interestHtml = (isLive && p.interest)
      ? `<div class="rc-interest">
           <div class="rc-interest-track"><div class="rc-interest-fill" style="width:${p.interest}%"></div></div>
           <div class="rc-interest-val">${p.interest}%</div>
         </div>`
      : '';
    const bodyHtml = (isLive && (interestHtml || tagsHtml))
      ? `<div class="rc-body">${interestHtml}${tagsHtml}</div>`
      : '';

    const hintHtml = (p.centerTo && p.zoomTo)
      ? `<div class="rc-hint">Clic per explorar
           <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h6M7 3l3 3-3 3"/></svg>
         </div>`
      : '';

    const liveHtml = isLive ? '<div class="rc-live" aria-label="En viu"></div>' : '';

    return `
      <div class="rc rc--sm" data-accent="${accent}" data-events="${evtCount}"
           style="--rc-d:${animDelay}ms">
        <div class="rc-head">
          <div class="rc-title-block">
            <div class="rc-name">${p.name}</div>
            <div class="rc-sub">${levelLabel}</div>
          </div>
          ${liveHtml}
        </div>
        ${summaryHtml}
        ${bodyHtml}
        ${hintHtml}
      </div>`;
  }

  // ---- Ghost mode (faint polygon outlines, no cards — used during 'zones' level) ----

  function setGhost(levelKey) {
    _clearCards();
    activeGhost = levelKey;
    _showLevelLayers(levelKey, true);
  }

  function hide() {
    _clearCards();
    _hideAllLayers();
    activeLevel = null;
    activeGhost = null;
  }

  return { init, setMode, setGhost, hide, fitToLevel };
})();
