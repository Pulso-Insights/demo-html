// build-config: emits assets/js/config/pulso-config-murcia.js
//
// Bundles all region-specific knobs (data URLs, map centers, hierarchy demo
// overlays, event-zone definitions, dashboard actions) into a single script
// that sets window.PULSO_CONFIG before the page's other JS runs.
//
// Inputs:
//   assets/data/municipalities-murcia.json
//   assets/data/events-murcia.json
//
// Output:
//   assets/js/config/pulso-config-murcia.js

const fs = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'assets', 'data');
const OUT_DIR  = path.join(ROOT, 'assets', 'js', 'config');
const OUT      = path.join(OUT_DIR, 'pulso-config-murcia.js');

fs.mkdirSync(OUT_DIR, { recursive: true });

const muniGeo = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'municipalities-murcia.json'), 'utf8'));
const events  = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'events-murcia.json'), 'utf8'));

const muniByCode = {};
muniGeo.features.forEach(f => { muniByCode[f.properties.code] = f; });

// Build MUNI_DEMO: merge aggregated counts with centroid-based centerTo/zoomTo.
// HierarchyLayer expects centerTo as [lat, lng] (existing data convention).
const LORCA_CASCO = [-1.6967, 37.6706]; // [lng, lat] — Plaza de España, Lorca
const muniDemo = {};
Object.entries(events.aggregations.byMunicipality).forEach(([code, v]) => {
  const f = muniByCode[code];
  if (!f) return;
  const isLorca = f.properties.name === 'Lorca';
  // Lorca: aim the camera at the casco histórico, not the rural muni centroid.
  const [lng, lat] = isLorca ? LORCA_CASCO : f.properties.centroid;
  muniDemo[code] = {
    events:   v.events,
    active:   v.active,
    tags:     v.tags,
    zoomTo:   14,
    centerTo: [lat, lng],
  };
});

// Build PROVINCE_DEMO from the aggregations
const provinceDemo = {};
Object.entries(events.aggregations.byProvince).forEach(([code, v]) => {
  provinceDemo[code] = {
    events:         v.events,
    municipalities: v.municipalities,
    participants:   v.participants,
    interest:       v.interest,
    tags:           v.tags,
    zoomTo:         v.zoomTo,
    centerTo:       v.centerTo,
  };
});

// (LORCA_CASCO is defined earlier when building muniDemo.)

// Star event for EventZoneLayer (intermediate zoom 14 view)
const star = events.events.find(e => e.isStar) || events.events[0];

const eventZones = [
  {
    id:           'semana-santa-lorca',
    realEventId:  'semana-santa-lorca-2026',
    name:         star.name,
    subtitle:     'Lorca · Casco histórico',
    icon:         star.icon,
    color:        star.color,
    tags:         ['Cultural', 'Religioso'],
    merchants:    12,
    participants: star.attendance,
    interest:     96,
    // points are used as fallback if no precomputed isochrone matches.
    // For Lorca we cluster around the casco histórico:
    points: [
      [37.6712, -1.6969],
      [37.6720, -1.6960],
      [37.6705, -1.6975],
      [37.6730, -1.6985],
      [37.6700, -1.6955],
    ],
    radius:   0.40,
    zoomTo:   15,
    centerTo: [37.6706, -1.6967], // [lat, lng] per existing convention
  },
];

// Dashboard demo actions (campaigns) — adapted to Semana Santa de Lorca
const dashboardActions = [
  {
    id: 1, type: 'launch', icon: 'rocket',
    name: 'Apertura de Domingo de Ramos',
    desc: 'Notificación de inicio a usuarios próximos al casco histórico',
    zone: 'walk_15', status: 'sent', date: '29/03',
    reach: 38600, sent: 12420, opened: 7240, clicks: 2180,
  },
  {
    id: 2, type: 'reminder', icon: 'bell',
    name: 'Procesión Bíblico-Pasional',
    desc: 'Recordatorio para el desfile principal del Viernes Santo',
    zone: 'transit_15', status: 'sent', date: '03/04',
    reach: 142000, sent: 38400, opened: 18200, clicks: 6840,
  },
  {
    id: 3, type: 'promo', icon: 'tag',
    name: 'Tribunas oficiales 2x1',
    desc: 'Oferta combinada con museos del Paso Azul y Paso Blanco',
    zone: 'walk_30', status: 'sent', date: '01/04',
    reach: 56400, sent: 18600, opened: 9120, clicks: 3940,
  },
  {
    id: 4, type: 'reminder', icon: 'bell',
    name: 'Última noche — Procesión del Resucitado',
    desc: 'Recordatorio para la procesión final del Domingo de Resurrección',
    zone: 'transit_30', status: 'scheduled', date: '05/04',
    reach: 312000, sent: null, opened: null, clicks: null,
  },
];

const config = {
  region: 'murcia',
  starEventId: 'semana-santa-lorca-2026',
  eventColor:  star.color,

  dataUrls: {
    provinces:        'assets/data/provinces-murcia.json',
    municipalities:   'assets/data/municipalities-murcia.json',
    events:           'assets/data/events-murcia.json',
    starMerchants:    'assets/data/evento-lorca-merchants.json',
    starIsochrones:   'assets/data/evento-lorca-isochrones.json',
    starInfluenceZone:'assets/data/evento-lorca-influence-zone.geojson',
    starGeointel:     'assets/data/evento-lorca-geointel.json',
  },

  map: {
    centerRegional: [-1.48, 38.00], // [lng, lat] — province centroid
    zoomRegional:   9,
    centerStar:     LORCA_CASCO,    // [lng, lat] — Plaza de España, Lorca
  },

  hierarchy: {
    color: '#A06A4B',  // terracota Pulso — distingue de la demo BCN naranja
    provinceDemo,
    muniDemo,
    strings: {
      regional:        'Provincia',
      municipal:       'Municipio',
      municipalities:  'municipios',
      event:           'evento',
      eventPlural:     'eventos',
      active:          'activo',
      activePlural:    'activos',
      noActivity:      'Sin actividad',
      exploreHint:     'Clic para explorar',
    },
  },

  eventZones,
  dashboardActions,
};

const banner = `// Auto-generated by scripts/build-murcia-data/build-config.js.
// DO NOT EDIT BY HAND — re-run \`node scripts/build-murcia-data/build-config.js\`.
// Sets window.PULSO_CONFIG for the Murcia demo (read by hierarchy.js, explore/main.js,
// dashboard/main.js, dashboard/map.js, event-zone-layer.js, events-overlay.js).`;

const body = `window.PULSO_CONFIG = ${JSON.stringify(config, null, 2)};\n`;

fs.writeFileSync(OUT, `${banner}\n${body}`);
console.log(`✓ ${path.relative(ROOT, OUT)} — ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
console.log(`  region:     ${config.region}`);
console.log(`  star event: ${config.starEventId}`);
console.log(`  muni demo:  ${Object.keys(muniDemo).length} municipalities`);
console.log(`  prov demo:  ${Object.keys(provinceDemo).length} provinces`);
console.log(`  zones:      ${eventZones.length}`);
console.log(`  actions:    ${dashboardActions.length}`);
