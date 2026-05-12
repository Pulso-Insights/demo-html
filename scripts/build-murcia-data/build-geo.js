// build-geo: generates provinces-murcia.json + municipalities-murcia.json
// from the upstream Spanish topojson dataset.
//
// Schema mirrors provinces-cat.json / municipalities-bcn.json:
//   feature.properties = { name, code, prov, centroid: [lng,lat] }
//
// Code format follows the existing BCN convention: "3409" + PP + INECode (11 chars).
//
// Usage:
//   cd scripts/build-murcia-data && npm install && node build-geo.js

const fs = require('fs');
const path = require('path');
const https = require('https');
const topojson = require('topojson-client');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'assets', 'data');
const PROV_CODE = '30'; // Murcia (INE)
const SOURCE_PROVS = 'https://raw.githubusercontent.com/LuisSevillano/spanish-topojson-files/master/with-names/provinces.json';
const SOURCE_MUNIS = 'https://raw.githubusercontent.com/LuisSevillano/spanish-topojson-files/master/with-names/municipalities.json';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Ring area via shoelace formula; positive = counter-clockwise.
function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

// Centroid of a single polygon (ring 0 = outer).
function polygonCentroid(coords) {
  const ring = coords[0];
  let cx = 0, cy = 0, area = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
    area += f;
  }
  area /= 2;
  if (area === 0) return ring[0];
  return [cx / (6 * area), cy / (6 * area)];
}

// Centroid for Polygon or MultiPolygon: area-weighted average over rings.
function geomCentroid(geom) {
  if (geom.type === 'Polygon') {
    return polygonCentroid(geom.coordinates);
  }
  // MultiPolygon: pick the largest polygon's centroid (avoids exclaves dragging the label).
  let best = null;
  let bestArea = -Infinity;
  for (const poly of geom.coordinates) {
    const a = Math.abs(ringArea(poly[0]));
    if (a > bestArea) {
      bestArea = a;
      best = poly;
    }
  }
  return polygonCentroid(best);
}

function round(n, d = 5) {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

function makeCode(pp, ineCode) {
  // "3409" + PP + INECode  (matches BCN dataset format)
  return `3409${pp}${ineCode}`;
}

async function main() {
  console.log('Fetching upstream topojson...');
  const [provTopo, muniTopo] = await Promise.all([
    fetchJSON(SOURCE_PROVS),
    fetchJSON(SOURCE_MUNIS),
  ]);

  // --- Province ---
  const provs = topojson.feature(provTopo, provTopo.objects.provinces);
  const murcia = provs.features.find((f) => String(f.id) === PROV_CODE);
  if (!murcia) throw new Error('Murcia province not found in upstream data');

  const provCentroid = geomCentroid(murcia.geometry);
  const provOut = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name: 'Murcia',
          code: makeCode(PROV_CODE, '00000'),
          prov: PROV_CODE,
          centroid: [round(provCentroid[0]), round(provCentroid[1])],
        },
        geometry: murcia.geometry,
      },
    ],
  };

  const provPath = path.join(OUT_DIR, 'provinces-murcia.json');
  fs.writeFileSync(provPath, JSON.stringify(provOut));
  console.log(`✓ ${path.relative(process.cwd(), provPath)} — 1 feature`);

  // --- Municipalities ---
  const munis = topojson.feature(muniTopo, muniTopo.objects.municipalities);
  const murciaMunis = munis.features.filter((f) => String(f.id).startsWith(PROV_CODE));
  if (murciaMunis.length !== 45) {
    console.warn(`Expected 45 Murcia municipalities, got ${murciaMunis.length}`);
  }

  const muniFeatures = murciaMunis.map((f) => {
    const centroid = geomCentroid(f.geometry);
    return {
      type: 'Feature',
      properties: {
        name: f.properties.name,
        code: makeCode(PROV_CODE, String(f.id)),
        prov: PROV_CODE,
        centroid: [round(centroid[0]), round(centroid[1])],
      },
      geometry: f.geometry,
    };
  });

  // Sort by name for stable output
  muniFeatures.sort((a, b) => a.properties.name.localeCompare(b.properties.name, 'es'));

  const muniOut = { type: 'FeatureCollection', features: muniFeatures };
  const muniPath = path.join(OUT_DIR, 'municipalities-murcia.json');
  fs.writeFileSync(muniPath, JSON.stringify(muniOut));
  console.log(`✓ ${path.relative(process.cwd(), muniPath)} — ${muniFeatures.length} features`);

  // Print code map for downstream wiring
  console.log('\nINE → code map (for wiring PROVINCE_DEMO / MUNI_DEMO):');
  console.log(`  ${PROV_CODE} (Murcia)       → ${makeCode(PROV_CODE, '00000')}`);
  for (const f of muniFeatures.slice(0, 5)) {
    console.log(`  ${f.properties.name.padEnd(20)} → ${f.properties.code}`);
  }
  console.log(`  ... (${muniFeatures.length - 5} more)`);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
