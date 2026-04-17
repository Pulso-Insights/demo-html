// ===== Status: Open/Closed logic, popularity, live counters =====

const Status = (() => {
  const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  /**
   * Parse time string "HH:MM" to minutes since midnight.
   */
  function timeToMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  }

  /**
   * Parse a day's schedule string into ranges.
   * Input: "13:00-15:00,20:30-22:00" or "closed"
   * Output: [{open: 780, close: 900}, {open: 1230, close: 1320}] or null
   */
  function parseSchedule(scheduleStr) {
    if (!scheduleStr || scheduleStr === 'closed') return null;
    return scheduleStr.split(',').map(range => {
      const [openStr, closeStr] = range.trim().split('-');
      return { open: timeToMinutes(openStr), close: timeToMinutes(closeStr) };
    });
  }

  /**
   * Get the schedule for a given day of the week.
   */
  function getDaySchedule(hours, dayOfWeek) {
    const key = DAY_KEYS[dayOfWeek];
    return parseSchedule(hours[key]);
  }

  /**
   * Get open status of a merchant at a given time.
   * Returns { status: 'open'|'closed'|'opening-soon'|'closing-soon', label: string }
   */
  function getOpenStatus(merchant, now) {
    if (!now) now = new Date();
    const dayOfWeek = now.getDay();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const ranges = getDaySchedule(merchant.hours, dayOfWeek);

    if (!ranges) {
      return { status: 'closed', label: 'Tancat' };
    }

    // Check if currently within any range
    for (const range of ranges) {
      if (currentMinutes >= range.open && currentMinutes < range.close) {
        const minutesUntilClose = range.close - currentMinutes;
        if (minutesUntilClose <= 30) {
          return {
            status: 'closing-soon',
            label: `Tanca en ${minutesUntilClose} min`
          };
        }
        const closeH = Math.floor(range.close / 60);
        const closeM = range.close % 60;
        const closeStr = `${closeH}:${String(closeM).padStart(2, '0')}`;
        return {
          status: 'open',
          label: `Obert · Tanca a les ${closeStr}h`
        };
      }
    }

    // Check if opening soon (within next 30 min)
    for (const range of ranges) {
      const minutesUntilOpen = range.open - currentMinutes;
      if (minutesUntilOpen > 0 && minutesUntilOpen <= 30) {
        return {
          status: 'opening-soon',
          label: `Obre en ${minutesUntilOpen} min`
        };
      }
    }

    return { status: 'closed', label: 'Tancat' };
  }

  /**
   * Get popularity level based on visits.
   */
  function getPopularity(visits) {
    if (visits > 40) return { level: 'very-popular', label: 'Molt popular', icon: '' };
    if (visits > 20) return { level: 'popular', label: 'Popular', icon: '' };
    return { level: 'normal', label: '', icon: '' };
  }

  /**
   * Get CSS classes for marker based on status and popularity.
   */
  function getMarkerClasses(merchant, now) {
    const status = getOpenStatus(merchant, now);
    const popularity = getPopularity(merchant.stats.visits);
    const classes = [`marker-${status.status}`];
    return { classes, status, popularity };
  }

  /**
   * Format status badge for list item.
   */
  function getStatusBadge(status) {
    const dotClass = `dot-${status.status}`;
    return `<span class="status-dot ${dotClass}"></span>${status.label}`;
  }

  /**
   * Get today's schedule as a display string.
   */
  function getTodayScheduleDisplay(merchant, now) {
    if (!now) now = new Date();
    const ranges = getDaySchedule(merchant.hours, now.getDay());
    if (!ranges) return 'Tancat avui';
    return ranges.map(r => {
      const oH = Math.floor(r.open / 60);
      const oM = r.open % 60;
      const cH = Math.floor(r.close / 60);
      const cM = r.close % 60;
      return `${oH}:${String(oM).padStart(2, '0')} – ${cH}:${String(cM).padStart(2, '0')}h`;
    }).join(', ');
  }

  /**
   * Get full weekly schedule as structured data for HTML rendering.
   * Returns array of { day, schedule, isToday, isClosed }
   */
  function getWeeklyScheduleDisplay(merchant) {
    const dayNames = ['Dg', 'Dl', 'Dt', 'Dc', 'Dj', 'Dv', 'Ds'];
    const today = new Date().getDay();
    const rows = [];
    for (let i = 1; i <= 7; i++) {
      const d = i % 7; // Mon=1 ... Sun=0
      const ranges = getDaySchedule(merchant.hours, d);
      const name = dayNames[d];
      if (!ranges) {
        rows.push({ day: name, schedule: 'Tancat', isToday: d === today, isClosed: true });
      } else {
        const rangeStr = ranges.map(r => {
          const oH = Math.floor(r.open / 60);
          const oM = r.open % 60;
          const cH = Math.floor(r.close / 60);
          const cM = r.close % 60;
          return `${oH}:${String(oM).padStart(2, '0')} – ${cH}:${String(cM).padStart(2, '0')}`;
        }).join(', ');
        rows.push({ day: name, schedule: rangeStr, isToday: d === today, isClosed: false });
      }
    }
    return rows;
  }

  /**
   * Count how many merchants are currently open.
   */
  function countOpen(merchants, now) {
    if (!now) now = new Date();
    return merchants.filter(m => {
      const s = getOpenStatus(m, now);
      return s.status === 'open' || s.status === 'closing-soon';
    }).length;
  }

  /**
   * Tag display names.
   */
  function getTagLabel(tag) {
    const labels = {
      'sense-gluten': 'Sense gluten',
      'vegetariana': 'Vegetariana',
      'per-emportar': 'Per emportar'
    };
    return labels[tag] || tag;
  }

  return {
    getOpenStatus,
    getPopularity,
    getMarkerClasses,
    getStatusBadge,
    getTodayScheduleDisplay,
    getWeeklyScheduleDisplay,
    countOpen,
    getTagLabel
  };
})();
