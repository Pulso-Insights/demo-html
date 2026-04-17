// ===== DetailDrawer =====
// Shared right-side drawer for merchant detail. Used by explore and nearme.
//
// DOM contract: page must contain #detail-drawer with the same structure as
// explore.html / nearme.html (hero, meta row, name, dish block, info strip,
// schedule, tags, actions, close button).
//
// API:
//   DetailDrawer.open(merchant, event)   // populate + show
//   DetailDrawer.close()                 // hide + fire onClose hook
//   DetailDrawer.isOpen()                // boolean
//   DetailDrawer.configure({ onClose, extrasForMerchant })
//   DetailDrawer.photoSrc(merchant)
//   DetailDrawer.openRoute(merchant)
//
// `extrasForMerchant(merchant)` can return:
//   { infoRow: '<div class="detail-info-row">…</div>',
//     actionBtn: '<button …>…</button>' }
// Each is appended to .detail-info-strip / .detail-actions with data-extra="true"
// and cleared on next open.

const DetailDrawer = (() => {
  const $ = (id) => document.getElementById(id);
  const drawer = () => $('detail-drawer');

  let _onClose = null;
  let _extrasForMerchant = null;

  function photoSrc(merchant) {
    const pid = merchant.id > 100 ? merchant.id - 100 : merchant.id;
    return `assets/images/merchants/${pid}.png`;
  }

  function openRoute(merchant) {
    const { lat, lng } = merchant.coordinates;
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, '_blank');
  }

  function _clearExtras() {
    document.querySelectorAll('#detail-drawer [data-extra="true"]').forEach(n => n.remove());
  }

  function _appendExtra(containerSelector, html) {
    if (!html) return;
    const container = document.querySelector(containerSelector);
    if (!container) return;
    const tpl = document.createElement('div');
    tpl.innerHTML = html;
    const node = tpl.firstElementChild;
    if (!node) return;
    node.setAttribute('data-extra', 'true');
    container.appendChild(node);
  }

  function open(merchant, event) {
    const now = new Date();
    const status = Status.getOpenStatus(merchant, now);

    const heroEl = $('detail-photo');
    heroEl.style.cssText = '';
    heroEl.innerHTML = `<img src="${photoSrc(merchant)}" alt="${merchant.name}" class="detail-hero-img"
      onerror="this.parentElement.classList.add('detail-hero--no-photo')">`;
    if (event) heroEl.style.setProperty('--detail-color', event.color);

    const badge = $('detail-event-badge');
    if (badge) {
      badge.innerHTML = event
        ? `<span class="detail-event-tag" style="background:${event.color}">${event.icon} ${event.name}</span>`
        : '';
    }

    const statusEl = $('detail-status');
    statusEl.textContent = status.label;
    statusEl.className = `detail-status-pill detail-status-pill--${status.status}`;

    $('detail-name').textContent = merchant.name;

    const dishBlock = $('detail-dish-block');
    if (merchant.dish?.name) {
      $('detail-dish').textContent =
        merchant.dish.name + (merchant.dish.price ? ' · ' + merchant.dish.price : '');
      $('detail-dish-desc').textContent = merchant.dish.description || '';
      dishBlock.style.display = '';
    } else {
      dishBlock.style.display = 'none';
    }

    $('detail-address').textContent = merchant.address;

    _clearExtras();
    const extras = _extrasForMerchant ? _extrasForMerchant(merchant) : null;
    if (extras?.infoRow)   _appendExtra('.detail-info-strip', extras.infoRow);
    if (extras?.actionBtn) _appendExtra('.detail-actions',    extras.actionBtn);

    const hoursEl = $('detail-hours');
    const rows = Status.getWeeklyScheduleDisplay(merchant);
    hoursEl.innerHTML = `<table class="detail-schedule-table">${rows.map(r => `
      <tr class="${r.isToday ? 'schedule-today' : ''} ${r.isClosed ? 'schedule-closed' : ''}">
        <td class="schedule-day">${r.day}</td>
        <td class="schedule-time">${r.schedule}</td>
      </tr>`).join('')}</table>`;

    $('detail-tags').innerHTML = (merchant.tags || []).map(t =>
      `<span class="detail-tag">${Status.getTagLabel(t)}</span>`
    ).join('');

    $('detail-btn-route').onclick = () => openRoute(merchant);

    drawer().classList.remove('detail-drawer--hidden');
    if (window.lucide) lucide.createIcons();

    $('detail-drawer-close').onclick = close;
  }

  function close() {
    drawer().classList.add('detail-drawer--hidden');
    if (_onClose) _onClose();
  }

  function isOpen() {
    const d = drawer();
    return !!(d && !d.classList.contains('detail-drawer--hidden'));
  }

  function configure({ onClose, extrasForMerchant } = {}) {
    if (onClose !== undefined)           _onClose = onClose;
    if (extrasForMerchant !== undefined) _extrasForMerchant = extrasForMerchant;
  }

  return { open, close, isOpen, configure, photoSrc, openRoute };
})();
