// ===== FocusMode: event focus overlay + overlap picker =====
// Manages the UI state when the user selects a specific event
// from a multi-event view. Dims other events and shows a pill
// that lets the user return to the full view.

const FocusMode = (() => {
  let activeEvent = null;
  let onEnterCb  = null;
  let onExitCb   = null;

  // ---- Public API ----

  function enter(evt, { onEnter, onExit } = {}) {
    activeEvent = evt;
    onEnterCb   = onEnter || null;
    onExitCb    = onExit  || null;

    showPill(evt);
    if (onEnterCb) onEnterCb(evt);
  }

  function exit() {
    activeEvent = null;
    hidePill();
    OverlapPicker.hide();
    if (onExitCb) onExitCb();
    onEnterCb = null;
    onExitCb  = null;
  }

  function isActive() {
    return activeEvent !== null;
  }

  // ---- Focus Pill ----

  function showPill(evt) {
    const pill = document.getElementById('focus-pill');
    if (!pill) return;

    const nameEl = pill.querySelector('#focus-event-name');
    if (nameEl) {
      nameEl.innerHTML = `<span class="focus-event-dot" style="background:${evt.color}"></span>${evt.icon} ${evt.name}`;
    }

    pill.classList.remove('hidden');
    // Trigger reflow for animation
    void pill.offsetWidth;
    pill.classList.add('visible');

    const backBtn = pill.querySelector('#focus-back');
    if (backBtn) {
      backBtn.onclick = exit;
    }
  }

  function hidePill() {
    const pill = document.getElementById('focus-pill');
    if (!pill) return;
    pill.classList.remove('visible');
    setTimeout(() => pill.classList.add('hidden'), 300);
  }

  return {
    enter,
    exit,
    isActive,
    get active() { return activeEvent; },
  };
})();


// ===== OverlapPicker: mini event picker for overlapping zones =====
// Shows a floating picker when the user hovers a zone where
// two or more events overlap, letting them choose which to focus.

const OverlapPicker = (() => {
  let hideTimeout = null;

  function show(events, containerX, containerY) {
    const picker = document.getElementById('overlap-picker');
    if (!picker) return;

    picker.innerHTML = `
      <div class="overlap-picker-label">Selecciona un event:</div>
      ${events.map(evt => `
        <button class="overlap-picker-btn" data-event-id="${evt.id}"
          style="--evt-color:${evt.color}">
          <span class="overlap-picker-dot" style="background:${evt.color}"></span>
          ${evt.icon} ${evt.name}
        </button>
      `).join('')}
    `;

    // Position near cursor, clamped to viewport
    const margin = 8;
    const pickerW = 220;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;

    let left = containerX + 12;
    let top  = containerY - 20;
    if (left + pickerW > viewW - margin) left = containerX - pickerW - 12;
    if (top < margin) top = margin;
    if (top + 120 > viewH - margin) top = viewH - 120 - margin;

    picker.style.left = `${left}px`;
    picker.style.top  = `${top}px`;

    picker.classList.remove('hidden');
    void picker.offsetWidth;
    picker.classList.add('visible');

    // Keep visible on hover
    picker.onmouseenter = () => clearTimeout(hideTimeout);
    picker.onmouseleave = () => {
      hideTimeout = setTimeout(hide, 200);
    };

    return picker;
  }

  function hide() {
    const picker = document.getElementById('overlap-picker');
    if (!picker) return;
    picker.classList.remove('visible');
    setTimeout(() => picker.classList.add('hidden'), 200);
  }

  function scheduleHide(delay = 300) {
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(hide, delay);
  }

  function cancelHide() {
    clearTimeout(hideTimeout);
  }

  return { show, hide, scheduleHide, cancelHide };
})();
