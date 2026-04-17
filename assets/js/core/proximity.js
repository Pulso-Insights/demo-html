// ===== Proximity =====
// Isochrone abstraction + rendering for nearme (and future modes).
//
// Shape returned by getIsochrone():
//   { type: 'polygon', geojson, mode, minutes }   // precomputed (from JSON)
//   { type: 'circle',  center, radiusMeters, mode, minutes }  // saved place fallback
//   { type: 'radar',   center, radiusMeters, mode, minutes }  // ad-hoc current position
//
// filterByIsochrone + renderIsochroneLayer don't care which variant they get:
// polygon → point-in-polygon, circle/radar → distance-to-center.
//
// Dashed stroke marks approximated isochrones (circle/radar); solid stroke is
// kept for the day we plug in real precomputed polygons.

const Proximity = (() => {
  const SPEEDS_KMH = {
    walk:    4.5,
    transit: 12,
  };

  const ISO_SOURCE = 'iso-halo';
  const ISO_FILL   = 'iso-halo-fill';
  const ISO_LINE   = 'iso-halo-line';
  const ISO_LABEL_COUNT = 4;          // labels placed at cardinal points
  const MODE_ICON_NAMES = { walk: 'footprints', transit: 'bus' };
  let   ISO_LABEL_MARKERS = [];       // maplibregl.Marker[] (DOM overlays)

  function _radiusMeters(mode, minutes) {
    const speed = SPEEDS_KMH[mode] || SPEEDS_KMH.walk;
    return (minutes / 60) * speed * 1000;
  }

  function walkMinutes(from, to, mode = 'walk') {
    const km = turf.distance(
      [from.lng, from.lat],
      [to.lng,   to.lat],
      { units: 'kilometers' }
    );
    const speed = SPEEDS_KMH[mode] || SPEEDS_KMH.walk;
    return (km / speed) * 60;
  }

  function walkMeters(from, to) {
    return turf.distance(
      [from.lng, from.lat],
      [to.lng,   to.lat],
      { units: 'meters' }
    );
  }

  function getIsochrone(location, mode, minutes) {
    if (!location) return null;
    const center = [location.coordinates.lng, location.coordinates.lat];

    if (location.isCurrent) {
      return {
        type: 'radar',
        center,
        radiusMeters: _radiusMeters(mode, minutes),
        mode, minutes,
      };
    }

    const precomputed = location.isochrones?.[mode]?.[String(minutes)];
    // Only trust the slot if it's a fully hydrated GeoJSON Feature/Geometry.
    // Strings (unresolved paths from user-locations.json) fall through to the
    // circle fallback so turf.* never chokes on them.
    if (precomputed && typeof precomputed === 'object' && precomputed.type) {
      return { type: 'polygon', geojson: precomputed, mode, minutes };
    }

    return {
      type: 'circle',
      center,
      radiusMeters: _radiusMeters(mode, minutes),
      mode, minutes,
    };
  }

  function filterByIsochrone(merchants, iso) {
    if (!iso) return [];
    if (iso.type === 'polygon') {
      return merchants.filter(m => {
        const pt = turf.point([m.coordinates.lng, m.coordinates.lat]);
        return turf.booleanPointInPolygon(pt, iso.geojson);
      });
    }
    return merchants.filter(m => {
      const d = turf.distance(
        iso.center,
        [m.coordinates.lng, m.coordinates.lat],
        { units: 'meters' }
      );
      return d <= iso.radiusMeters;
    });
  }

  // Normalize bearing to a CSS rotation that keeps text upright (viewport-aligned).
  //   tangentBearing → css rotation, flipped 180° if it'd be upside-down.
  function _uprightRotation(tangentBearing) {
    let rot = (tangentBearing - 90) % 360;   // east tangent → 0°
    if (rot < 0) rot += 360;
    if (rot > 90 && rot < 270) rot -= 180;
    return rot;
  }

  // Returns a Feature<LineString> for the longest outer ring in a
  // Feature<Polygon|MultiPolygon>, or null if the input is unusable.
  function _outerRingLine(feat) {
    const geom = feat?.geometry || feat;
    if (!geom) return null;
    if (geom.type === 'Polygon') {
      return turf.lineString(geom.coordinates[0]);
    }
    if (geom.type === 'MultiPolygon') {
      let best = null, bestLen = -1;
      for (const poly of geom.coordinates) {
        const outer = poly[0];
        if (!outer || outer.length < 2) continue;
        const ls = turf.lineString(outer);
        const len = turf.length(ls, { units: 'kilometers' });
        if (len > bestLen) { bestLen = len; best = ls; }
      }
      return best;
    }
    return null;
  }

  function _computeIsoLabelPoints(iso, count) {
    const labelText = `${iso.minutes} min`;
    const out = [];

    if (iso.type !== 'polygon') {
      // Circle / radar: sample at 45°, 135°, 225°, 315° (mid-quadrants).
      const rKm = iso.radiusMeters / 1000;
      const offset = 360 / count / 2;
      for (let i = 0; i < count; i++) {
        const bearingFromCenter = (offset + (360 / count) * i) % 360;
        const p = turf.destination(iso.center, rKm, bearingFromCenter, { units: 'kilometers' });
        // Tangent to the circle = radial + 90°
        const tangent = (bearingFromCenter + 90) % 360;
        out.push({
          coords: p.geometry.coordinates,
          label:  labelText,
          rotation: _uprightRotation(tangent),
        });
      }
      return out;
    }

    // Polygon (real GeoJSON isochrone): sample at equal arc-lengths and use the
    // direction of travel along the ring as the tangent. Same label contract.
    // For MultiPolygon we pick the longest outer ring since turf.along can't
    // walk a FeatureCollection (which is what polygonToLine returns for MP).
    const line = _outerRingLine(iso.geojson);
    if (!line) return out;
    const total = turf.length(line, { units: 'kilometers' });
    const step = total / count;
    const eps  = Math.min(0.02, total / 200);   // small forward step for tangent
    for (let i = 0; i < count; i++) {
      const d  = step * i + step / 2;
      const p  = turf.along(line, d, { units: 'kilometers' });
      const p2 = turf.along(line, Math.min(d + eps, total), { units: 'kilometers' });
      const tangent = turf.bearing(p, p2);
      out.push({
        coords: p.geometry.coordinates,
        label:  labelText,
        rotation: _uprightRotation(tangent),
      });
    }
    return out;
  }

  function _renderIsoLabels(map, iso) {
    ISO_LABEL_MARKERS.forEach(m => m.remove());
    ISO_LABEL_MARKERS = [];
    if (!iso) return;

    const variantClass = iso.type === 'radar' ? ' iso-label--radar' : '';
    const iconName = MODE_ICON_NAMES[iso.mode];
    const points = _computeIsoLabelPoints(iso, ISO_LABEL_COUNT);
    points.forEach(({ coords, label, rotation }) => {
      const el = document.createElement('div');
      el.className = 'iso-label' + variantClass;
      if (iconName) {
        el.innerHTML = `<i data-lucide="${iconName}" class="iso-label-icon"></i><span>${label}</span>`;
      } else {
        el.textContent = label;
      }
      const marker = new maplibregl.Marker({
        element: el,
        anchor:  'center',
        rotation,
        rotationAlignment: 'viewport',
      })
        .setLngLat(coords)
        .addTo(map);
      ISO_LABEL_MARKERS.push(marker);
    });
    if (window.lucide) lucide.createIcons();
  }

  function renderIsochroneLayer(map, iso) {
    if (!iso) { removeIsochroneLayer(map); return; }

    let polygon;
    if (iso.type === 'polygon') {
      polygon = iso.geojson;
    } else {
      polygon = turf.circle(iso.center, iso.radiusMeters / 1000, {
        steps: 96,
        units: 'kilometers',
      });
    }

    const feat = polygon.type === 'Feature'
      ? polygon
      : { type: 'Feature', properties: {}, geometry: polygon };
    feat.properties = { ...(feat.properties || {}), isoType: iso.type };

    const src = map.getSource(ISO_SOURCE);
    if (src) {
      src.setData(feat);
    } else {
      map.addSource(ISO_SOURCE, { type: 'geojson', data: feat });
      map.addLayer({
        id: ISO_FILL,
        type: 'fill',
        source: ISO_SOURCE,
        paint: {
          'fill-color': '#2563EB',
          'fill-opacity': 0.08,
        },
      });
      map.addLayer({
        id: ISO_LINE,
        type: 'line',
        source: ISO_SOURCE,
        paint: {
          'line-color': '#2563EB',
          'line-width': 1.5,
          'line-opacity': 0.5,
        },
      });
    }

    const isApprox = iso.type !== 'polygon';
    map.setPaintProperty(ISO_LINE, 'line-dasharray', isApprox ? [2, 2] : [1000, 0]);
    map.setPaintProperty(ISO_LINE, 'line-opacity',   isApprox ? 0.5     : 0.7);

    _renderIsoLabels(map, iso);
  }

  function removeIsochroneLayer(map) {
    [ISO_FILL, ISO_LINE].forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource(ISO_SOURCE)) map.removeSource(ISO_SOURCE);
    ISO_LABEL_MARKERS.forEach(m => m.remove());
    ISO_LABEL_MARKERS = [];
  }

  return {
    SPEEDS_KMH,
    walkMinutes, walkMeters,
    getIsochrone, filterByIsochrone,
    renderIsochroneLayer, removeIsochroneLayer,
  };
})();
