'use strict';

/* Leitrim Pool Premier League — table booking client. */
(function () {
  const $ = (id) => document.getElementById(id);

  const pad = (value) => String(value).padStart(2, '0');
  const keyOf = (date) => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  const parseKey = (key) => {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(year, month - 1, day);
  };
  const addDays = (key, delta) => {
    const date = parseKey(key);
    date.setDate(date.getDate() + delta);
    return keyOf(date);
  };
  const toMin = (time) => {
    const [hours, minutes] = String(time).split(':').map(Number);
    return hours * 60 + minutes;
  };
  const toTime = (minutes) => pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60);
  const weekStartOf = (key) => addDays(key, -parseKey(key).getDay());

  const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const shortWeekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

  const state = {
    config: null,
    selected: null,
    range: { from: null, to: null },
    bookings: [],
    mine: new Set(loadMine()),
    detail: null,
    confirmUntil: 0,
    loading: false,
    lastFocus: null,
    poll: null,
    adminPassword: null,
    adminNext: null,
    adminTables: new Set(),
    adminBookings: [],
    adminDates: [],
    adminDateSet: new Set(),
    deleteMatch: [],
    deleteConfirmUntil: 0,
    deleteFetchSeq: 0
  };

  /* ---------------------------------------------------------------- */
  /* Storage helpers                                                   */
  /* ---------------------------------------------------------------- */

  function loadMine() {
    try {
      const raw = JSON.parse(window.localStorage.getItem('lppl-my-bookings') || '[]');
      return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  function persistMine() {
    try {
      window.localStorage.setItem('lppl-my-bookings', JSON.stringify([...state.mine].slice(-300)));
    } catch {
      /* private browsing: "yours" highlighting is a nicety, not a requirement */
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  /* ---------------------------------------------------------------- */
  /* API                                                               */
  /* ---------------------------------------------------------------- */

  async function api(path, options = {}) {
    const response = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, options));

    let data = null;
    try {
      data = await response.json();
    } catch {
      /* response may have no body */
    }

    if (!response.ok) {
      const error = new Error((data && data.message) || 'Request failed (' + response.status + ')');
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  let requestSeq = 0;

  async function refresh(options = {}) {
    const seq = ++requestSeq;
    const from = weekStartOf(state.selected);
    const to = addDays(from, 6);

    state.loading = true;
    if (!options.silent) setSpinning(true);

    try {
      const data = await api('/api/bookings?from=' + from + '&to=' + to);
      if (seq !== requestSeq) return; // a newer request superseded this one
      state.range = { from, to };
      state.bookings = Array.isArray(data.bookings) ? data.bookings : [];
      setBanner(null);
    } catch (error) {
      if (seq !== requestSeq) return;
      setBanner('Live availability is unavailable right now. Showing the last data loaded.');
    } finally {
      if (seq === requestSeq) {
        state.loading = false;
        setSpinning(false);
        render();
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  function render() {
    if (!state.config) return;
    $('dateInput').value = state.selected;
    $('dateText').textContent = longDate.format(parseKey(state.selected));
    renderWeekStrip();
    renderTimeline();
  }

  function renderWeekStrip() {
    const start = weekStartOf(state.selected);
    const today = state.config.today;

    $('weekStrip').innerHTML = Array.from({ length: 7 }, (_, index) => {
      const key = addDays(start, index);
      const date = parseKey(key);
      const count = state.bookings.filter((booking) => booking.date === key).length;
      const classes = ['day-chip'];
      if (key === state.selected) classes.push('is-selected');
      if (key === today) classes.push('is-today');

      const label = longDate.format(date) + ', ' +
        (count ? count + ' booking' + (count === 1 ? '' : 's') : 'no bookings');

      return '<button type="button" class="' + classes.join(' ') + '" data-date="' + key + '" ' +
        'aria-label="' + escapeHtml(label) + '"' + (key === state.selected ? ' aria-current="date"' : '') + '>' +
        '<span class="chip-dow">' + shortWeekday.format(date) + '</span>' +
        '<span class="chip-num">' + date.getDate() + '</span>' +
        '<span class="chip-count">' + (count || '') + '</span>' +
        '</button>';
    }).join('');
  }

  function renderTimeline() {
    const config = state.config;
    const open = toMin(config.open);
    const close = toMin(config.close);
    const step = config.slotMinutes;
    const slots = Math.round((close - open) / step);

    const dayBookings = state.bookings.filter((booking) => booking.date === state.selected);
    const isToday = state.selected === config.today;
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    $('timelineTitle').textContent = longDate.format(parseKey(state.selected));
    $('timelineMeta').textContent = dayBookings.length + ' booking' + (dayBookings.length === 1 ? '' : 's') +
      ' · ' + config.tables.length + ' tables · ' + config.open + '–' + config.close;

    const occupancy = new Map(config.tables.map((table) => [table.id, new Array(slots).fill(null)]));
    const starts = new Set();

    for (const booking of dayBookings) {
      const column = occupancy.get(booking.tableId);
      if (!column) continue;
      const index = Math.round((toMin(booking.start) - open) / step);
      const length = Math.round(booking.durationMinutes / step);
      for (let offset = 0; offset < length; offset++) {
        if (index + offset >= 0 && index + offset < slots) column[index + offset] = booking;
      }
      starts.add(booking.tableId + '|' + index);
    }

    const cells = [];
    cells.push('<div class="tl-corner" style="grid-column:1;grid-row:1">Time</div>');
    config.tables.forEach((table, index) => {
      cells.push('<div class="tl-table-head" style="grid-column:' + (index + 2) + ';grid-row:1">' +
        escapeHtml(table.name) + '</div>');
    });

    for (let slot = 0; slot < slots; slot++) {
      const minutes = open + slot * step;
      const row = slot + 2;

      cells.push('<div class="tl-time' + (minutes % 60 === 0 ? ' is-hour' : '') +
        '" style="grid-column:1;grid-row:' + row + '">' + toTime(minutes) + '</div>');

      config.tables.forEach((table, tableIndex) => {
        const column = tableIndex + 2;
        const booking = occupancy.get(table.id)[slot];

        if (!booking) {
          const past = isToday && minutes < nowMinutes;
          cells.push('<button type="button" class="tl-free' + (past ? ' is-past' : '') + '" ' +
            'style="grid-column:' + column + ';grid-row:' + row + '" ' +
            'data-table="' + escapeHtml(table.id) + '" data-start="' + toTime(minutes) + '"' +
            (past ? ' disabled' : '') +
            ' aria-label="' + escapeHtml('Book ' + table.name + ' at ' + toTime(minutes)) + '"></button>');
          return;
        }

        if (!starts.has(table.id + '|' + slot)) return;

        const span = Math.min(
          Math.max(1, Math.round(booking.durationMinutes / step)),
          slots - slot
        );
        const mine = state.mine.has(booking.id);
        const blocked = booking.blocked === true;
        const past = isToday && toMin(booking.start) < nowMinutes;
        const fullLabel = (blocked ? 'Blocked: ' + booking.name : booking.name) + ', ' +
          booking.tableName + ', ' + booking.start + '–' + booking.end +
          (mine ? ', your booking' : '');

        cells.push('<button type="button" class="tl-booked' +
          (blocked ? ' is-blocked' : mine ? ' is-mine' : '') +
          (span === 1 ? ' is-short' : '') + (past ? ' is-over' : '') + '" ' +
          'style="grid-column:' + column + ';grid-row:' + row + ' / span ' + span + '" ' +
          'data-booking="' + escapeHtml(booking.id) + '" ' +
          'aria-label="' + escapeHtml(fullLabel) + '" ' +
          'title="' + escapeHtml(fullLabel) + '">' +
          '<span class="tb-name">' + escapeHtml(booking.name) + '</span>' +
          '<span class="tb-time">' + booking.start + '–' + booking.end + '</span>' +
          (blocked ? '<span class="tb-badge">Block</span>' : mine ? '<span class="tb-badge">You</span>' : '') +
          '</button>');
      });
    }

    const timeline = $('timeline');
    timeline.style.setProperty('--tables', config.tables.length);
    timeline.innerHTML = cells.join('');
  }

  /* ---------------------------------------------------------------- */
  /* Sheets                                                            */
  /* ---------------------------------------------------------------- */

  function openSheet(id) {
    if (!state.lastFocus) state.lastFocus = document.activeElement;
    $('overlay').hidden = false;
    $(id).hidden = false;
    document.body.classList.add('no-scroll');
  }

  function closeSheets() {
    $('overlay').hidden = true;
    $('bookSheet').hidden = true;
    $('detailSheet').hidden = true;
    $('editSheet').hidden = true;
    $('passwordSheet').hidden = true;
    $('adminSheet').hidden = true;
    $('deleteSheet').hidden = true;
    document.body.classList.remove('no-scroll');
    state.detail = null;
    state.confirmUntil = 0;
    state.adminNext = null;

    const cancelButton = $('cancelBooking');
    cancelButton.textContent = 'Cancel booking';
    cancelButton.classList.remove('is-confirm');
    cancelButton.disabled = false;

    if (state.lastFocus && typeof state.lastFocus.focus === 'function') {
      state.lastFocus.focus();
    }
    state.lastFocus = null;
  }

  function tableName(tableId) {
    const table = state.config.tables.find((item) => item.id === tableId);
    return table ? table.name : 'a table';
  }

  function buildTableOptions() {
    $('fTable').innerHTML = state.config.tables.map((table) =>
      '<option value="' + escapeHtml(table.id) + '">' + escapeHtml(table.name) + '</option>'
    ).join('');
  }

  function earliestStartMinutes() {
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const open = toMin(state.config.open);
    const step = state.config.slotMinutes;
    return open + Math.max(0, Math.ceil((nowMinutes - open) / step)) * step;
  }

  function buildStartOptions(selectId = 'fStart', date = null) {
    const open = toMin(state.config.open);
    const close = toMin(state.config.close);
    const step = state.config.slotMinutes;
    const earliest = date === state.config.today ? earliestStartMinutes() : open;
    const options = [];

    for (let minutes = open; minutes + state.config.minDuration <= close; minutes += step) {
      if (minutes < earliest) continue;
      options.push(toTime(minutes));
    }

    $(selectId).innerHTML = options.map((value) =>
      '<option value="' + value + '">' + value + '</option>'
    ).join('');
  }

  function buildDurationOptions(start, preferred, selectId = 'fDuration') {
    const close = toMin(state.config.close);
    const latest = Math.min(state.config.maxDuration, close - toMin(start));
    const options = [];

    for (let duration = state.config.minDuration; duration <= latest; duration += state.config.slotMinutes) {
      options.push(duration);
    }
    if (options.length === 0) options.push(state.config.minDuration);

    let chosen = Number(preferred);
    if (options.indexOf(chosen) === -1) {
      const fallback = Number(state.config.defaultDuration);
      const fitting = Number.isFinite(fallback)
        ? options.filter((duration) => duration <= fallback)
        : [];
      chosen = fitting.length ? fitting[fitting.length - 1] : options[options.length - 1];
    }

    $(selectId).innerHTML = options.map((duration) =>
      '<option value="' + duration + '">' + durationLabel(duration) + '</option>'
    ).join('');
    $(selectId).value = String(chosen);
  }

  function durationLabel(minutes) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return rest + ' min';
    return hours + ' hr' + (hours > 1 ? 's' : '') + (rest ? ' ' + rest : '');
  }

  function updateEnd() {
    const start = $('fStart').value;
    const duration = Number($('fDuration').value);
    $('fEnd').value = start ? toTime(toMin(start) + duration) : '';
  }

  function setBookDate(date, preferredStart) {
    const chosen = date < state.config.today ? state.config.today : date;
    $('fDate').value = chosen;
    $('bookDateLabel').textContent = longDate.format(parseKey(chosen));

    buildStartOptions('fStart', chosen);
    const options = Array.from($('fStart').options, (option) => option.value);
    if (!options.length) return false;

    const wanted = preferredStart || $('fStart').value || state.config.defaultStart || state.config.open;
    const earliest = chosen === state.config.today ? earliestStartMinutes() : toMin(state.config.open);
    let start = toMin(wanted) < earliest ? toTime(earliest) : wanted;
    if (options.indexOf(start) === -1) start = options[0];
    $('fStart').value = start;
    return true;
  }

  function openBookSheet(tableId, start) {
    state.lastFocus = document.activeElement;
    $('bookForm').reset();
    hideBookError();

    const table = tableId || (state.config.tables[0] && state.config.tables[0].id);
    $('bookTitle').textContent = 'Book ' + tableName(table);

    buildTableOptions();
    $('fTable').value = table;
    $('fDate').min = state.config.today;
    $('fDate').max = addDays(state.config.today, 365);
    if (!setBookDate(state.selected, start)) {
      toast('No times left today. Choose a future date.');
      return;
    }
    buildDurationOptions($('fStart').value, state.config.defaultDuration);
    updateEnd();

    openSheet('bookSheet');
    $('fName').focus();
  }

  function showBookError(message) {
    $('bookError').textContent = message;
    $('bookError').hidden = false;
  }

  function hideBookError() {
    $('bookError').hidden = true;
    $('bookError').textContent = '';
  }

  function openDetail(booking) {
    state.detail = booking;
    state.confirmUntil = 0;

    $('detailEyebrow').textContent = booking.blocked === true
      ? 'Blocked table'
      : state.mine.has(booking.id) ? 'Your booking' : 'Booking';
    $('detailTitle').textContent = booking.tableName;
    $('dTable').textContent = booking.tableName;
    $('dTime').textContent = booking.start + '–' + booking.end;
    $('dDate').textContent = longDate.format(parseKey(booking.date));
    $('dName').textContent = booking.name;

    $('dNotesWrap').hidden = !booking.notes;
    $('dNotes').textContent = booking.notes || '';
    $('detailError').hidden = true;

    const cancelButton = $('cancelBooking');
    cancelButton.textContent = booking.blocked === true ? 'Remove block' : 'Cancel booking';
    cancelButton.classList.remove('is-confirm');
    cancelButton.disabled = false;

    state.lastFocus = document.activeElement;
    openSheet('detailSheet');
  }

  function showEditError(message) {
    $('editError').textContent = message;
    $('editError').hidden = false;
  }

  function hideEditError() {
    $('editError').hidden = true;
    $('editError').textContent = '';
  }

  function updateEditEnd() {
    const start = $('eStart').value;
    const duration = Number($('eDuration').value);
    $('eEnd').value = start ? toTime(toMin(start) + duration) : '';
  }

  function openEditSheet(booking) {
    state.detail = booking;
    hideEditError();

    $('editForm').reset();
    $('editTitle').textContent = booking.blocked === true
      ? 'Edit block time'
      : 'Edit ' + booking.tableName;
    $('editBookingLabel').textContent = booking.name + ' · ' + booking.tableName;

    $('eDate').value = booking.date;
    $('eDate').min = addDays(state.config.today, -1);
    $('eDate').max = addDays(state.config.today, 365);

    buildStartOptions('eStart');
    $('eStart').value = booking.start;
    buildDurationOptions(booking.start, booking.durationMinutes, 'eDuration');
    updateEditEnd();

    $('detailSheet').hidden = true;
    openSheet('editSheet');
    $('eStart').focus();
  }

  async function submitEdit(event) {
    event.preventDefault();

    const booking = state.detail;
    if (!booking) return;

    const date = $('eDate').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      showEditError('Choose a valid date.');
      return;
    }

    const button = $('submitEdit');
    button.disabled = true;
    button.textContent = 'Saving…';
    hideEditError();

    const headers = { 'Content-Type': 'application/json' };
    if (booking.blocked === true) headers['x-admin-password'] = state.adminPassword || '';

    try {
      const updated = await api('/api/bookings/' + encodeURIComponent(booking.id), {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          date,
          start: $('eStart').value,
          durationMinutes: Number($('eDuration').value)
        })
      });

      closeSheets();
      toast(updated.tableName + ' updated · ' + updated.start + '–' + updated.end);
      await refresh({ silent: true });
    } catch (error) {
      if (error.status === 409 && error.data && error.data.conflict) {
        const conflict = error.data.conflict;
        showEditError('Clash: ' + conflict.name + ' has ' + conflict.tableName + ' from ' +
          conflict.start + ' to ' + conflict.end + '. Choose another time or date.');
        await refresh({ silent: true });
      } else if (error.status === 401) {
        state.adminPassword = null;
        showEditError('Schedule password expired. Tap Edit time again to re-enter it.');
      } else {
        showEditError(error.message);
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Save changes';
    }
  }

  async function submitBooking(event) {
    event.preventDefault();

    const name = $('fName').value.trim();
    if (!name) {
      showBookError('Please enter a name for the booking.');
      $('fName').focus();
      return;
    }

    const date = $('fDate').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < state.config.today) {
      showBookError('Choose today or a future date.');
      $('fDate').focus();
      return;
    }
    if (date === state.config.today && toMin($('fStart').value) < earliestStartMinutes()) {
      showBookError('That time has already passed. Choose a later slot.');
      return;
    }

    const payload = {
      name,
      tableId: $('fTable').value,
      date,
      start: $('fStart').value,
      durationMinutes: Number($('fDuration').value)
    };

    const button = $('submitBook');
    button.disabled = true;
    button.textContent = 'Booking…';
    hideBookError();

    try {
      const booking = await api('/api/bookings', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      state.mine.add(booking.id);
      persistMine();

      closeSheets();
      toast(booking.tableName + ' booked · ' + booking.start + '–' + booking.end);
      await refresh({ silent: true });
    } catch (error) {
      if (error.status === 409 && error.data && error.data.conflict) {
        const conflict = error.data.conflict;
        showBookError('Clash: ' + conflict.name + ' has ' + conflict.tableName + ' from ' +
          conflict.start + ' to ' + conflict.end + '. Choose another table or time.');
        await refresh({ silent: true });
      } else {
        showBookError(error.message);
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Book table';
    }
  }

  async function handleCancel(verified = false) {
    const booking = state.detail;
    if (!booking) return;

    const blocked = booking.blocked === true;
    const label = blocked ? 'Remove block' : 'Cancel booking';
    const button = $('cancelBooking');

    if (!verified && Date.now() > state.confirmUntil) {
      state.confirmUntil = Date.now() + 4000;
      button.textContent = 'Tap again to confirm';
      button.classList.add('is-confirm');
      window.setTimeout(() => {
        if (Date.now() >= state.confirmUntil) {
          button.textContent = label;
          button.classList.remove('is-confirm');
        }
      }, 4100);
      return;
    }

    if (blocked && !state.adminPassword) {
      requestAdminPassword(() => handleCancel(true), 'Enter the password to remove this block.');
      return;
    }

    button.disabled = true;
    button.textContent = blocked ? 'Removing…' : 'Cancelling…';

    const options = { method: 'DELETE' };
    if (blocked) options.headers = { 'x-admin-password': state.adminPassword || '' };

    try {
      await api('/api/bookings/' + encodeURIComponent(booking.id), options);
      state.mine.delete(booking.id);
      persistMine();
      closeSheets();
      toast(blocked ? 'Block removed' : 'Booking cancelled');
      await refresh({ silent: true });
    } catch (error) {
      $('detailError').textContent = error.message;
      $('detailError').hidden = false;
      button.disabled = false;
      button.textContent = label;
      button.classList.remove('is-confirm');
      if (error.status === 401) state.adminPassword = null;
      await refresh({ silent: true });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Admin schedule                                                    */
  /* ---------------------------------------------------------------- */

  let adminFetchSeq = 0;

  function showPasswordError(message) {
    $('passwordError').textContent = message;
    $('passwordError').hidden = false;
  }

  function hidePasswordError() {
    $('passwordError').hidden = true;
    $('passwordError').textContent = '';
  }

  function requestAdminPassword(onSuccess, message) {
    if (state.adminPassword) {
      onSuccess();
      return;
    }

    state.adminNext = onSuccess;
    $('passwordHint').textContent = message || 'Enter the password to block tables.';
    $('adminPasswordInput').value = '';
    hidePasswordError();
    openSheet('passwordSheet');
    $('adminPasswordInput').focus();
  }

  async function submitPassword(event) {
    event.preventDefault();

    const supplied = $('adminPasswordInput').value.trim();
    if (!supplied) {
      showPasswordError('Enter the password.');
      $('adminPasswordInput').focus();
      return;
    }

    const button = $('submitPassword');
    button.disabled = true;
    button.textContent = 'Checking…';
    hidePasswordError();

    try {
      await api('/api/admin/verify', {
        method: 'POST',
        body: JSON.stringify({ password: supplied })
      });

      state.adminPassword = supplied;
      const next = state.adminNext;
      state.adminNext = null;
      $('adminPasswordInput').value = '';

      // Leave any sheet underneath (e.g. booking details) untouched.
      $('passwordSheet').hidden = true;
      if (typeof next === 'function') next();
    } catch (error) {
      if (error.status === 401) {
        showPasswordError('Incorrect password. Please try again.');
        $('adminPasswordInput').select();
      } else {
        showPasswordError(error.message || 'Could not check the password. Try again.');
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Unlock';
    }
  }

  function showAdminError(message) {
    $('adminError').textContent = message;
    $('adminError').hidden = false;
  }

  function hideAdminError() {
    $('adminError').hidden = true;
    $('adminError').textContent = '';
  }

  /* --- Outlook-style recurrence ------------------------------------ */

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function numValue(id, min, max, fallback) {
    const raw = Number($(id).value);
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(raw)));
  }

  function checkedValue(name, fallback) {
    const chosen = document.querySelector('input[name="' + name + '"]:checked');
    return chosen ? chosen.value : fallback;
  }

  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  function nthWeekday(year, month, weekday, ordinal) {
    if (ordinal === 5) {
      const last = new Date(year, month + 1, 0);
      return last.getDate() - ((last.getDay() - weekday + 7) % 7);
    }
    const firstDay = new Date(year, month, 1).getDay();
    return 1 + ((weekday - firstDay + 7) % 7) + (ordinal - 1) * 7;
  }

  function buildMonthOptions() {
    const html = MONTH_NAMES.map((name, index) =>
      '<option value="' + (index + 1) + '">' + name + '</option>').join('');
    $('aYearlyMonth').innerHTML = html;
    $('aYearlyMonthNth').innerHTML = html;
  }

  function updateRecurPanels() {
    const type = $('aRecur').value;
    $('aRecurDaily').hidden = type !== 'daily';
    $('aRecurWeekly').hidden = type !== 'weekly';
    $('aRecurMonthly').hidden = type !== 'monthly';
    $('aRecurYearly').hidden = type !== 'yearly';
  }

  function defaultWeeklyDay() {
    if (document.querySelector('#aWeekdays input:checked')) return;
    const date = $('aDate').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const box = document.querySelector('#aWeekdays input[value="' + parseKey(date).getDay() + '"]');
    if (box) box.checked = true;
  }

  function generateRecurDates() {
    const start = $('aDate').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return [];

    const type = $('aRecur').value;
    const maxDate = addDays(state.config.today, 365);
    const rangeMode = checkedValue('rangeMode', 'never');
    let endKey = maxDate;
    let maxCount = 366;

    if (rangeMode === 'date') {
      const chosen = $('aEndDate').value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(chosen) && chosen < maxDate) endKey = chosen;
    } else if (rangeMode === 'count') {
      maxCount = numValue('aOccurrences', 1, 366, 10);
    }

    const startKey = start < state.config.today ? state.config.today : start;
    const out = [];
    const seen = new Set();
    const add = (key) => {
      if (key < startKey || key > endKey || seen.has(key)) return;
      seen.add(key);
      out.push(key);
    };

    const startDate = parseKey(startKey);
    const startYear = startDate.getFullYear();
    const startMonth = startDate.getMonth();

    if (type === 'once') {
      add(startKey);
    } else if (type === 'daily') {
      const cursor = parseKey(startKey);
      if (checkedValue('dailyMode', 'every') === 'weekdays') {
        while (keyOf(cursor) <= endKey && out.length < maxCount) {
          if (cursor.getDay() >= 1 && cursor.getDay() <= 5) add(keyOf(cursor));
          cursor.setDate(cursor.getDate() + 1);
        }
      } else {
        const every = numValue('aDailyEvery', 1, 30, 1);
        while (keyOf(cursor) <= endKey && out.length < maxCount) {
          add(keyOf(cursor));
          cursor.setDate(cursor.getDate() + every);
        }
      }
    } else if (type === 'weekly') {
      const every = numValue('aWeeklyEvery', 1, 12, 1);
      const weekdays = [...document.querySelectorAll('#aWeekdays input:checked')].map((box) => Number(box.value));
      if (weekdays.length === 0) {
        add(startKey);
      } else {
        const cursor = parseKey(addDays(startKey, -startDate.getDay()));
        while (out.length < maxCount) {
          const weekKey = keyOf(cursor);
          if (weekKey > endKey) break;
          for (const weekday of weekdays) {
            const key = addDays(weekKey, weekday);
            if (key > endKey) break;
            add(key);
            if (out.length >= maxCount) break;
          }
          cursor.setDate(cursor.getDate() + 7 * every);
        }
      }
    } else if (type === 'monthly') {
      let year = startYear;
      let month = startMonth;
      if (checkedValue('monthlyMode', 'day') === 'day') {
        const day = numValue('aMonthlyDay', 1, 31, 1);
        const every = numValue('aMonthlyEvery', 1, 12, 1);
        while (out.length < maxCount && keyOf(new Date(year, month, 1)) <= endKey) {
          if (day <= daysInMonth(year, month)) add(keyOf(new Date(year, month, day)));
          month += every;
          year += Math.floor(month / 12);
          month %= 12;
        }
      } else {
        const ordinal = numValue('aMonthlyOrdinal', 1, 5, 1);
        const weekday = numValue('aMonthlyWeekday', 0, 6, 1);
        const every = numValue('aMonthlyEveryNth', 1, 12, 1);
        while (out.length < maxCount && keyOf(new Date(year, month, 1)) <= endKey) {
          add(keyOf(new Date(year, month, nthWeekday(year, month, weekday, ordinal))));
          month += every;
          year += Math.floor(month / 12);
          month %= 12;
        }
      }
    } else if (type === 'yearly') {
      const byDate = checkedValue('yearlyMode', 'date') === 'date';
      const every = numValue(byDate ? 'aYearlyEvery' : 'aYearlyEveryNth', 1, 5, 1);
      let year = startYear;
      if (byDate) {
        const month = numValue('aYearlyMonth', 1, 12, 1) - 1;
        const day = numValue('aYearlyDay', 1, 31, 1);
        while (out.length < maxCount && keyOf(new Date(year, 0, 1)) <= endKey) {
          if (day <= daysInMonth(year, month)) add(keyOf(new Date(year, month, day)));
          year += every;
        }
      } else {
        const month = numValue('aYearlyMonthNth', 1, 12, 1) - 1;
        const ordinal = numValue('aYearlyOrdinal', 1, 5, 1);
        const weekday = numValue('aYearlyWeekday', 0, 6, 1);
        while (out.length < maxCount && keyOf(new Date(year, 0, 1)) <= endKey) {
          add(keyOf(new Date(year, month, nthWeekday(year, month, weekday, ordinal))));
          year += every;
        }
      }
    }

    out.sort();
    return out.slice(0, maxCount);
  }

  function updateAdminDateLabel() {
    const dates = state.adminDates;
    $('adminDateLabel').textContent = dates.length === 0
      ? 'No dates selected'
      : dates.length === 1
        ? longDate.format(parseKey(dates[0]))
        : dates.length + ' dates · ' + longDate.format(parseKey(dates[0])) +
          ' → ' + longDate.format(parseKey(dates[dates.length - 1]));
  }

  function refreshAdminDates() {
    state.adminDates = generateRecurDates();
    state.adminDateSet = new Set(state.adminDates);

    if (!state.adminDates.length) {
      $('aRecurSummary').textContent = 'No dates in the next year — move the start date earlier.';
    } else {
      const first = longDate.format(parseKey(state.adminDates[0]));
      const last = state.adminDates.length > 1
        ? ' → ' + longDate.format(parseKey(state.adminDates[state.adminDates.length - 1]))
        : '';
      $('aRecurSummary').textContent = state.adminDates.length + ' occurrence' +
        (state.adminDates.length === 1 ? '' : 's') + ' · ' + first + last;
    }

    updateAdminDateLabel();
    updateAdminPreview();
    renderAdminTables();
  }

  async function fetchBookingsForDates(dates) {
    if (!dates.length) return [];
    const from = dates[0];
    const to = dates[dates.length - 1];
    const list = [];
    let cursor = from;

    while (cursor <= to) {
      let end = addDays(cursor, 61);
      if (end > to) end = to;
      const data = await api('/api/bookings?from=' + cursor + '&to=' + end);
      if (Array.isArray(data.bookings)) list.push(...data.bookings);
      cursor = addDays(end, 1);
    }
    return list;
  }

  function updateAdminEnd() {
    const start = $('aStart').value;
    const duration = Number($('aDuration').value);
    $('aEnd').value = start ? toTime(toMin(start) + duration) : '';
  }

  function adminBusy(tableId) {
    const start = toMin($('aStart').value);
    const end = start + Number($('aDuration').value);
    return state.adminBookings.find((booking) => {
      if (booking.tableId !== tableId) return false;
      if (!state.adminDateSet.has(booking.date)) return false;
      const otherStart = toMin(booking.start);
      return otherStart < end && start < otherStart + booking.durationMinutes;
    });
  }

  function updateAdminPreview() {
    const dates = state.adminDates;
    const names = state.config.tables
      .filter((table) => state.adminTables.has(table.id))
      .map((table) => table.name);
    let when = 'Choose a date';
    if (dates.length === 1) {
      when = longDate.format(parseKey(dates[0])) + ' · ' + $('aStart').value + '–' + $('aEnd').value;
    } else if (dates.length > 1) {
      when = dates.length + ' dates (from ' + longDate.format(parseKey(dates[0])) + ') · ' +
        $('aStart').value + '–' + $('aEnd').value;
    }
    $('aPreview').textContent = when + ' · ' + (names.length ? names.join(', ') : 'no tables selected');
  }

  function renderAdminTables() {
    for (const id of [...state.adminTables]) {
      if (adminBusy(id)) state.adminTables.delete(id);
    }

    const tables = state.config.tables;
    const freeTables = tables.filter((table) => !adminBusy(table.id));
    const allSelected = freeTables.length > 0 && freeTables.every((table) => state.adminTables.has(table.id));
    $('aAllTables').textContent = allSelected ? 'Clear all' : 'Select all';

    $('aTables').innerHTML = tables.map((table) => {
      const busy = adminBusy(table.id);
      const selected = state.adminTables.has(table.id);
      const status = busy
        ? (state.adminDates.length > 1 ? 'Busy in series' : 'Busy ' + busy.start + '–' + busy.end)
        : 'Free';
      return '<button type="button" class="table-choice' + (selected ? ' is-selected' : '') +
        (busy ? ' is-busy' : '') + '" data-table="' + escapeHtml(table.id) + '"' +
        (busy ? ' disabled' : '') + ' aria-pressed="' + (selected ? 'true' : 'false') + '">' +
        '<span class="tc-name">' + escapeHtml(table.name) + '</span>' +
        '<span class="tc-status">' + escapeHtml(status) + '</span>' +
        '</button>';
    }).join('');

    updateAdminPreview();
  }

  async function loadAdminBookings() {
    refreshAdminDates();
    const dates = state.adminDates;
    const seq = ++adminFetchSeq;

    try {
      const list = dates.length ? await fetchBookingsForDates(dates) : [];
      if (seq !== adminFetchSeq) return;
      state.adminBookings = list;
    } catch {
      if (seq !== adminFetchSeq) return;
      state.adminBookings = [];
    }
    renderAdminTables();
  }

  function openAdminSheet() {
    state.lastFocus = document.activeElement;
    $('adminForm').reset();
    hideAdminError();
    state.adminTables.clear();
    state.adminBookings = [];

    $('aDate').value = state.selected;
    $('aDate').min = state.config.today;
    $('aDate').max = addDays(state.config.today, 365);
    $('aEndDate').min = state.config.today;
    $('aEndDate').max = addDays(state.config.today, 365);

    $('aRecur').value = 'once';
    updateRecurPanels();
    document.querySelectorAll('#aWeekdays input').forEach((box) => { box.checked = false; });
    buildMonthOptions();

    const selectedDate = parseKey(state.selected);
    $('aMonthlyDay').value = String(selectedDate.getDate());
    $('aYearlyDay').value = String(selectedDate.getDate());
    $('aYearlyMonth').value = String(selectedDate.getMonth() + 1);
    $('aYearlyMonthNth').value = String(selectedDate.getMonth() + 1);

    buildStartOptions('aStart');
    $('aStart').value = state.config.defaultStart || state.config.open;
    buildDurationOptions($('aStart').value, state.config.defaultDuration, 'aDuration');
    updateAdminEnd();

    openSheet('adminSheet');
    loadAdminBookings();
  }

  async function submitAdmin(event) {
    event.preventDefault();

    if (!state.adminDates.length) {
      showAdminError('Choose a valid start date for the schedule.');
      return;
    }
    if (state.adminTables.size === 0) {
      showAdminError('Select at least one table to block.');
      return;
    }

    const label = $('aLabel').value.trim();
    if (!label) {
      showAdminError('Enter a label for this schedule.');
      $('aLabel').focus();
      return;
    }

    const button = $('submitAdmin');
    button.disabled = true;
    button.textContent = 'Blocking…';
    hideAdminError();

    try {
      const result = await api('/api/blocks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': state.adminPassword || ''
        },
        body: JSON.stringify({
          tableIds: [...state.adminTables],
          dates: state.adminDates,
          start: $('aStart').value,
          durationMinutes: Number($('aDuration').value),
          label
        })
      });

      const conflicts = result.conflicts || [];
      const skipped = conflicts.slice(0, 3).map((item) => item.tableName + ' on ' + item.date).join(', ') +
        (conflicts.length > 3 ? '…' : '');
      const count = (result.created || []).length;
      const dateCount = result.dates || state.adminDates.length;
      closeSheets();
      state.selected = state.adminDates[0];
      toast('Blocked ' + count + ' table' + (count === 1 ? '' : 's') +
        (dateCount > 1 ? ' across ' + dateCount + ' dates' : '') +
        (skipped ? ' · clashes: ' + skipped : ''));
      await refresh({ silent: true });
    } catch (error) {
      if (error.status === 401) {
        state.adminPassword = null;
        showAdminError('Password expired. Reopen Create schedule to enter it again.');
      } else {
        showAdminError(error.message);
        await loadAdminBookings();
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Block tables';
    }
  }

  /* ---------------------------------------------------------------- */
  /* Delete schedule                                                   */
  /* ---------------------------------------------------------------- */

  function showDeleteError(message) {
    $('deleteError').textContent = message;
    $('deleteError').hidden = false;
  }

  function hideDeleteError() {
    $('deleteError').hidden = true;
    $('deleteError').textContent = '';
  }

  function resetDeleteConfirm() {
    state.deleteConfirmUntil = 0;
    $('confirmDelete').textContent = 'Delete schedule';
    $('confirmDelete').classList.remove('is-confirm');
    $('deleteHint').hidden = true;
  }

  function openDeleteSheet() {
    state.deleteMatch = [];
    state.deleteFetchSeq++;
    $('dLabel').value = '';
    $('deleteResults').hidden = true;
    $('deleteList').innerHTML = '';
    $('confirmDelete').hidden = true;
    resetDeleteConfirm();
    hideDeleteError();
    openSheet('deleteSheet');
    $('dLabel').focus();
  }

  function renderDeleteResults() {
    const matches = state.deleteMatch;
    const label = matches.length ? matches[0].name : $('dLabel').value.trim();
    const dates = new Set(matches.map((item) => item.date));
    const count = matches.length;

    $('deleteResults').hidden = false;
    $('deleteCount').textContent = count
      ? label + ' · ' + count + ' block' + (count === 1 ? '' : 's') + ' on ' +
        dates.size + ' date' + (dates.size === 1 ? '' : 's')
      : 'No schedule found for “' + label + '”.';
    $('deleteList').innerHTML = matches.map((item) =>
      '<div class="delete-row">' + escapeHtml(longDate.format(parseKey(item.date))) +
      ' · ' + escapeHtml(item.tableName) + ' · ' + escapeHtml(item.start + '–' + item.end) +
      '<span>' + escapeHtml(item.name) + '</span></div>').join('');
    $('confirmDelete').hidden = count === 0;
    resetDeleteConfirm();
  }

  async function findSchedule(event) {
    event.preventDefault();
    const query = $('dLabel').value.trim().toLowerCase();
    if (!query) {
      showDeleteError('Enter the label of the schedule to delete.');
      return;
    }
    hideDeleteError();
    const seq = ++state.deleteFetchSeq;
    const button = $('findSchedule');
    button.disabled = true;
    button.textContent = 'Searching…';

    try {
      const list = await fetchBookingsForDates([state.config.today, addDays(state.config.today, 365)]);
      if (seq !== state.deleteFetchSeq) return;
      const blocks = list.filter((item) => item.blocked === true);
      const exact = blocks.filter((item) => item.name.toLowerCase() === query);
      state.deleteMatch = exact.length
        ? exact
        : blocks.filter((item) => item.name.toLowerCase().includes(query));
      renderDeleteResults();
    } catch {
      if (seq === state.deleteFetchSeq) showDeleteError('Could not load schedules. Try again.');
    } finally {
      if (seq === state.deleteFetchSeq) {
        button.disabled = false;
        button.textContent = 'Find schedule';
      }
    }
  }

  async function deleteSchedule() {
    const matches = state.deleteMatch;
    if (!matches.length || $('confirmDelete').disabled) return;

    if (state.deleteConfirmUntil <= Date.now()) {
      state.deleteConfirmUntil = Date.now() + 5000;
      $('confirmDelete').textContent = 'Tap again to confirm';
      $('confirmDelete').classList.add('is-confirm');
      $('deleteHint').hidden = false;
      return;
    }

    const button = $('confirmDelete');
    const label = matches[0].name;
    button.disabled = true;
    button.textContent = 'Deleting…';
    hideDeleteError();

    try {
      const result = await api('/api/blocks?label=' + encodeURIComponent(label), {
        method: 'DELETE',
        headers: { 'x-admin-password': state.adminPassword || '' }
      });
      const removed = Array.isArray(result.removed) ? result.removed.length : 0;
      state.deleteMatch = [];
      renderDeleteResults();
      await refresh({ silent: true });
      toast('Deleted ' + removed + ' block' + (removed === 1 ? '' : 's') +
        ' from “' + label + '”.');
    } catch (error) {
      if (error.status === 401) {
        state.adminPassword = null;
        showDeleteError('Password expired. Reopen Delete schedule to enter it again.');
      } else {
        showDeleteError(error.message);
      }
    } finally {
      button.disabled = false;
      resetDeleteConfirm();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Misc UI                                                           */
  /* ---------------------------------------------------------------- */

  let toastTimer = null;

  function toast(message) {
    const element = $('toast');
    element.textContent = message;
    element.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { element.hidden = true; }, 2800);
  }

  function setBanner(message) {
    const banner = $('statusBanner');
    if (!message) {
      banner.hidden = true;
      banner.textContent = '';
      return;
    }
    banner.textContent = message;
    banner.hidden = false;
  }

  function setSpinning(active) {
    $('refreshBtn').classList.toggle('is-spinning', Boolean(active));
  }

  function showFatal(message) {
    $('timelineTitle').textContent = 'Unavailable';
    $('timelineMeta').textContent = '';
    $('timeline').innerHTML = '<div class="timeline-empty">' + escapeHtml(message) + '</div>';
    setBanner(message);
  }

  function goToDate(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
    state.selected = key;

    const inRange = state.range.from && key >= state.range.from && key <= state.range.to;
    if (inRange) {
      render();
    } else {
      refresh({ silent: true });
    }
  }

  function legacyCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    document.body.removeChild(area);
  }

  async function share() {
    const url = window.location.href;
    if (window.location.protocol === 'file:') {
      toast('Host this app online to share a link');
      return;
    }

    if (navigator.share) {
      try {
        await navigator.share({ title: document.title, text: 'Book a pool table', url });
        return;
      } catch (error) {
        if (error && error.name === 'AbortError') return;
      }
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        legacyCopy(url);
      }
      toast('Link copied');
    } catch {
      toast('Could not copy the link');
    }
  }

  function startPolling() {
    window.clearInterval(state.poll);
    state.poll = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !state.loading) refresh({ silent: true });
    }, 20000);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !state.loading) refresh({ silent: true });
    });

    window.addEventListener('focus', () => {
      if (!state.loading) refresh({ silent: true });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  function bind() {
    $('prevDay').addEventListener('click', () => goToDate(addDays(state.selected, -1)));
    $('nextDay').addEventListener('click', () => goToDate(addDays(state.selected, 1)));
    $('todayBtn').addEventListener('click', () => goToDate(state.config.today));

    $('dateInput').addEventListener('change', (event) => {
      if (event.target.value) goToDate(event.target.value);
    });

    $('weekStrip').addEventListener('click', (event) => {
      const chip = event.target.closest('[data-date]');
      if (chip) goToDate(chip.dataset.date);
    });

    $('timeline').addEventListener('click', (event) => {
      const booked = event.target.closest('[data-booking]');
      if (booked) {
        const booking = state.bookings.find((item) => item.id === booked.dataset.booking);
        if (booking) openDetail(booking);
        return;
      }

      const free = event.target.closest('[data-table][data-start]');
      if (free && !free.disabled) openBookSheet(free.dataset.table, free.dataset.start);
    });

    $('bookTableBtn').addEventListener('click', () => openBookSheet());
    $('scheduleBtn').addEventListener('click', () =>
      requestAdminPassword(openAdminSheet, 'Enter the password to block tables.'));
    $('deleteScheduleBtn').addEventListener('click', () =>
      requestAdminPassword(openDeleteSheet, 'Enter the password to delete schedules.'));

    $('passwordForm').addEventListener('submit', submitPassword);
    $('cancelPassword').addEventListener('click', closeSheets);
    $('closePassword').addEventListener('click', closeSheets);

    $('adminForm').addEventListener('submit', submitAdmin);
    $('cancelAdmin').addEventListener('click', closeSheets);
    $('closeAdmin').addEventListener('click', closeSheets);

    $('deleteForm').addEventListener('submit', findSchedule);
    $('confirmDelete').addEventListener('click', deleteSchedule);
    $('dLabel').addEventListener('input', () => {
      $('deleteResults').hidden = true;
      state.deleteMatch = [];
      resetDeleteConfirm();
      hideDeleteError();
    });
    $('closeDelete').addEventListener('click', closeSheets);
    $('cancelDelete').addEventListener('click', closeSheets);
    $('aDate').addEventListener('change', () => {
      if ($('aRecur').value === 'weekly') defaultWeeklyDay();
      loadAdminBookings();
    });
    $('aRecur').addEventListener('change', () => {
      updateRecurPanels();
      if ($('aRecur').value === 'weekly') defaultWeeklyDay();
    });
    ['change', 'input'].forEach((eventName) => {
      $('adminSheet').addEventListener(eventName, (event) => {
        if (event.target.closest('.recurrence')) loadAdminBookings();
      });
    });
    $('aStart').addEventListener('change', () => {
      const current = Number($('aDuration').value);
      buildDurationOptions($('aStart').value, current, 'aDuration');
      updateAdminEnd();
      renderAdminTables();
    });
    $('aDuration').addEventListener('change', () => {
      updateAdminEnd();
      renderAdminTables();
    });
    $('aTables').addEventListener('click', (event) => {
      const choice = event.target.closest('[data-table]');
      if (!choice || choice.disabled) return;
      const id = choice.dataset.table;
      if (state.adminTables.has(id)) state.adminTables.delete(id);
      else state.adminTables.add(id);
      renderAdminTables();
    });
    $('aAllTables').addEventListener('click', () => {
      const free = state.config.tables.filter((table) => !adminBusy(table.id));
      if (free.length && free.every((table) => state.adminTables.has(table.id))) {
        state.adminTables.clear();
      } else {
        state.adminTables = new Set(free.map((table) => table.id));
      }
      renderAdminTables();
    });

    $('bookForm').addEventListener('submit', submitBooking);

    $('fDate').addEventListener('change', () => {
      const currentStart = $('fStart').value;
      if (!setBookDate($('fDate').value, currentStart)) {
        showBookError('No times left on that date. Choose another date.');
        return;
      }
      hideBookError();
      buildDurationOptions($('fStart').value, Number($('fDuration').value));
      updateEnd();
    });

    $('fStart').addEventListener('change', () => {
      const current = Number($('fDuration').value);
      buildDurationOptions($('fStart').value, current);
      updateEnd();
    });
    $('fDuration').addEventListener('change', updateEnd);
    $('fTable').addEventListener('change', () => {
      $('bookTitle').textContent = 'Book ' + tableName($('fTable').value);
    });

    $('editForm').addEventListener('submit', submitEdit);
    $('eStart').addEventListener('change', () => {
      const current = Number($('eDuration').value);
      buildDurationOptions($('eStart').value, current, 'eDuration');
      updateEditEnd();
    });
    $('eDuration').addEventListener('change', updateEditEnd);
    $('editBooking').addEventListener('click', () => {
      const booking = state.detail;
      if (!booking) return;
      if (booking.blocked === true) {
        requestAdminPassword(() => openEditSheet(booking), 'Enter the password to edit this block.');
      } else {
        openEditSheet(booking);
      }
    });
    $('closeEdit').addEventListener('click', closeSheets);
    $('cancelEdit').addEventListener('click', closeSheets);

    $('cancelBook').addEventListener('click', closeSheets);
    $('closeBook').addEventListener('click', closeSheets);
    $('closeDetail').addEventListener('click', closeSheets);
    $('closeDetail2').addEventListener('click', closeSheets);
    $('overlay').addEventListener('click', closeSheets);
    $('cancelBooking').addEventListener('click', () => handleCancel());

    $('refreshBtn').addEventListener('click', () => refresh());
    $('shareBtn').addEventListener('click', share);

    document.addEventListener('keydown', (event) => {
      const sheetOpen = !$('bookSheet').hidden || !$('detailSheet').hidden ||
        !$('editSheet').hidden || !$('passwordSheet').hidden || !$('adminSheet').hidden ||
        !$('deleteSheet').hidden;
      if (event.key === 'Escape' && sheetOpen) {
        closeSheets();
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  async function boot() {
    try {
      state.config = await api('/api/config');
    } catch (error) {
      showFatal('The booking server could not be reached. Start it with "npm start" and reload this page.');
      return;
    }

    state.selected = state.config.today || keyOf(new Date());
    $('dateInput').value = state.selected;
    $('dateInput').min = addDays(state.config.today, -1);
    $('dateInput').max = addDays(state.config.today, 365);

    bind();
    $('dateText').textContent = longDate.format(parseKey(state.selected));
    await refresh();
    startPolling();
  }

  boot();
})();
