// ===== Nearme: "a prop teu" =====
// User-centric proximity demo. Active location (saved or ad-hoc "current") +
// mode/time preset → isochrone halo + merchants in range, ordered by minutes.
//
// Entry points:
//   - Chips in sidebar → change location / mode-minutes
//   - "Ara" placeholder → click on map to drop current position
//   - Marker hover → mini card
//   - Marker/list click → shared DetailDrawer

const Nearme = (() => {

  const BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

  const DEFAULT_MODE    = 'walk';
  const DEFAULT_MINUTES = 15;

  const TIME_PRESETS = {
    walk:    [5, 15, 30],
    transit: [15, 30, 45],
  };

  // Lucide icon names — one source of truth, no emoji in UI.
  const MODE_ICON     = { walk: 'footprints', transit: 'bus' };
  const LOCATION_ICON = { casa: 'home', feina: 'briefcase', gimnas: 'dumbbell' };
  const CURRENT_ICON  = 'locate';
  const EVENT_ICON    = { 'platillos-2025': 'utensils' };
  const DEFAULT_EVENT_ICON = 'utensils';

  const icon = (name, size = 'lucide-sm') =>
    `<i data-lucide="${name}" class="${size}"></i>`;

  const refreshIcons = () => { if (window.lucide) lucide.createIcons(); };

  // ---- State ----
  let map           = null;
  let allMerchants  = [];
  let merchantEventMap = {};
  let activeMode    = DEFAULT_MODE;
  let activeMinutes = DEFAULT_MINUTES;
  let userDotMarker = null;
  let merchantMarkers = new Map();  // merchantId -> maplibregl.Marker
  let inRange       = [];
  let pickMode      = false;        // awaiting map click to drop current position

  let hoverCardMarker     = null;
  let hoverCardMerchantId = null;
  let hoverCardHideTimer  = null;
  let lastFittedKey       = null;   // refit whenever location/mode/minutes change
  let activeMerchantId    = null;   // currently selected merchant (drawer open)

  // ---- Boot ----

  async function init() {
    initMap();
    await new Promise(r => map.loaded() ? r() : map.once('load', r));

    const [merchantsData] = await Promise.all([
      fetch('assets/data/platillos-merchants.json').then(r => r.json()),
      LocationStore.load(),
    ]);

    merchantsData.events.forEach(evt => {
      evt.merchants.forEach(m => {
        m._event = evt;
        allMerchants.push(m);
        merchantEventMap[m.id] = evt;
      });
    });

    DetailDrawer.configure({
      onClose: () => _resetStates(),
      extrasForMerchant: (m) => _drawerExtras(m),
    });

    LocationStore.onChange(() => rebuild());

    document.getElementById('map-loading').classList.add('hidden');
    rebuild();
  }

  function initMap() {
    map = new maplibregl.Map({
      container: 'map',
      style: BASEMAP_STYLE_URL,
      center: [2.105, 41.360],
      zoom: 15,
      minZoom: 10,
      maxZoom: 19,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    map.on('click', (e) => {
      if (pickMode) {
        LocationStore.setCurrent({ lat: e.lngLat.lat, lng: e.lngLat.lng });
        _exitPickMode();
        return;
      }
      if (e.originalEvent.defaultPrevented) return;
      if (DetailDrawer.isOpen()) {
        DetailDrawer.close();   // onClose hook resets states
      } else if (activeMerchantId !== null) {
        _resetStates();
      }
    });
  }

  // ---- Pick mode ----

  function _enterPickMode() {
    pickMode = true;
    document.getElementById('map-container').classList.add('nm-pick-cursor');
    let hint = document.getElementById('nm-pick-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'nm-pick-hint';
      hint.className = 'nm-pick-hint';
      hint.innerHTML = `
        <span class="nm-pick-hint-icon">${icon('crosshair')}</span>
        <span class="nm-pick-hint-text">Clica al mapa per fixar la teva ubicació</span>
        <button class="nm-pick-cancel" aria-label="Cancel·lar">${icon('x')}</button>`;
      document.body.appendChild(hint);
      hint.querySelector('.nm-pick-cancel').addEventListener('click', _exitPickMode);
    }
    hint.classList.remove('hidden');
    refreshIcons();
  }

  function _exitPickMode() {
    pickMode = false;
    document.getElementById('map-container').classList.remove('nm-pick-cursor');
    const hint = document.getElementById('nm-pick-hint');
    if (hint) hint.classList.add('hidden');
  }

  // ---- Rebuild on state change ----

  function rebuild() {
    const loc = LocationStore.getActive();

    if (!loc) {
      inRange = [];
      renderSidebar();
      Proximity.removeIsochroneLayer(map);
      _clearMerchantMarkers();
      _updateUserDot(null);
      return;
    }

    const iso = Proximity.getIsochrone(loc, activeMode, activeMinutes);
    inRange = Proximity.filterByIsochrone(allMerchants, iso)
      .map(m => ({
        m,
        minutes: Proximity.walkMinutes(loc.coordinates, m.coordinates, activeMode),
        meters:  Proximity.walkMeters(loc.coordinates, m.coordinates),
      }))
      .sort((a, b) => a.minutes - b.minutes);

    renderSidebar();
    Proximity.renderIsochroneLayer(map, iso);
    _renderTransitLayer(loc, iso);
    _renderMerchantMarkers(inRange);
    _updateUserDot(loc);

    // Refit whenever the scope changes (location, mode, or minutes) so the
    // whole polygon fits in view after the user switches preset.
    const fitKey = `${loc.id}|${activeMode}|${activeMinutes}`;
    if (lastFittedKey !== fitKey) {
      _fitToIso(iso);
      lastFittedKey = fitKey;
    }
  }

  function _renderTransitLayer(loc, iso) {
    if (activeMode !== 'transit') {
      TransitLayer.hide(map);
      return;
    }
    const stopsUrl = loc?.transit_stops?.[String(activeMinutes)] || null;
    const polygon  = iso?.type === 'polygon' ? iso.geojson : null;
    TransitLayer.show(map, polygon, stopsUrl).catch(err => {
      console.warn('[nearme] transit layer failed', err);
    });
  }

  function _fitToIso(iso) {
    if (!iso) return;
    let polygon;
    if (iso.type === 'polygon') {
      polygon = iso.geojson;
    } else {
      polygon = turf.circle(iso.center, iso.radiusMeters / 1000, {
        steps: 32, units: 'kilometers',
      });
    }
    const bbox = turf.bbox(polygon);
    map.fitBounds(bbox, {
      padding: { top: 60, right: 60, bottom: 60, left: 380 },
      duration: 600,
      maxZoom: 17,
    });
  }

  // ---- Merchant markers ----

  function _clearMerchantMarkers() {
    merchantMarkers.forEach(mk => mk.remove());
    merchantMarkers.clear();
    _hideHoverCard();
  }

  // Diff markers between renders: reuse existing ones so merchants that stay
  // in range don't get re-mounted (which was making them visually "jump").
  function _renderMerchantMarkers(items) {
    const nextIds = new Set(items.map(({ m }) => m.id));

    for (const [id, marker] of merchantMarkers) {
      if (!nextIds.has(id)) {
        marker.remove();
        merchantMarkers.delete(id);
        if (hoverCardMerchantId === id) _hideHoverCard();
      }
    }

    items.forEach(({ m }) => {
      if (merchantMarkers.has(m.id)) return;

      const evt = merchantEventMap[m.id];
      const color = evt?.color || '#FF6B00';

      // Wrapper pattern (same as explore): MapLibre transforms the wrapper,
      // the styled dot inside keeps its own transition for hover effects.
      const wrapper = document.createElement('div');
      wrapper.className = 'merchant-dot-wrapper';
      const dot = document.createElement('div');
      dot.className = 'merchant-dot nm-dot';
      dot.dataset.merchantId = m.id;
      dot.style.setProperty('--dot-color', color);
      wrapper.appendChild(dot);

      wrapper.addEventListener('mouseenter', () => {
        _setHoverState(m.id, true);
        _showHoverCard(m);
        _scrollListItemIntoView(m.id);
      });
      wrapper.addEventListener('mouseleave', () => {
        _setHoverState(m.id, false);
        _scheduleHideHoverCard();
      });
      wrapper.addEventListener('click', (e) => {
        e.stopPropagation();
        _setActive(m.id);
        DetailDrawer.open(m, evt);
      });

      const marker = new maplibregl.Marker({ element: wrapper, anchor: 'center' })
        .setLngLat([m.coordinates.lng, m.coordinates.lat])
        .addTo(map);
      merchantMarkers.set(m.id, marker);
    });

    // Keep active state consistent after a diff. If the active merchant is
    // still in range, re-apply so the fresh list items get the classes too.
    // If it fell out, clear stale classes on everything that remains.
    if (activeMerchantId !== null) {
      if (merchantMarkers.has(activeMerchantId)) {
        _setActive(activeMerchantId);
      } else {
        _resetStates();
      }
    }
  }

  // ---- Shared state helpers (markers ↔ list items) ----

  function _listItems() {
    return document.querySelectorAll('#sidebar-inner .sb-merchant-card');
  }

  function _setHoverState(id, on) {
    const marker = merchantMarkers.get(id);
    if (marker) {
      const dot = marker.getElement().querySelector('.merchant-dot');
      if (dot) dot.classList.toggle('marker-hover', on);
    }
    _listItems().forEach(it => {
      if (Number(it.dataset.merchantId) === id) {
        it.classList.toggle('hover-from-map', on);
      }
    });
  }

  function _setActive(id) {
    activeMerchantId = id;

    merchantMarkers.forEach((marker, mid) => {
      const dot = marker.getElement().querySelector('.merchant-dot');
      if (!dot) return;
      dot.classList.toggle('marker-active',        mid === id);
      dot.classList.toggle('marker-out-of-focus',  mid !== id);
    });

    _listItems().forEach(item => {
      const itemId = Number(item.dataset.merchantId);
      item.classList.toggle('active',        itemId === id);
      item.classList.toggle('out-of-focus',  itemId !== id);
    });
  }

  function _resetStates() {
    activeMerchantId = null;
    merchantMarkers.forEach(marker => {
      const dot = marker.getElement().querySelector('.merchant-dot');
      if (!dot) return;
      dot.classList.remove('marker-active', 'marker-out-of-focus', 'marker-hover');
    });
    _listItems().forEach(item => {
      item.classList.remove('active', 'out-of-focus', 'hover-from-map');
    });
  }

  function _scrollListItemIntoView(id) {
    const item = document.querySelector(`#sidebar-inner .sb-merchant-card[data-merchant-id="${id}"]`);
    const container = document.getElementById('sidebar-inner');
    if (!item || !container) return;
    const itemRect = item.getBoundingClientRect();
    const boxRect  = container.getBoundingClientRect();
    if (itemRect.top < boxRect.top || itemRect.bottom > boxRect.bottom) {
      item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ---- Hover card ----

  function _showHoverCard(m) {
    clearTimeout(hoverCardHideTimer);
    if (hoverCardMerchantId === m.id && hoverCardMarker) return;
    _hideHoverCard();

    const item = inRange.find(x => x.m.id === m.id);
    if (!item) return;

    const status = Status.getOpenStatus(m, new Date());
    const wrapper = document.createElement('div');
    wrapper.className = 'rc-wrapper';
    wrapper.style.zIndex = '1000';
    wrapper.innerHTML = _buildHoverCardHtml(m, status, item);

    const cardEl = wrapper.querySelector('.rc');
    if (cardEl) {
      cardEl.classList.add('rc--open');
      cardEl.addEventListener('mouseenter', () => clearTimeout(hoverCardHideTimer));
      cardEl.addEventListener('mouseleave', _scheduleHideHoverCard);
      cardEl.addEventListener('click', (e) => {
        e.stopPropagation();
        DetailDrawer.open(m, merchantEventMap[m.id]);
      });
    }

    hoverCardMarker = new maplibregl.Marker({
      element: wrapper,
      anchor:  'top',
      offset:  [0, 12],
    })
      .setLngLat([m.coordinates.lng, m.coordinates.lat])
      .addTo(map);
    hoverCardMerchantId = m.id;
    refreshIcons();
  }

  function _scheduleHideHoverCard() {
    clearTimeout(hoverCardHideTimer);
    hoverCardHideTimer = setTimeout(_hideHoverCard, 180);
  }

  function _hideHoverCard() {
    clearTimeout(hoverCardHideTimer);
    if (hoverCardMarker) {
      hoverCardMarker.remove();
      hoverCardMarker = null;
      hoverCardMerchantId = null;
    }
  }

  function _buildHoverCardHtml(m, status, item) {
    const dish = m.dish?.name
      ? (m.dish.price ? `${m.dish.name} · ${m.dish.price}` : m.dish.name)
      : '';
    const mIcon = MODE_ICON[activeMode] || MODE_ICON.walk;
    const mins = Math.round(item.minutes);
    return `
      <div class="rc rc--xs" data-merchant-id="${m.id}">
        <div class="rc-head">
          <div class="rc-title-block">
            <div class="rc-name">${_shortName(m.name, 22)}</div>
          </div>
          <span class="rc-status-dot rc-status-dot--${status.status}" aria-label="${status.label}"></span>
        </div>
        ${dish ? `<div class="rc-body"><div class="rc-meta">${dish}</div></div>` : ''}
        <div class="rc-body rc-body--proximity">
          <div class="rc-proximity">${icon(mIcon)} ${mins} min · ${_formatDistance(item.meters)}</div>
        </div>
      </div>`;
  }

  // ---- User dot ----

  function _updateUserDot(location) {
    if (!location) {
      if (userDotMarker) { userDotMarker.remove(); userDotMarker = null; }
      return;
    }
    const lngLat = [location.coordinates.lng, location.coordinates.lat];

    if (!userDotMarker) {
      const wrapper = document.createElement('div');
      wrapper.className = 'user-dot-wrapper';
      const dot = document.createElement('div');
      dot.className = 'user-dot';
      dot.innerHTML = `
        <div class="user-dot-ring user-dot-ring--1"></div>
        <div class="user-dot-ring user-dot-ring--2"></div>
        <div class="user-dot-ring user-dot-ring--3"></div>`;
      wrapper.appendChild(dot);
      userDotMarker = new maplibregl.Marker({ element: wrapper, anchor: 'center' })
        .setLngLat(lngLat)
        .addTo(map);
    } else {
      userDotMarker.setLngLat(lngLat);
    }
    const dotEl = userDotMarker.getElement().querySelector('.user-dot');
    if (dotEl) dotEl.classList.toggle('user-dot--radar', !!location.isCurrent);
  }

  // ---- Sidebar ----

  function renderSidebar() {
    const inner = document.getElementById('sidebar-inner');
    if (!inner) return;

    const saved     = LocationStore.getSaved();
    const active    = LocationStore.getActive();
    const hasCurrent = LocationStore.hasCurrent();

    const locChips = [
      ...saved.map(s => ({
        id: s.id, label: s.label, icon: LOCATION_ICON[s.id] || 'map-pin',
        active: active?.id === s.id,
      })),
      {
        id: 'current',
        label: 'Ara',
        icon: CURRENT_ICON,
        active: active?.id === 'current',
        placeholder: !hasCurrent,
      },
    ];

    const timeChips = [
      ...TIME_PRESETS.walk.map(n => ({
        mode: 'walk', minutes: n, iconName: MODE_ICON.walk, label: `${n} min`,
        active: activeMode === 'walk' && activeMinutes === n,
      })),
      ...TIME_PRESETS.transit.map(n => ({
        mode: 'transit', minutes: n, iconName: MODE_ICON.transit, label: `${n} min`,
        active: activeMode === 'transit' && activeMinutes === n,
      })),
    ];

    const titleLabel = active ? active.label : 'Selecciona ubicació';
    const subtitle = active
      ? (active.isCurrent ? 'Ubicació actual (aproximada)' : `Lloc guardat`)
      : 'Escull un lloc o clica el mapa';

    inner.innerHTML = `
      <div class="sb-header nm-header">
        <div class="sb-eyebrow">A prop teu</div>
        <div class="sb-title">${titleLabel}</div>
        <div class="nm-subtitle">${subtitle}</div>
      </div>

      <div class="nm-chips-section">
        <div class="nm-chips-label">Ubicació</div>
        <div class="nm-chips-row">
          ${locChips.map(c => `
            <button class="nm-chip nm-chip--loc ${c.active ? 'is-active' : ''} ${c.placeholder ? 'is-placeholder' : ''}"
                    data-loc="${c.id}">
              ${icon(c.icon)}
              <span class="nm-chip-label">${c.label}</span>
            </button>`).join('')}
        </div>
      </div>

      <div class="nm-chips-section">
        <div class="nm-chips-label">Temps disponible</div>
        <div class="nm-chips-row nm-chips-times">
          ${timeChips.map(c => `
            <button class="nm-chip nm-chip--time ${c.active ? 'is-active' : ''}"
                    data-mode="${c.mode}" data-minutes="${c.minutes}">
              ${icon(c.iconName)}
              <span class="nm-chip-label">${c.label}</span>
            </button>`).join('')}
        </div>
      </div>

      <div class="nm-list-header">
        <span class="nm-list-count">${inRange.length}</span>
        <span class="nm-list-label">${inRange.length === 1 ? 'lloc al teu abast' : 'llocs al teu abast'}</span>
      </div>
      <div class="sb-list nm-list" id="nm-list">${_renderListItems()}</div>`;

    inner.querySelectorAll('.nm-chip--loc').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.loc;
        if (id === 'current' && !LocationStore.hasCurrent()) {
          _enterPickMode();
        } else {
          LocationStore.setActive(id);
        }
      });
    });

    inner.querySelectorAll('.nm-chip--time').forEach(btn => {
      btn.addEventListener('click', () => {
        activeMode    = btn.dataset.mode;
        activeMinutes = Number(btn.dataset.minutes);
        rebuild();
      });
    });

    _wireListItems();
    refreshIcons();

    const sidebar = document.getElementById('sidebar');
    sidebar.classList.remove('hidden-sidebar');
    sidebar.classList.add('visible');
  }

  function _renderListItems() {
    if (!inRange.length) {
      return `
        <div class="nm-empty">
          <div class="nm-empty-icon">${icon('search', 'lucide-lg')}</div>
          <div class="nm-empty-title">No hi ha res en aquest radi</div>
          <div class="nm-empty-hint">Prova una altra ubicació o amplia el temps.</div>
        </div>`;
    }

    return _groupByEvent(inRange).map(_renderEventGroup).join('');
  }

  function _groupByEvent(items) {
    const byId = new Map();  // eventId -> { event, items }
    items.forEach(entry => {
      const evt = merchantEventMap[entry.m.id];
      if (!evt) return;
      if (!byId.has(evt.id)) byId.set(evt.id, { event: evt, items: [] });
      byId.get(evt.id).items.push(entry);
    });
    // Sort groups by closest merchant in the group
    return Array.from(byId.values())
      .sort((a, b) => a.items[0].minutes - b.items[0].minutes);
  }

  function _renderEventGroup({ event, items }) {
    const maxMin = Math.round(items[items.length - 1].minutes);
    const count  = items.length;
    const evIcon = EVENT_ICON[event.id] || DEFAULT_EVENT_ICON;
    const mIcon  = MODE_ICON[activeMode] || MODE_ICON.walk;

    return `
      <div class="nm-event-group" style="--event-color:${event.color}">
        <a class="nm-event-card" href="explore.html" data-event-id="${event.id}">
          <span class="nm-event-card-icon">${icon(evIcon, 'lucide-md')}</span>
          <div class="nm-event-card-info">
            <div class="nm-event-card-name">${event.name}</div>
            <div class="nm-event-card-meta">
              ${count} ${count === 1 ? 'lloc' : 'llocs'} · fins a
              <span class="nm-event-card-inline">${icon(mIcon)} ${maxMin} min</span>
            </div>
          </div>
          ${icon('arrow-right', 'lucide-sm')}
        </a>
        <div class="nm-event-group-items">
          ${items.map(x => _renderItemCard(x, event)).join('')}
        </div>
      </div>`;
  }

  function _renderItemCard({ m, minutes, meters }, _evt) {
    const mIcon = MODE_ICON[activeMode] || MODE_ICON.walk;
    const now = new Date();
    const status = Status.getOpenStatus(m, now);
    const popularity = Status.getPopularity(m.stats?.visits ?? 0);
    const pid = m.id > 100 ? m.id - 100 : m.id;
    const photo = `assets/images/merchants/${pid}.png`;
    const dish = m.dish?.name
      ? (m.dish.price ? `${m.dish.name} · ${m.dish.price}` : m.dish.name)
      : '';
    const tagsHtml = (m.tags || []).slice(0, 2)
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
            <span class="sb-mcard-time">${icon(mIcon)} ${Math.round(minutes)} min · ${_formatDistance(meters)}</span>
            <span class="sb-mcard-status sb-mcard-status--${status.status}">${status.label}</span>
            ${popularHtml}
            ${tagsHtml}
          </div>
        </div>
      </div>`;
  }

  function _wireListItems() {
    _listItems().forEach(item => {
      const id = Number(item.dataset.merchantId);
      const entry = inRange.find(x => x.m.id === id);
      if (!entry) return;

      item.addEventListener('mouseenter', () => {
        _setHoverState(id, true);
        _showHoverCard(entry.m);
      });
      item.addEventListener('mouseleave', () => {
        _setHoverState(id, false);
        _scheduleHideHoverCard();
      });
      item.addEventListener('click', () => {
        map.flyTo({
          center: [entry.m.coordinates.lng, entry.m.coordinates.lat],
          zoom: Math.max(map.getZoom(), 16),
          duration: 500,
        });
        _setActive(id);
        DetailDrawer.open(entry.m, merchantEventMap[entry.m.id]);
      });
    });
  }

  // ---- Drawer extras (injected via DetailDrawer.configure) ----

  function _drawerExtras(m) {
    const loc = LocationStore.getActive();
    if (!loc) return null;
    const mins   = Proximity.walkMinutes(loc.coordinates, m.coordinates, activeMode);
    const meters = Proximity.walkMeters(loc.coordinates, m.coordinates);
    const mIcon  = MODE_ICON[activeMode] || MODE_ICON.walk;
    const evt = merchantEventMap[m.id];
    return {
      infoRow: `
        <div class="detail-info-row">
          <span class="detail-info-icon">${icon(mIcon)}</span>
          <span class="detail-info-text">${Math.round(mins)} min · ${_formatDistance(meters)} des de ${loc.label}</span>
        </div>`,
      actionBtn: evt ? `
        <a class="detail-btn detail-btn--secondary" href="explore.html">
          Veure event complet
          ${icon('arrow-right')}
        </a>` : null,
    };
  }

  // ---- Utils ----

  function _shortName(name, max) {
    return name.length > max ? name.slice(0, max - 1) + '…' : name;
  }

  function _formatDistance(meters) {
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => Nearme.init());
