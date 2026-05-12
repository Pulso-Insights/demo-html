// build-events: generates events-murcia.json — a flat list of synthetic
// events across the province of Murcia, weighted by population.
//
// Uses real, iconic regional events (Bando de la Huerta, Carthagineses y
// Romanos, Caballos del Vino, Semana Santa de Lorca, etc.) padded with
// generic local activities. Coordinates are jittered around each
// municipality's centroid (from municipalities-murcia.json).
//
// Deterministic output: seeded PRNG so re-running produces identical files.
//
// Usage: node build-events.js

const fs = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'assets', 'data');
const MUNI_IN  = path.join(DATA_DIR, 'municipalities-murcia.json');
const OUT      = path.join(DATA_DIR, 'events-murcia.json');

// ---- Seeded PRNG (mulberry32) ----
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(0xC0FFEE);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// Approximate population (thousands) for weighting and demographics.
// Source: INE 2024 (rounded).
const POPULATION = {
  'Murcia': 462, 'Cartagena': 217, 'Lorca': 96, 'Molina de Segura': 73,
  'Alcantarilla': 42, 'Mazarrón': 36, 'Cieza': 35, 'Águilas': 35,
  'Yecla': 35, 'Torre-Pacheco': 39, 'San Javier': 33, 'Totana': 32,
  'San Pedro del Pinatar': 26, 'Jumilla': 27, 'Caravaca de la Cruz': 25,
  'Alhama de Murcia': 22, 'Archena': 19, 'Mula': 17, 'Los Alcázares': 17,
  'Fuente Álamo de Murcia': 16, 'Bullas': 12, 'Calasparra': 10, 'Beniel': 11,
  'Abarán': 13, 'Las Torres de Cotillas': 21, 'Ceutí': 11, 'Lorquí': 7,
  'Santomera': 16, 'Moratalla': 8, 'Abanilla': 6, 'Blanca': 7,
  'Puerto Lumbreras': 14, 'Pliego': 4, 'Albudeite': 1, 'Aledo': 1,
  'Alguazas': 9, 'Campos del Río': 2, 'Cehegín': 16, 'Fortuna': 10,
  'Ojós': 0.5, 'Pliego': 4, 'Ricote': 1, 'Ulea': 1, 'Villanueva del Río Segura': 3,
};

// Real, iconic events of the Region of Murcia. Each entry is anchored to a
// specific municipality and (where useful) has approximate dates.
// Many of these are Fiestas de Interés Turístico Internacional / Nacional.
const ANCHORED_EVENTS = [
  // Murcia capital
  { name: 'Bando de la Huerta',          muni: 'Murcia',                month: 4,  type: 'cultural',  scale: 'L' },
  { name: 'Entierro de la Sardina',      muni: 'Murcia',                month: 4,  type: 'cultural',  scale: 'L' },
  { name: 'Murcia Tres Culturas',        muni: 'Murcia',                month: 5,  type: 'musical',   scale: 'M' },
  { name: 'WAM Estrella de Levante',     muni: 'Murcia',                month: 6,  type: 'musical',   scale: 'L' },
  { name: 'Feria de Murcia',             muni: 'Murcia',                month: 9,  type: 'fiesta',    scale: 'L' },
  { name: 'Festival Internacional de Folklore', muni: 'Murcia',         month: 8,  type: 'cultural',  scale: 'M' },
  { name: 'IBAFF — Festival de Cinema',  muni: 'Murcia',                month: 3,  type: 'cine',      scale: 'S' },

  // Cartagena
  { name: 'Carthagineses y Romanos',     muni: 'Cartagena',             month: 9,  type: 'historico', scale: 'L' },
  { name: 'La Mar de Músicas',           muni: 'Cartagena',             month: 7,  type: 'musical',   scale: 'L' },
  { name: 'La Mar de Cines',             muni: 'Cartagena',             month: 7,  type: 'cine',      scale: 'S' },
  { name: 'Semana Santa de Cartagena',   muni: 'Cartagena',             month: 4,  type: 'religioso', scale: 'L' },
  { name: 'Mucho Más Mayo',              muni: 'Cartagena',             month: 5,  type: 'cultural',  scale: 'M' },

  // Lorca — STAR EVENT lives here (placeholder for now)
  { name: 'Semana Santa de Lorca',       muni: 'Lorca',                 month: 4,  type: 'religioso', scale: 'L', star: true },
  { name: 'Feria de Lorca',              muni: 'Lorca',                 month: 9,  type: 'fiesta',    scale: 'M' },
  { name: 'Lorca, Taller del Tiempo',    muni: 'Lorca',                 month: 10, type: 'cultural',  scale: 'S' },
  { name: 'Festival Internacional de Folclore Ciudad del Sol', muni: 'Lorca', month: 8, type: 'cultural', scale: 'M' },

  // Caravaca
  { name: 'Caballos del Vino',           muni: 'Caravaca de la Cruz',   month: 5,  type: 'historico', scale: 'L' },
  { name: 'Bandos Moros y Cristianos',   muni: 'Caravaca de la Cruz',   month: 5,  type: 'historico', scale: 'M' },

  // Yecla
  { name: 'Moros y Cristianos de Yecla', muni: 'Yecla',                 month: 12, type: 'historico', scale: 'M' },
  { name: 'Feria del Vino de Yecla',     muni: 'Yecla',                 month: 8,  type: 'gastronomico', scale: 'S' },

  // Jumilla
  { name: 'Fiesta de la Vendimia',       muni: 'Jumilla',               month: 8,  type: 'gastronomico', scale: 'M' },
  { name: 'Cabalgata de los Reyes Magos',muni: 'Jumilla',               month: 1,  type: 'cultural',  scale: 'S' },

  // Águilas
  { name: 'Carnaval de Águilas',         muni: 'Águilas',               month: 2,  type: 'fiesta',    scale: 'L' },
  { name: 'Festival Cope Águilas',       muni: 'Águilas',               month: 8,  type: 'musical',   scale: 'S' },

  // Cieza / Valle del Ricote
  { name: 'Floración del Valle del Ricote', muni: 'Cieza',              month: 3,  type: 'natural',   scale: 'M' },
  { name: 'Semana Santa de Cieza',       muni: 'Cieza',                 month: 4,  type: 'religioso', scale: 'M' },

  // Mazarrón / costa
  { name: 'Bahía de Mazarrón Música',    muni: 'Mazarrón',              month: 7,  type: 'musical',   scale: 'S' },
  { name: 'Fiestas del Milagro',         muni: 'Mazarrón',              month: 11, type: 'fiesta',    scale: 'S' },

  // San Javier / Mar Menor
  { name: 'Festival Internacional de Jazz de San Javier', muni: 'San Javier', month: 7, type: 'musical', scale: 'M' },
  { name: 'Festival Internacional de Teatro, Música y Danza', muni: 'San Javier', month: 8, type: 'cultural', scale: 'M' },

  // Calasparra
  { name: 'Fiesta del Arroz',            muni: 'Calasparra',            month: 11, type: 'gastronomico', scale: 'S' },

  // Bullas
  { name: 'Cata del Barrio de la Estación', muni: 'Bullas',             month: 6,  type: 'gastronomico', scale: 'S' },

  // Totana
  { name: 'Festival de Cerámica',        muni: 'Totana',                month: 10, type: 'cultural',  scale: 'S' },
  { name: 'Romería de Santa Eulalia',    muni: 'Totana',                month: 1,  type: 'religioso', scale: 'M' },

  // Alhama
  { name: 'Música a la Luz de las Velas',muni: 'Alhama de Murcia',      month: 7,  type: 'musical',   scale: 'S' },

  // Archena
  { name: 'Festival Internacional Sal a Escena', muni: 'Molina de Segura', month: 5, type: 'cultural', scale: 'S' },

  // Cehegín
  { name: 'Festival de Música Antigua',  muni: 'Cehegín',               month: 6,  type: 'musical',   scale: 'S' },

  // Moratalla
  { name: 'Encierros de Moratalla',      muni: 'Moratalla',             month: 7,  type: 'fiesta',    scale: 'M' },

  // Fortuna
  { name: 'Festival de Música Mediterránea', muni: 'Fortuna',           month: 8,  type: 'musical',   scale: 'S' },

  // Mula
  { name: 'Tamboradas de Mula',          muni: 'Mula',                  month: 4,  type: 'cultural',  scale: 'M' },

  // Puerto Lumbreras
  { name: 'Festival de los Caminos del Sureste', muni: 'Puerto Lumbreras', month: 9, type: 'cultural', scale: 'S' },
];

// Generic activities to pad density (mercados, conciertos locales, etc.).
const GENERIC_EVENTS = [
  { template: 'Mercado Artesano',          type: 'mercado',     scale: 'S' },
  { template: 'Feria Gastronómica',        type: 'gastronomico',scale: 'S' },
  { template: 'Festival de Tapas',         type: 'gastronomico',scale: 'S' },
  { template: 'Concierto de Música',       type: 'musical',     scale: 'S' },
  { template: 'Ruta del Vino',             type: 'gastronomico',scale: 'S' },
  { template: 'Encuentro de Artesanos',    type: 'mercado',     scale: 'S' },
  { template: 'Festival de Cortometrajes', type: 'cine',        scale: 'S' },
  { template: 'Feria del Libro',           type: 'cultural',    scale: 'S' },
  { template: 'Procesión',                 type: 'religioso',   scale: 'S' },
];

// Type → color + Lucide icon name + label.
// Icon names are resolved at render time via Lucide (https://lucide.dev/icons).
const TYPE_STYLE = {
  cultural:     { color: '#7C3AED', icon: 'theater',        label: 'Cultural' },
  musical:      { color: '#E11D48', icon: 'music',          label: 'Música' },
  historico:    { color: '#92400E', icon: 'swords',         label: 'Histórico' },
  religioso:    { color: '#4338CA', icon: 'church',         label: 'Religioso' },
  fiesta:       { color: '#F59E0B', icon: 'party-popper',   label: 'Fiesta' },
  gastronomico: { color: '#DC2626', icon: 'wine',           label: 'Gastronomía' },
  mercado:      { color: '#0F7B3E', icon: 'shopping-bag',   label: 'Mercado' },
  cine:         { color: '#0EA5E9', icon: 'film',           label: 'Cine' },
  natural:      { color: '#16A34A', icon: 'flower-2',       label: 'Natural' },
  deportivo:    { color: '#0891B2', icon: 'trophy',         label: 'Deporte' },
};

const SCALE_ATTENDANCE = {
  L: () => 5000 + Math.floor(rand() * 25000),
  M: () => 1200 + Math.floor(rand() *  4500),
  S: () => 150  + Math.floor(rand() *   900),
};

// ---- Helpers ----

function jitter(lng, lat, kmRadius) {
  // ~111km per degree latitude
  const dLat = (kmRadius / 111) * (rand() * 2 - 1);
  const dLng = (kmRadius / (111 * Math.cos(lat * Math.PI / 180))) * (rand() * 2 - 1);
  return [+(lng + dLng).toFixed(6), +(lat + dLat).toFixed(6)];
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function genDates(year, month, scale) {
  const day = 1 + Math.floor(rand() * 24);
  const span = scale === 'L' ? 4 + Math.floor(rand()*7) : scale === 'M' ? 2 + Math.floor(rand()*4) : 1 + Math.floor(rand()*2);
  const endDay = Math.min(day + span, 28);
  return { start: isoDate(year, month, day), end: isoDate(year, month, endDay) };
}

// ---- Main ----

function main() {
  const muniGeo = JSON.parse(fs.readFileSync(MUNI_IN, 'utf8'));
  const muniByName = {};
  muniGeo.features.forEach(f => { muniByName[f.properties.name] = f; });

  const events = [];
  const year = 2026;
  let nextId = 1;

  // Anchored events
  for (const a of ANCHORED_EVENTS) {
    const m = muniByName[a.muni];
    if (!m) {
      console.warn(`Skip anchored: municipio "${a.muni}" no encontrado`);
      continue;
    }
    const [lng, lat] = m.properties.centroid;
    const coords = jitter(lng, lat, 0.6);
    const style = TYPE_STYLE[a.type] || TYPE_STYLE.cultural;
    const attendance = SCALE_ATTENDANCE[a.scale]();

    events.push({
      id: `evt-${String(nextId++).padStart(3, '0')}`,
      name: a.name,
      type: a.type,
      typeLabel: style.label,
      icon: style.icon,
      color: style.color,
      municipality: a.muni,
      municipalityCode: m.properties.code,
      coordinates: { lng: coords[0], lat: coords[1] },
      dates: genDates(year, a.month, a.scale),
      scale: a.scale,
      attendance,
      isStar: !!a.star,
    });
  }

  // Padding: generic events sampled by population weight
  const popMunis = muniGeo.features
    .map(f => ({ name: f.properties.name, code: f.properties.code, centroid: f.properties.centroid, w: POPULATION[f.properties.name] || 2 }))
    .filter(x => x.w > 0);
  const totalW = popMunis.reduce((s, x) => s + Math.sqrt(x.w), 0); // sqrt to flatten the distribution

  const TARGET = 65;
  const remaining = Math.max(0, TARGET - events.length);

  for (let i = 0; i < remaining; i++) {
    // weighted pick
    let r = rand() * totalW;
    let muni = popMunis[0];
    for (const p of popMunis) {
      r -= Math.sqrt(p.w);
      if (r <= 0) { muni = p; break; }
    }

    const template = pick(GENERIC_EVENTS);
    const style = TYPE_STYLE[template.type];
    const month = 1 + Math.floor(rand() * 12);
    const attendance = SCALE_ATTENDANCE[template.scale]();
    const [lng, lat] = jitter(muni.centroid[0], muni.centroid[1], 0.8);

    events.push({
      id: `evt-${String(nextId++).padStart(3, '0')}`,
      name: `${template.template} de ${muni.name}`,
      type: template.type,
      typeLabel: style.label,
      icon: style.icon,
      color: style.color,
      municipality: muni.name,
      municipalityCode: muni.code,
      coordinates: { lng, lat },
      dates: genDates(year, month, template.scale),
      scale: template.scale,
      attendance,
      isStar: false,
    });
  }

  // Aggregate counts per municipality for the HierarchyLayer MUNI_DEMO config.
  const byMuni = {};
  for (const e of events) {
    const key = e.municipalityCode;
    if (!byMuni[key]) byMuni[key] = { name: e.municipality, events: 0, attendance: 0, tags: new Set() };
    byMuni[key].events += 1;
    byMuni[key].attendance += e.attendance;
    byMuni[key].tags.add(e.typeLabel);
  }
  const muniDemo = {};
  Object.entries(byMuni).forEach(([code, v]) => {
    muniDemo[code] = {
      events: v.events,
      active: v.events >= 2,
      tags: [...v.tags].slice(0, 3),
      attendance: v.attendance,
    };
  });

  // Province-level aggregate
  const provCode = muniGeo.features[0]?.properties.prov;
  const provinceDemo = {
    [`3409${provCode}00000`]: {
      events:         events.length,
      municipalities: Object.keys(muniDemo).length,
      participants:   events.reduce((s, e) => s + e.attendance, 0),
      interest:       Math.min(99, 60 + Math.floor(events.length * 0.6)),
      tags:           ['Cultural', 'Gastronómico', 'Histórico'],
      zoomTo:         9,
      centerTo:       [38.00, -1.48], // [lat, lng]
    },
  };

  const out = {
    meta: {
      generated_at: new Date().toISOString(),
      total: events.length,
      starEventId: events.find(e => e.isStar)?.id,
      types: Object.fromEntries(Object.entries(TYPE_STYLE).map(([k, v]) => [k, { color: v.color, icon: v.icon, label: v.label }])),
    },
    events,
    aggregations: {
      byMunicipality: muniDemo,
      byProvince:     provinceDemo,
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`✓ ${path.relative(ROOT, OUT)} — ${events.length} events across ${Object.keys(muniDemo).length} municipalities`);
  console.log(`  ${ANCHORED_EVENTS.length} anchored (real), ${events.length - ANCHORED_EVENTS.length} generic`);
  console.log(`  star event: ${events.find(e => e.isStar)?.name} (${events.find(e => e.isStar)?.id})`);

  // Top 5 municipalities by event count
  const top = Object.entries(byMuni).sort((a, b) => b[1].events - a[1].events).slice(0, 8);
  console.log('\nTop municipalities by event count:');
  for (const [, v] of top) console.log(`  ${v.name.padEnd(25)} ${v.events} events`);
}

main();
