/**
 * Dashboard — Tactical dashboard orchestration.
 * Scrollable panel layout with two maps (digital + territory).
 */
const Dashboard = (() => {
  'use strict';

  const _CFG = (typeof window !== 'undefined' && window.PULSO_CONFIG) || {};
  const _URL = _CFG.dataUrls || {};

  let geointel = null;
  let isochrones = null;
  let merchantsData = null;
  let selectedIso = 'walk_15';

  // ── Init ────────────────────────────────────────────────────

  async function init() {
    try {
      [geointel, isochrones, merchantsData] = await Promise.all([
        fetch(_URL.starGeointel   || 'assets/data/platillos-geointel.json').then(r => r.json()),
        fetch(_URL.starIsochrones || 'assets/data/platillos-isochrones.json').then(r => r.json()),
        fetch(_URL.starMerchants  || 'assets/data/platillos-merchants.json').then(r => r.json()),
      ]);

      renderHeader();
      renderDigitalSection();
      renderParticipants();
      renderIsoSelector();
      renderAccions();
      renderScoreCard();
      renderConditionsCard();
      renderMapLegend();

      // Init both maps
      DashboardMap.init(isochrones, merchantsData);

      // Default isochrone selection
      selectIsochrone('walk_15');

      if (window.lucide) lucide.createIcons();
    } catch (e) {
      console.error('Dashboard init error:', e);
    }
  }

  // ── Header ──────────────────────────────────────────────────

  function renderHeader() {
    const evt = merchantsData.events[0];
    document.getElementById('header-event').innerHTML = `
      <h1>${evt.icon} ${evt.name}</h1>
      <p>${evt.edition} · ${evt.dates.start} — ${evt.dates.end}</p>
    `;
  }

  // ── Digital Section (KPIs + rate + chart + map) ─────────────

  function renderDigitalSection() {
    const evt = merchantsData.events[0];
    const ms = evt.merchants;
    const totalVisits = ms.reduce((s, m) => s + m.stats.visits, 0);
    const totalRoutes = ms.reduce((s, m) => s + m.stats.routes, 0);
    const uniqueVisits = merchantsData.meta.total_visits_today;
    const rate = Math.round((totalVisits / uniqueVisits) * 100);

    // Bar chart
    const start = new Date(evt.dates.start);
    const end = new Date(evt.dates.end);
    const days = Math.max(1, Math.round((end - start) / 86400000) + 1);
    const bars = [];
    let barSum = 0;
    for (let i = 0; i < days; i++) {
      const base = Math.sin((i / days) * Math.PI) * 0.7 + 0.3;
      const noise = 0.7 + Math.random() * 0.6;
      bars.push(base * noise);
      barSum += base * noise;
    }
    const barMax = Math.max(...bars);

    document.getElementById('digital-data').innerHTML = `
      <div class="digital-kpis">
        <div class="digital-kpi hl">
          <div class="digital-kpi-value">${uniqueVisits.toLocaleString('ca-ES')}</div>
          <div class="digital-kpi-label">visites uniques</div>
        </div>
        <div class="digital-kpi hl">
          <div class="digital-kpi-value">${ms.length}</div>
          <div class="digital-kpi-label">establiments connectats</div>
        </div>
        <div class="digital-kpi">
          <div class="digital-kpi-value">${totalVisits.toLocaleString('ca-ES')}</div>
          <div class="digital-kpi-label">visites a perfils</div>
        </div>
        <div class="digital-kpi">
          <div class="digital-kpi-value">${totalRoutes.toLocaleString('ca-ES')}</div>
          <div class="digital-kpi-label">clics en ruta</div>
        </div>
      </div>

      <div class="rate-card">
        <div class="rate-header">
          <span class="rate-label">Taxa d'interaccio</span>
          <span class="rate-value">${rate}%</span>
        </div>
        <div class="rate-bar-wrap">
          <div class="rate-bar" style="width:${Math.min(rate, 100)}%"></div>
        </div>
        <div class="rate-explanation">Percentatge de visitants que van interactuar amb un perfil</div>
      </div>

      <div class="chart-card">
        <h3>Visites per dia</h3>
        <div class="bar-chart">
          ${bars.map((val, i) => {
            const h = Math.round((val / barMax) * 100);
            const actual = Math.round((val / barSum) * uniqueVisits);
            return `<div class="bar-wrapper" title="Dia ${i + 1}: ~${actual}"><div class="bar" style="height:${h}%"></div></div>`;
          }).join('')}
        </div>
        <div class="chart-legend">
          <span>${start.toLocaleDateString('ca-ES', { day: 'numeric', month: 'short' })}</span>
          <span>${end.toLocaleDateString('ca-ES', { day: 'numeric', month: 'short' })}</span>
        </div>
      </div>
    `;
  }

  // ── Participants Section ──────────────────────────────────────

  function renderParticipants() {
    const evt = merchantsData.events[0];
    const ms = evt.merchants;
    const sorted = [...ms].sort((a, b) => b.stats.visits - a.stats.visits);
    const medals = ['🥇', '🥈', '🥉'];

    // Synthetic likes (not in JSON yet — ~30-70% of visits, seeded by id)
    function getLikes(m) { return Math.round(m.stats.visits * (0.3 + ((m.id * 7) % 41) / 100)); }

    // Tags
    const tagCounts = {};
    ms.forEach(m => m.tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
    const tagLabels = { 'sense-gluten': 'Sense gluten', 'vegetariana': 'Vegetariana', 'per-emportar': 'Per emportar' };

    document.getElementById('participants-data').innerHTML = `
      <div class="participants-table-wrap">
        <table class="participants-table">
          <thead>
            <tr>
              <th class="col-pos">#</th>
              <th class="col-name">Establiment</th>
              <th class="col-num">Visites</th>
              <th class="col-num">Rutes</th>
              <th class="col-num">Likes</th>
            </tr>
          </thead>
          <tbody>
            ${sorted.map((m, i) => {
              const pos = i < 3 ? medals[i] : i + 1;
              const likes = getLikes(m);
              return `
                <tr class="${i < 3 ? 'top-3' : ''}">
                  <td class="col-pos">${pos}</td>
                  <td class="col-name">${m.name}</td>
                  <td class="col-num"><strong>${m.stats.visits}</strong></td>
                  <td class="col-num"><strong>${m.stats.routes}</strong></td>
                  <td class="col-num"><strong>${likes}</strong></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>

      <div class="participants-footer">
        <div class="tags-section">
          <div class="tags-label">Distribucio per tags</div>
          <div class="tags-list">
            ${Object.entries(tagCounts).sort((a,b) => b[1]-a[1]).map(([tag, count]) =>
              `<span class="tag-chip">${tagLabels[tag] || tag}<span class="tag-chip-count"> ${count}</span></span>`
            ).join('')}
          </div>
        </div>

        <div class="report-cta">
          <div class="report-cta-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
          </div>
          <div class="report-cta-text">
            <div class="report-cta-title">Generar informe de l'esdeveniment</div>
            <div class="report-cta-desc">Report detallat amb metriques per participant, evolucio temporal i comparatives</div>
          </div>
          <button class="report-cta-btn">Generar PDF</button>
        </div>
      </div>
    `;
  }

  // ── Isochrone Selector ──────────────────────────────────────

  function renderIsoSelector() {
    const container = document.getElementById('iso-selector');
    container.innerHTML = `
      <div class="iso-row">
        <div class="iso-group">
          <div class="iso-group-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8 12 2-2 4 4"/></svg>
            A peu
          </div>
          <div class="iso-pills">
            <button class="iso-pill iso-pill-walk" data-iso="walk_5">5 min</button>
            <button class="iso-pill iso-pill-walk" data-iso="walk_15">15 min</button>
            <button class="iso-pill iso-pill-walk" data-iso="walk_30">30 min</button>
          </div>
        </div>
        <div class="iso-group">
          <div class="iso-group-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="8" rx="2"/><path d="M6 11V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5"/><path d="M3 15h18"/></svg>
            Transport
          </div>
          <div class="iso-pills">
            <button class="iso-pill iso-pill-transit" data-iso="transit_15">15 min</button>
            <button class="iso-pill iso-pill-transit" data-iso="transit_30">30 min</button>
            <button class="iso-pill iso-pill-transit" data-iso="transit_60">60 min</button>
          </div>
        </div>
      </div>
    `;
    container.querySelectorAll('.iso-pill').forEach(pill => {
      pill.addEventListener('click', () => selectIsochrone(pill.dataset.iso));
    });
  }

  // ── Territory Data (updates per isochrone) ──────────────────

  function updateTerritoriData(key) {
    const iso = geointel.isochrones[key];
    if (!iso) return;

    const ages = geointel.demographics.ageDistribution;
    const ageColors = ['#E65100', '#FF6B00', '#FF8C00', '#FFA726', '#FFB74D', '#FFCC80', '#FFE0B2'];
    const ageLabels = ['0-15', '16-24', '25-34', '35-44', '45-54', '55-64', '65+'];
    const ageValues = [ages.age0to15, ages.age16to24, ages.age25to34, ages.age35to44, ages.age45to54, ages.age55to64, ages.age65plus];

    let gradientStops = [];
    let cum = 0;
    ageValues.forEach((v, i) => {
      gradientStops.push(`${ageColors[i]} ${cum}% ${cum + v}%`);
      cum += v;
    });

    const fp = geointel.mobility.floatingPopulation;
    const fpMax = Math.max(...fp.map(h => h.population));

    document.getElementById('terr-data').innerHTML = `
      <div class="terr-metrics">
        <div class="terr-metric hl">
          <div class="terr-metric-value">${fmtNum(iso.population)}</div>
          <div class="terr-metric-label">Poblacio resident</div>
        </div>
        <div class="terr-metric">
          <div class="terr-metric-value">${fmtNum(iso.density)}</div>
          <div class="terr-metric-label">Densitat / km2</div>
        </div>
        <div class="terr-metric hl">
          <div class="terr-metric-value">${fmtNum(iso.footfall)}</div>
          <div class="terr-metric-label">Footfall estimat</div>
        </div>
        <div class="terr-metric">
          <div class="terr-metric-value">${fmtNum(iso.pois)}</div>
          <div class="terr-metric-label">Punts d'interes</div>
        </div>
      </div>

      <div class="poi-row">
        <div class="poi-item">
          <div class="poi-item-value">${iso.hospitality}</div>
          <div class="poi-item-label">Hostaleria</div>
        </div>
        <div class="poi-item">
          <div class="poi-item-value">${iso.retail}</div>
          <div class="poi-item-label">Comerc</div>
        </div>
        <div class="poi-item">
          <div class="poi-item-value">${iso.transitStops}</div>
          <div class="poi-item-label">Transport</div>
        </div>
        <div class="poi-item">
          <div class="poi-item-value">${iso.merchants != null ? iso.merchants : '—'}</div>
          <div class="poi-item-label">Participants</div>
        </div>
      </div>

      <div class="demo-income-row">
        <div class="donut-row">
          <div class="donut" style="background:conic-gradient(${gradientStops.join(',')})">
            <div class="donut-hole"></div>
            <div class="donut-center">${geointel.demographics.medianAge}a</div>
          </div>
          <div class="demo-legend">
            ${ageValues.map((v, i) => `
              <div class="demo-legend-item">
                <span class="demo-legend-dot" style="background:${ageColors[i]}"></span>
                ${ageLabels[i]}: ${v}%
              </div>
            `).join('')}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <div class="compact-card">
            <div class="compact-card-label">Renda mitjana</div>
            <div class="compact-card-value">${fmtNum(iso.meanIncome || geointel.income.meanIncomePerPerson)}€</div>
            <div class="compact-card-sub">Gini: ${geointel.income.giniIndex}</div>
          </div>
          <div class="compact-card">
            <div class="compact-card-label">Pic mobilitat</div>
            <div class="compact-card-value">${fmtNum(iso.floatingPeak)}</div>
            <div class="compact-card-sub">${iso.floatingPeakHour}:00h</div>
          </div>
        </div>
      </div>

      <div class="floating-card">
        <div class="floating-card-label">
          <span>Poblacio flotant (24h)</span>
          <span>Pic: ${fmtNum(iso.floatingPeak)} a les ${iso.floatingPeakHour}h</span>
        </div>
        <div class="floating-chart">
          ${fp.map(h => {
            const pct = Math.round((h.population / fpMax) * 100);
            return `<div class="floating-bar ${h.hour === iso.floatingPeakHour ? 'peak' : ''}" style="height:${pct}%" title="${h.hour}:00 — ${fmtNum(h.population)}"></div>`;
          }).join('')}
        </div>
        <div class="floating-labels">
          <span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span>
        </div>
      </div>
    `;
  }

  // ── Accions ─────────────────────────────────────────────────

  const ACTIONS_DATA = _CFG.dashboardActions || [
    {
      id: 1, type: 'launch', icon: 'rocket',
      name: 'Inici de l\'esdeveniment',
      desc: 'Notificacio d\'obertura a usuaris a prop dels establiments',
      zone: 'walk_15', status: 'sent', date: '06/11',
      reach: 28600, sent: 8420, opened: 4650, clicks: 1380,
    },
    {
      id: 2, type: 'reminder', icon: 'bell',
      name: 'Recordatori cap de setmana',
      desc: 'Push de recordatori per al primer cap de setmana',
      zone: 'transit_15', status: 'sent', date: '08/11',
      reach: 95000, sent: 22100, opened: 9840, clicks: 3120,
    },
    {
      id: 3, type: 'promo', icon: 'tag',
      name: 'Promocio 2x1 platillos',
      desc: 'Oferta especial per incentivar la participacio',
      zone: 'walk_30', status: 'sent', date: '12/11',
      reach: 45200, sent: 12800, opened: 6240, clicks: 2850,
    },
    {
      id: 4, type: 'reminder', icon: 'bell',
      name: 'Ultima setmana!',
      desc: 'Recordatori de tancament — ultims dies per participar',
      zone: 'transit_30', status: 'scheduled', date: '18/11',
      reach: 285000, sent: null, opened: null, clicks: null,
    },
  ];

  const ACTION_TYPE_LABELS = {
    launch: 'Llancament', reminder: 'Recordatori', promo: 'Promocio',
  };

  const ACTION_STATUS = {
    sent: { label: 'Enviada', cls: 'sent' },
    scheduled: { label: 'Programada', cls: 'scheduled' },
    draft: { label: 'Esborrany', cls: 'draft' },
  };

  function renderAccions() {
    const zoneLabels = {};
    if (isochrones && isochrones.features) {
      isochrones.features.forEach(f => { zoneLabels[f.properties.id] = f.properties.label; });
    }

    document.getElementById('accions-body').innerHTML = `
      <div class="actions-list">
        ${ACTIONS_DATA.map(a => {
          const st = ACTION_STATUS[a.status] || ACTION_STATUS.draft;
          const zoneLabel = zoneLabels[a.zone] || a.zone;
          const openRate = a.sent && a.opened ? Math.round((a.opened / a.sent) * 100) : null;
          const ctr = a.opened && a.clicks ? Math.round((a.clicks / a.opened) * 100) : null;

          return `
            <div class="action-card">
              <div class="action-card-left">
                <div class="action-icon action-icon-${a.type}">
                  <i data-lucide="${a.icon}"></i>
                </div>
                <div class="action-info">
                  <div class="action-name">${a.name}</div>
                  <div class="action-desc">${a.desc}</div>
                  <div class="action-meta">
                    <span class="action-type-badge">${ACTION_TYPE_LABELS[a.type]}</span>
                    <span class="action-zone">${zoneLabel}</span>
                    <span class="action-date">${a.date}</span>
                  </div>
                </div>
              </div>
              <div class="action-card-right">
                <span class="action-status ${st.cls}">${st.label}</span>
                ${a.sent != null ? `
                  <div class="action-metrics">
                    <div class="action-metric">
                      <div class="action-metric-value">${fmtNum(a.sent)}</div>
                      <div class="action-metric-label">Enviades</div>
                    </div>
                    <div class="action-metric">
                      <div class="action-metric-value">${fmtNum(a.opened)}</div>
                      <div class="action-metric-label">Obertes · ${openRate}%</div>
                    </div>
                    <div class="action-metric">
                      <div class="action-metric-value">${fmtNum(a.clicks)}</div>
                      <div class="action-metric-label">Clics · ${ctr}%</div>
                    </div>
                  </div>
                ` : `
                  <div class="action-metrics action-metrics-pending">
                    <div class="action-metric">
                      <div class="action-metric-value">${fmtNum(a.reach)}</div>
                      <div class="action-metric-label">Abast estimat</div>
                    </div>
                  </div>
                `}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // "Nova accio" button
    const btn = document.getElementById('btn-new-action');
    if (btn) {
      btn.addEventListener('click', () => {
        alert('Funcionalitat disponible properament');
      });
    }
  }

  // ── Score Card ──────────────────────────────────────────────

  function renderScoreCard() {
    const s = geointel.score;
    const r = 45;
    const circ = 2 * Math.PI * r;
    const offset = circ * (1 - s.score / 10);
    const sorted = [...s.indicators].sort((a, b) => b.weighted - a.weighted);

    document.getElementById('card-score').innerHTML = `
      <div class="card-header">
        <h2>Puntuacio de la ubicacio</h2>
        <p class="card-subtitle">Perfil: ${s.profile}</p>
      </div>
      <div class="score-layout">
        <div class="score-ring-wrap">
          <svg viewBox="0 0 100 100">
            <circle class="score-ring-bg" cx="50" cy="50" r="${r}" />
            <circle class="score-ring-fg ${s.rating}" cx="50" cy="50" r="${r}"
              stroke-dasharray="${circ}"
              stroke-dashoffset="${circ}"
              data-target="${offset}" />
          </svg>
          <div class="score-value">
            <span class="score-number">${s.score}</span>
            <span class="score-max">/ 10</span>
          </div>
        </div>
        <div class="score-detail">
          <div class="score-label">Valoracio global</div>
          <div class="score-rating ${s.rating}">${translateRating(s.rating)}</div>
          <div class="score-bars">
            ${sorted.map(ind => `
              <div class="score-bar-row">
                <span class="score-bar-label">${translateIndicator(ind.key)}</span>
                <div class="score-bar-track">
                  <div class="score-bar-fill" style="width:${Math.round(ind.normalized * 100)}%"></div>
                </div>
                <span class="score-bar-val">${(ind.normalized * 10).toFixed(1)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    requestAnimationFrame(() => {
      const fg = document.querySelector('.score-ring-fg');
      if (fg) setTimeout(() => { fg.style.strokeDashoffset = fg.dataset.target; }, 100);
    });
  }

  // ── Conditions Card ─────────────────────────────────────────

  function renderConditionsCard() {
    const w = geointel.weather.summary;
    const aq = geointel.airQuality.summary;
    const alerts = geointel.alerts;
    const daily = geointel.weather.forecast ? geointel.weather.forecast.daily : [];
    const dayNames = ['dg', 'dl', 'dt', 'dc', 'dj', 'dv', 'ds'];

    document.getElementById('card-conditions').innerHTML = `
      <div class="card-header">
        <h2>Condicions</h2>
        <p class="card-subtitle">Meteo, qualitat de l'aire i alertes</p>
      </div>
      <div class="conditions-grid">
        <div class="cond-item ${w.recommendation === 'good' || w.recommendation === 'excellent' ? 'good' : 'caution'}">
          <div class="cond-icon"><i data-lucide="sun"></i></div>
          <div class="cond-value">${w.comfortScore}</div>
          <div class="cond-label">Confort</div>
        </div>
        <div class="cond-item ${aq.rating === 'good' ? 'good' : 'caution'}">
          <div class="cond-icon"><i data-lucide="wind"></i></div>
          <div class="cond-value">${aq.avgAqi}</div>
          <div class="cond-label">AQI · ${translateAqRating(aq.rating)}</div>
        </div>
        <div class="cond-item ${alerts.totalCount === 0 ? 'good' : 'poor'}">
          <div class="cond-icon"><i data-lucide="shield-check"></i></div>
          <div class="cond-value">${alerts.totalCount}</div>
          <div class="cond-label">${alerts.totalCount === 0 ? 'Cap alerta' : alerts.maxLevel}</div>
        </div>
      </div>
      ${daily.length > 0 ? `
        <div class="forecast-row">
          ${daily.slice(0, 5).map(d => {
            const date = new Date(d.date);
            const dn = dayNames[date.getDay()];
            return `
              <div class="forecast-day">
                <span class="forecast-day-name">${dn}</span>
                <span class="forecast-temp">${d.tempMax}°</span><br>
                <span class="forecast-rain">${d.precipitationProbMax}%</span>
              </div>
            `;
          }).join('')}
        </div>
      ` : ''}
    `;
  }

  // ── Map Legend ───────────────────────────────────────────────

  function renderMapLegend() {
    const styles = DashboardMap.getIsoStyles();
    const labels = {
      walk_5: '5\' a peu', walk_15: '15\' a peu', walk_30: '30\' a peu',
      transit_15: '15\' transport', transit_30: '30\' transport', transit_60: '60\' transport',
    };
    document.getElementById('map-legend').innerHTML = `
      <h4>Isocrones</h4>
      ${Object.entries(labels).map(([k, l]) => `
        <div class="map-legend-item">
          <div class="map-legend-line" style="background:${styles[k].color};opacity:${styles[k].opacity}"></div>
          <span>${l}</span>
        </div>
      `).join('')}
    `;
  }

  // ── Isochrone Selection ─────────────────────────────────────

  function selectIsochrone(key) {
    selectedIso = key;
    document.querySelectorAll('.iso-pill').forEach(p =>
      p.classList.toggle('active', p.dataset.iso === key)
    );
    updateTerritoriData(key);
    DashboardMap.highlightIsochrone(key);
    if (window.lucide) lucide.createIcons();
  }

  // ── Helpers ─────────────────────────────────────────────────

  function fmtNum(n) {
    if (n == null) return '—';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    return n.toLocaleString('ca-ES');
  }

  function translateRating(r) {
    return { excellent: 'Excel·lent', good: 'Bona', average: 'Mitjana', below_average: 'Per sota', poor: 'Baixa' }[r] || r;
  }

  function translateAqRating(r) {
    return { good: 'Bona', moderate: 'Moderada', unhealthy_sensitive: 'Sensibles', unhealthy: 'Insalubre' }[r] || r;
  }

  function translateIndicator(k) {
    return {
      'population.total': 'Poblacio', 'population.density': 'Densitat',
      'demographics.diversity': 'Diversitat', 'income.meanIncome': 'Renda',
      'mobility.inboundTrips': 'Mobilitat', 'pois.hospitality': 'Hostaleria',
      'pois.transit': 'Transport', 'weather.comfort': 'Clima',
    }[k] || k.split('.').pop();
  }

  return { init, selectIsochrone };
})();

window.Dashboard = Dashboard;
document.addEventListener('DOMContentLoaded', Dashboard.init);
