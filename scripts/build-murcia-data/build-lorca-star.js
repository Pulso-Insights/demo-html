// build-lorca-star: generates the four files that power the "star event"
// detail view (dashboard + explore focus mode) for Semana Santa de Lorca.
//
// Outputs:
//   evento-lorca-merchants.json       — Event + POIs along the procession route
//   evento-lorca-isochrones.json      — Synthetic walk/transit contours
//   evento-lorca-influence-zone.geojson — Union of walk-5 contours
//   evento-lorca-geointel.json        — Territorial intelligence (demo numbers)
//
// All schemas mirror the existing platillos-*.json files so the dashboard
// and explore code can consume them via window.PULSO_CONFIG without changes.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'assets', 'data');

// ---- Casco histórico de Lorca: ~10 POIs along the procession route ----

const POIS = [
  { name: 'Colegiata de San Patricio',      address: 'Pl. de España, s/n',          lat: 37.67133, lng: -1.69677, type: 'iglesia',   tags: ['cultural','interes-nacional'] },
  { name: 'Iglesia de Santiago',            address: 'Pl. de Santiago, 6',          lat: 37.67257, lng: -1.69553, type: 'iglesia',   tags: ['cultural'] },
  { name: 'Iglesia de San Mateo',           address: 'Pl. de San Mateo, 2',         lat: 37.67452, lng: -1.69845, type: 'iglesia',   tags: ['cultural'] },
  { name: 'Iglesia del Carmen',             address: 'Pl. del Caño, s/n',           lat: 37.66889, lng: -1.69910, type: 'iglesia',   tags: ['cultural'] },
  { name: 'Iglesia de Santo Domingo',       address: 'Pl. del Cardenal Belluga',    lat: 37.67098, lng: -1.69810, type: 'iglesia',   tags: ['cultural'] },
  { name: 'Museo del Paso Azul (MASS)',     address: 'C. Nogalte, 7',               lat: 37.67152, lng: -1.69605, type: 'museo',     tags: ['paso-azul','bordados'] },
  { name: 'Museo del Paso Blanco (MUBBLA)', address: 'C. Santo Domingo, 4',         lat: 37.67075, lng: -1.69772, type: 'museo',     tags: ['paso-blanco','bordados'] },
  { name: 'Plaza de España',                address: 'Pl. de España',               lat: 37.67128, lng: -1.69690, type: 'punto',     tags: ['recorrido','centro'] },
  { name: 'Avenida Juan Carlos I',          address: 'Av. Juan Carlos I',           lat: 37.67541, lng: -1.69427, type: 'tribuna',   tags: ['recorrido','tribuna-oficial'] },
  { name: 'Castillo de Lorca',              address: 'Pa. del Castillo, s/n',       lat: 37.67648, lng: -1.69968, type: 'monumento', tags: ['cultural','mirador'] },
  { name: 'Plaza de Calderón',              address: 'Pl. de Calderón',             lat: 37.66999, lng: -1.69722, type: 'punto',     tags: ['recorrido'] },
  { name: 'Iglesia de San Francisco',       address: 'C. Núñez de Arce, 1',         lat: 37.67272, lng: -1.69789, type: 'iglesia',   tags: ['cultural','paso-azul'] },
];

const POI_TYPE_META = {
  iglesia:   { dish: 'Procesión',          desc: 'Punto de salida y llegada de cofradías.' },
  museo:     { dish: 'Exposición',         desc: 'Bordados, mantos, joyas y enseres procesionales.' },
  punto:     { dish: 'Punto del recorrido',desc: 'Tramo del itinerario procesional.' },
  tribuna:   { dish: 'Tribuna oficial',    desc: 'Asientos y palcos para presenciar el desfile.' },
  monumento: { dish: 'Mirador',            desc: 'Vista panorámica del casco histórico.' },
};

// ---- 1. Merchants file ----

function buildMerchants() {
  const merchants = POIS.map((p, i) => {
    const meta = POI_TYPE_META[p.type] || POI_TYPE_META.punto;
    const visits  = 1500 + Math.floor(Math.random() * 9000); // 1.5k–10.5k
    const routes  = Math.floor(visits * (0.35 + Math.random() * 0.20));
    return {
      id: i + 1,
      name: p.name,
      address: p.address,
      coordinates: { lat: p.lat, lng: p.lng },
      dish: {
        name: meta.dish,
        description: meta.desc,
        price: 'Acceso libre',
      },
      hours: {
        monday: 'closed', tuesday: 'closed', wednesday: 'closed',
        thursday: '18:00-23:00', friday: '17:00-00:00', saturday: '17:00-00:00', sunday: '17:00-23:00',
      },
      tags: p.tags,
      stats: { visits, routes },
    };
  });

  return {
    events: [
      {
        id: 'semana-santa-lorca-2026',
        name: 'Semana Santa de Lorca',
        edition: '2026',
        dates: { start: '2026-03-29', end: '2026-04-05' },
        location: 'Lorca',
        price: 'Acceso libre',
        description: 'Declarada de Interés Turístico Internacional. Procesiones bíblico-pasionales del Paso Azul y Paso Blanco, con bordados únicos en el mundo.',
        icon: 'church',
        color: '#4338CA',
        merchants,
      },
    ],
    meta: {
      total_visits_today: 18420,
      total_routes_today: 7680,
      current_explorers: 142,
    },
  };
}

// ---- 2. Isochrones (synthetic circles) ----
//
// Without route-go available we approximate with circles around the casco
// histórico centroid. Numbers picked to feel right for a city of ~96k.

const CENTER = { lat: 37.6706, lng: -1.6967 }; // Plaza de España, Lorca
const TURF_STEPS = 64;

function circle(centerLngLat, kmRadius, steps = TURF_STEPS) {
  const [lng0, lat0] = centerLngLat;
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    const dLat = (kmRadius / 111) * Math.sin(a);
    const dLng = (kmRadius / (111 * Math.cos(lat0 * Math.PI / 180))) * Math.cos(a);
    coords.push([+(lng0 + dLng).toFixed(6), +(lat0 + dLat).toFixed(6)]);
  }
  return { type: 'Polygon', coordinates: [coords] };
}

const CONTOURS = [
  { id: 'walk_5',     label: '5 min a pie',        mode: 'walk',    minutes: 5,  km: 0.4 },
  { id: 'walk_15',    label: '15 min a pie',       mode: 'walk',    minutes: 15, km: 1.2 },
  { id: 'walk_30',    label: '30 min a pie',       mode: 'walk',    minutes: 30, km: 2.4 },
  { id: 'transit_15', label: '15 min en coche',    mode: 'transit', minutes: 15, km: 6.0 },
  { id: 'transit_30', label: '30 min en coche',    mode: 'transit', minutes: 30, km: 18 },
  { id: 'transit_60', label: '60 min en coche',    mode: 'transit', minutes: 60, km: 50 },
];

function buildIsochrones() {
  const features = CONTOURS.map(c => ({
    type: 'Feature',
    properties: {
      id: c.id,
      label: c.label,
      merchant_count: POIS.length,
      minutes: c.minutes,
      mode: c.mode,
    },
    geometry: circle([CENTER.lng, CENTER.lat], c.km),
  }));
  return { type: 'FeatureCollection', features };
}

// ---- 3. Influence zone (use walk-5 as the union) ----

function buildInfluenceZone() {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          contour_minutes: 5,
          description: 'Walk-5 isochrone around Lorca historic centre',
          merchant_count: POIS.length,
          mode: 'walk',
        },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [circle([CENTER.lng, CENTER.lat], 0.4).coordinates],
        },
      },
    ],
  };
}

// ---- 4. Geointel ----

function buildGeointel() {
  return {
    totalPopulation: 28700, // casco histórico + pedanías limítrofes
    area: 4200000,          // m² ~4.2 km²
    density: 6833,
    method: 'building_weighted',
    totalFootfall: 102400,  // peak across Holy Week
    demographics: {
      totalPopulation: 28700,
      ageDistribution: {
        age0to15: 14.8, age16to24: 10.9, age25to34: 12.4,
        age35to44: 14.6, age45to54: 14.9, age55to64: 13.2, age65plus: 19.2,
      },
      medianAge: 44.7,
      meanAge: 43.1,
      malePercent: 48.6,
      femalePercent: 51.4,
      spanishPercent: 81.3,
      foreignPercent: 18.7,
    },
    income: {
      meanIncomePerPerson: 11800,
      medianIncomePerPerson: 10500,
      meanIncomePerHousehold: 28400,
      medianIncomePerHousehold: 25200,
      salaryPercent: 62.4,
      pensionPercent: 21.8,
      unemploymentPercent: 8.1,
      otherBenefitsPercent: 4.3,
      otherIncomePercent: 3.4,
      giniIndex: 0.36,
      p80p20: 4.2,
      year: 2024,
    },
    mobility: {
      dateFrom: '2026-03-29T00:00:00Z',
      dateTo:   '2026-04-05T23:59:59Z',
      visitorsTotal: 102400,
      visitorsLocal: 24300,
      visitorsRegional: 49800,
      visitorsNational: 22600,
      visitorsInternational: 5700,
      peakDay: '2026-04-03', // Viernes Santo
      peakHour: 22,
      avgStayMinutes: 168,
    },
    pois: {
      restaurants: 47,
      bars: 64,
      hotels: 12,
      parkings: 8,
      culturalSites: POIS.length,
    },
    weather: {
      avgTempC: 17.4,
      precipMm: 8.2,
      sunHoursDaily: 9.1,
    },
    airQuality: {
      avgPM25: 11.2,
      avgPM10: 23.7,
      avgNO2: 14.8,
      maxAQI: 62,
    },
    alerts: [
      { type: 'aforo',     level: 'medio', description: 'Saturación esperada Jueves y Viernes Santo en Av. Juan Carlos I' },
      { type: 'movilidad', level: 'alto',  description: 'Cortes de tráfico durante procesiones nocturnas' },
    ],
    score: 87,
    isochrones: {
      walk_5: { population: 9400, footfall: 38600, pois: 8 },
      walk_15: { population: 22100, footfall: 71200, pois: POIS.length },
      walk_30: { population: 28700, footfall: 102400, pois: POIS.length },
    },
  };
}

// ---- Write all ----

const merchants     = buildMerchants();
const isochrones    = buildIsochrones();
const influenceZone = buildInfluenceZone();
const geointel      = buildGeointel();

const files = [
  ['evento-lorca-merchants.json',           merchants,     false],
  ['evento-lorca-isochrones.json',          isochrones,    true],
  ['evento-lorca-influence-zone.geojson',   influenceZone, true],
  ['evento-lorca-geointel.json',            geointel,      false],
];

for (const [name, data, minify] of files) {
  const outPath = path.join(DATA_DIR, name);
  fs.writeFileSync(outPath, minify ? JSON.stringify(data) : JSON.stringify(data, null, 2));
  console.log(`✓ ${path.relative(process.cwd(), outPath)} — ${Buffer.byteLength(JSON.stringify(data))} bytes`);
}
