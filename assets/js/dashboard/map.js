/**
 * DashboardMap — Manages two MapLibre GL JS map instances:
 *   1. Digital map (#digital-map) — merchant markers + influence zone + heatmap layers
 *   2. Territory map (#terr-map)   — isochrone rings + merchant markers
 *
 * Basemap: OpenFreeMap "positron" (vector tiles, free, no API key).
 */
const DashboardMap = (() => {
  'use strict';

  const _CFG = (typeof window !== 'undefined' && window.PULSO_CONFIG) || {};
  const _URL = _CFG.dataUrls || {};
  const _MAP = _CFG.map      || {};

  const BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
  const CENTER = _MAP.centerStar || [2.110, 41.362]; // [lng, lat]

  let digitalMap = null;
  let terrMap = null;
  const isoLayers = {};   // key → { sourceId, fillId, lineId, baseStyle, geo }
  let activeIsoKey = null;
  let storedMerchants = null;

  const ISO_STYLES = {
    walk_5:      { color: '#FF6B00', fillOpacity: 0.22, lineWidth: 2.5, lineOpacity: 0.8 },
    walk_15:     { color: '#FF8C00', fillOpacity: 0.13, lineWidth: 1.5, lineOpacity: 0.6 },
    walk_30:     { color: '#FFA726', fillOpacity: 0.07, lineWidth: 1,   lineOpacity: 0.4 },
    transit_15:  { color: '#1976D2', fillOpacity: 0.13, lineWidth: 1.5, lineOpacity: 0.6 },
    transit_30:  { color: '#42A5F5', fillOpacity: 0.07, lineWidth: 1,   lineOpacity: 0.4 },
    transit_60:  { color: '#90CAF9', fillOpacity: 0.04, lineWidth: 0.75, lineOpacity: 0.3 },
  };

  const DIM_FACTOR = 0.35;

  // ── Init ────────────────────────────────────────────────────

  function init(isochronesGeoJson, merchantsData) {
    initDigitalMap(merchantsData);
    initTerrMap(isochronesGeoJson, merchantsData);
  }

  function _createMap(containerId, center, zoom, minZoom, maxZoom) {
    return new maplibregl.Map({
      container: containerId,
      style: BASEMAP_STYLE_URL,
      center, zoom, minZoom, maxZoom,
      attributionControl: false,
    });
  }

  // ── Digital Map ─────────────────────────────────────────────

  function initDigitalMap(merchantsData) {
    storedMerchants = merchantsData.events[0] ? merchantsData.events[0].merchants : [];
    digitalMap = _createMap('digital-map', CENTER, 14, 12, 18);
    digitalMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    digitalMap.once('load', () => {
      addMerchantMarkers(digitalMap, merchantsData);
      loadInfluenceZone(digitalMap, true);
      buildHeatLayers();
      setTimeout(() => digitalMap.resize(), 200);
    });
  }

  // ── Territory Map ───────────────────────────────────────────

  function initTerrMap(isochronesGeoJson, merchantsData) {
    terrMap = _createMap('terr-map', CENTER, 14, 11, 18);
    terrMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    terrMap.once('load', () => {
      addIsochroneRings(isochronesGeoJson);
      addMerchantMarkers(terrMap, merchantsData);
      loadInfluenceZone(terrMap);
      setTimeout(() => terrMap.resize(), 200);
    });
  }

  // ── Isochrone Rings (territory map only) ────────────────────

  function addIsochroneRings(geojson) {
    const ordered = [...geojson.features].sort((a, b) => b.properties.minutes - a.properties.minutes);

    ordered.forEach(feature => {
      const key = feature.properties.id;
      const baseStyle = ISO_STYLES[key] || ISO_STYLES.walk_5;

      const srcId  = `iso-src-${key}`;
      const fillId = `iso-fill-${key}`;
      const lineId = `iso-line-${key}`;

      terrMap.addSource(srcId, { type: 'geojson', data: feature });
      terrMap.addLayer({
        id: fillId, type: 'fill', source: srcId,
        paint: { 'fill-color': baseStyle.color, 'fill-opacity': baseStyle.fillOpacity },
      });
      terrMap.addLayer({
        id: lineId, type: 'line', source: srcId,
        paint: {
          'line-color': baseStyle.color,
          'line-opacity': baseStyle.lineOpacity,
          'line-width': baseStyle.lineWidth,
        },
      });

      isoLayers[key] = { srcId, fillId, lineId, baseStyle, geo: feature };

      terrMap.on('click', fillId, () => {
        if (window.Dashboard && window.Dashboard.selectIsochrone) {
          window.Dashboard.selectIsochrone(key);
        }
      });

      terrMap.on('mousemove', fillId, () => {
        if (activeIsoKey !== key) {
          terrMap.getCanvas().style.cursor = 'pointer';
          terrMap.setPaintProperty(fillId, 'fill-opacity', baseStyle.fillOpacity + 0.08);
          terrMap.setPaintProperty(lineId, 'line-width',   baseStyle.lineWidth + 0.5);
        }
      });

      terrMap.on('mouseleave', fillId, () => {
        terrMap.getCanvas().style.cursor = '';
        if (activeIsoKey !== key) applyDimStyle(key);
      });
    });
  }

  // ── Highlight isochrone ─────────────────────────────────────

  function highlightIsochrone(key) {
    activeIsoKey = key;

    Object.entries(isoLayers).forEach(([k, entry]) => {
      const base = ISO_STYLES[k];
      const { fillId, lineId } = entry;
      if (k === key) {
        terrMap.setPaintProperty(fillId, 'fill-opacity', Math.min(base.fillOpacity + 0.15, 0.45));
        terrMap.setPaintProperty(lineId, 'line-width',   base.lineWidth + 1.5);
        terrMap.setPaintProperty(lineId, 'line-opacity', Math.min(base.lineOpacity + 0.3, 1));
        // Bring highlighted to top
        if (terrMap.getLayer(fillId)) terrMap.moveLayer(fillId);
        if (terrMap.getLayer(lineId)) terrMap.moveLayer(lineId);
      } else {
        applyDimStyle(k);
      }
    });

    const entry = isoLayers[key];
    if (entry && terrMap) {
      const bounds = _geoJsonBounds(entry.geo);
      if (bounds) terrMap.fitBounds(bounds, { padding: 30, maxZoom: 16 });
    }
  }

  function applyDimStyle(key) {
    const base = ISO_STYLES[key];
    const entry = isoLayers[key];
    if (!entry || !base) return;
    terrMap.setPaintProperty(entry.fillId, 'fill-opacity', base.fillOpacity * DIM_FACTOR);
    terrMap.setPaintProperty(entry.lineId, 'line-width',   base.lineWidth * 0.7);
    terrMap.setPaintProperty(entry.lineId, 'line-opacity', base.lineOpacity * DIM_FACTOR);
  }

  // ── Shared helpers ──────────────────────────────────────────

  function addMerchantMarkers(map, merchantsData) {
    const event = merchantsData.events[0];
    if (!event) return;

    event.merchants.forEach(m => {
      const wrapper = document.createElement('div');
      wrapper.className = 'dash-marker-wrapper';
      wrapper.title = m.name; // native hover tooltip
      const dot = document.createElement('div');
      dot.className = 'dash-marker';
      wrapper.appendChild(dot);

      new maplibregl.Marker({ element: wrapper, anchor: 'center' })
        .setLngLat([m.coordinates.lng, m.coordinates.lat])
        .addTo(map);
    });
  }

  async function loadInfluenceZone(map, fitToZone) {
    try {
      const resp = await fetch(_URL.starInfluenceZone || 'assets/data/platillos-influence-zone.geojson');
      const geojson = await resp.json();

      const zoneColor = _CFG.eventColor || '#FF6B00';
      const srcId = 'influence-zone';
      map.addSource(srcId, { type: 'geojson', data: geojson });
      map.addLayer({
        id: 'influence-zone-fill', type: 'fill', source: srcId,
        paint: { 'fill-color': zoneColor, 'fill-opacity': 0.06 },
      });
      map.addLayer({
        id: 'influence-zone-line', type: 'line', source: srcId,
        paint: {
          'line-color': zoneColor,
          'line-opacity': 0.3,
          'line-width': 1.5,
          'line-dasharray': [6, 4],
        },
      });

      if (fitToZone) {
        const bounds = _geoJsonBounds(geojson);
        if (bounds) map.fitBounds(bounds, { padding: 10, maxZoom: 15 });
      }
    } catch (e) {
      console.warn('Could not load influence zone:', e);
    }
  }

  function _geoJsonBounds(geojson) {
    const bounds = new maplibregl.LngLatBounds();
    let empty = true;
    const extend = (coords) => {
      if (typeof coords[0] === 'number') {
        bounds.extend(coords);
        empty = false;
      } else {
        coords.forEach(extend);
      }
    };
    const features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
    features.forEach(f => { if (f.geometry?.coordinates) extend(f.geometry.coordinates); });
    return empty ? null : bounds;
  }

  function getIsoStyles() { return ISO_STYLES; }

  // ── Invalidate sizes (call after layout changes) ────────────

  function invalidate() {
    if (digitalMap) digitalMap.resize();
    if (terrMap) terrMap.resize();
  }

  // ── Heatmap layers (digital map only) ───────────────────────

  const HEAT_IDS = {};      // metricKey → { srcId, layerId }
  const HEAT_LABELS = {
    visits:   'Visites uniques',
    profiles: 'Visites a perfils',
    routes:   'Clics en ruta',
  };

  const METRIC_MAP = {
    visits:   m => m.stats.visits,
    profiles: m => m.stats.visits,
    routes:   m => m.stats.routes,
  };

  function mulberry32(seed) {
    return function() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Generate scattered heat points simulating user queries across the area.
  // Returns GeoJSON FeatureCollection of Point features with weight property.
  function generateHeatPoints(metricKey) {
    const getter = METRIC_MAP[metricKey] || METRIC_MAP.visits;
    const maxVal = Math.max(...storedMerchants.map(getter), 1);
    const rng = mulberry32(metricKey.length * 1337);
    const features = [];
    const push = (lat, lng, weight) => features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: { weight },
    });

    let cLat = 0, cLng = 0;
    storedMerchants.forEach(m => { cLat += m.coordinates.lat; cLng += m.coordinates.lng; });
    cLat /= storedMerchants.length;
    cLng /= storedMerchants.length;

    // 1) Points near merchants (~30%)
    storedMerchants.forEach(m => {
      const val = getter(m);
      const intensity = val / maxVal;
      const count = Math.max(4, Math.round(intensity * 15));
      const spread = 0.002;
      for (let i = 0; i < count; i++) {
        const u1 = rng(), u2 = rng();
        const r = Math.sqrt(-2 * Math.log(u1 || 0.001));
        const theta = 2 * Math.PI * u2;
        push(
          m.coordinates.lat + r * Math.cos(theta) * spread * 0.5,
          m.coordinates.lng + r * Math.sin(theta) * spread * 0.6,
          intensity * (0.5 + rng() * 0.5),
        );
      }
    });

    // 2) Dispersed (~70%)
    const dispersedCount = Math.round(storedMerchants.length * 12);
    for (let i = 0; i < dispersedCount; i++) {
      const u1 = rng(), u2 = rng();
      const r = Math.sqrt(-2 * Math.log(u1 || 0.001));
      const theta = 2 * Math.PI * u2;
      const spread = 0.012 + rng() * 0.008;
      push(
        cLat + r * Math.cos(theta) * spread * 0.5,
        cLng + r * Math.sin(theta) * spread * 0.6,
        0.1 + rng() * 0.4,
      );
    }

    // 3) Nearby dense clusters
    const clusterCenters = [
      [cLat + 0.008, cLng - 0.005],
      [cLat - 0.006, cLng + 0.008],
      [cLat + 0.003, cLng + 0.012],
    ];
    clusterCenters.forEach(([clLat, clLng]) => {
      const clusterSize = 8 + Math.round(rng() * 12);
      for (let i = 0; i < clusterSize; i++) {
        const u1 = rng(), u2 = rng();
        const r = Math.sqrt(-2 * Math.log(u1 || 0.001));
        const theta = 2 * Math.PI * u2;
        push(
          clLat + r * Math.cos(theta) * 0.003,
          clLng + r * Math.sin(theta) * 0.004,
          0.3 + rng() * 0.5,
        );
      }
    });

    return { type: 'FeatureCollection', features };
  }

  function buildHeatLayers() {
    if (!digitalMap || !storedMerchants.length) return;

    Object.keys(METRIC_MAP).forEach(key => {
      const fc = generateHeatPoints(key);
      const srcId = `heat-src-${key}`;
      const layerId = `heat-layer-${key}`;

      digitalMap.addSource(srcId, { type: 'geojson', data: fc });
      digitalMap.addLayer({
        id: layerId,
        type: 'heatmap',
        source: srcId,
        layout: { visibility: 'none' },
        paint: {
          'heatmap-weight': ['get', 'weight'],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 17, 3],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 12, 18, 17, 40],
          'heatmap-opacity': 0.85,
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0,    'rgba(255,224,178,0)',
            0.15, '#FFE0B2',
            0.4,  '#FFA726',
            0.65, '#FF6B00',
            0.85, '#E65100',
            1,    '#BF360C',
          ],
        },
      });

      HEAT_IDS[key] = { srcId, layerId };
    });

    digitalMap.addControl(new HeatControl(), 'bottom-left');
  }

  // Custom IControl matching Leaflet's L.Control.extend() semantics
  class HeatControl {
    onAdd(map) {
      this._map = map;
      const container = document.createElement('div');
      container.className = 'maplibregl-ctrl heat-toggle-bar';
      ['click', 'dblclick', 'wheel', 'mousedown', 'touchstart'].forEach(ev =>
        container.addEventListener(ev, e => e.stopPropagation())
      );

      Object.entries(HEAT_LABELS).forEach(([key, label]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'heat-toggle-btn';
        btn.textContent = label;
        btn.dataset.layer = key;
        btn.addEventListener('click', () => {
          const ids = HEAT_IDS[key];
          if (!ids || !map.getLayer(ids.layerId)) return;
          const isActive = btn.classList.contains('active');
          map.setLayoutProperty(ids.layerId, 'visibility', isActive ? 'none' : 'visible');
          btn.classList.toggle('active', !isActive);
        });
        container.appendChild(btn);
      });

      this._container = container;
      return container;
    }
    onRemove() {
      this._container.remove();
      this._map = undefined;
    }
  }

  return {
    init,
    highlightIsochrone,
    getIsoStyles,
    invalidate,
  };
})();
