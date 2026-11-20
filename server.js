'use strict';

/**
 * Leitrim Pool Premier League — table booking server.
 * Zero npm dependencies: Node 18+ only.
 *
 * Storage: a JSON file (data/bookings.json by default). All writes are
 * serialized and conflict checks happen inside the same lock, so two people
 * tapping the same slot at the same moment cannot both succeed.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '5721';

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bookings.json');

const TABLE_NAMES = (process.env.TABLES || 'Table 1,Table 2,Table 3,Table 4')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

if (TABLE_NAMES.length === 0) {
  throw new Error('TABLES must contain at least one table name.');
}

const SETTINGS = {
  league: process.env.LEAGUE_NAME || 'Leitrim Pool Premier League',
  tables: TABLE_NAMES.map((name, index) => ({ id: 'table-' + (index + 1), name })),
  open: process.env.OPEN_TIME || '06:00',
  close: process.env.CLOSE_TIME || '24:00',
  slotMinutes: Number(process.env.SLOT_MINUTES) || 30,
  minDuration: 30,
  maxDuration: 180,
  defaultDuration: Number(process.env.DEFAULT_DURATION) || 90,
  defaultStart: process.env.DEFAULT_START || '18:00'
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const OPEN_MIN = toMinutes(SETTINGS.open);
const CLOSE_MIN = toMinutes(SETTINGS.close);

if (!Number.isInteger(SETTINGS.slotMinutes) || SETTINGS.slotMinutes < 15 || SETTINGS.slotMinutes > 120) {
  throw new Error('SLOT_MINUTES must be an integer between 15 and 120.');
}
if (CLOSE_MIN <= OPEN_MIN) throw new Error('CLOSE_TIME must be after OPEN_TIME.');
if ((CLOSE_MIN - OPEN_MIN) % SETTINGS.slotMinutes !== 0) {
  throw new Error('Opening hours must divide evenly into slots.');
}
if (!Number.isInteger(SETTINGS.defaultDuration) ||
    SETTINGS.defaultDuration < SETTINGS.minDuration ||
    SETTINGS.defaultDuration > SETTINGS.maxDuration ||
    SETTINGS.defaultDuration % SETTINGS.slotMinutes !== 0) {
  throw new Error('DEFAULT_DURATION must be a slot-sized duration between ' +
    SETTINGS.minDuration + ' and ' + SETTINGS.maxDuration + ' minutes.');
}
if (!TIME_RE.test(SETTINGS.defaultStart)) {
  throw new Error('DEFAULT_START must be a time in HH:MM format.');
}
const DEFAULT_START_MIN = toMinutes(SETTINGS.defaultStart);
if (DEFAULT_START_MIN < OPEN_MIN ||
    DEFAULT_START_MIN > CLOSE_MIN ||
    (DEFAULT_START_MIN - OPEN_MIN) % SETTINGS.slotMinutes !== 0 ||
    DEFAULT_START_MIN + SETTINGS.minDuration > CLOSE_MIN) {
  throw new Error('DEFAULT_START must be an on-grid start time within opening hours.');
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function pad(value) {
  return String(value).padStart(2, '0');
}

function toMinutes(hhmm) {
  const [hours, minutes] = String(hhmm).split(':').map(Number);
  return hours * 60 + minutes;
}

function toTime(minutes) {
  return pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60);
}

function localDateKey(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function addDays(key, delta) {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + delta);
  return localDateKey(date);
}

function isValidDate(key) {
  if (!DATE_RE.test(String(key))) return false;
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function daysBetween(from, to) {
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
  const [toYear, toMonth, toDay] = to.split('-').map(Number);
  const a = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const b = Date.UTC(toYear, toMonth - 1, toDay);
  return Math.round((b - a) / 86400000);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function escapeForLog(value) {
  return String(value).replace(/[\r\n]/g, ' ');
}

function isAdmin(req, body) {
  const supplied = req.headers['x-admin-password'] || (body && body.password) || '';
  return String(supplied) === ADMIN_PASSWORD;
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

let bookings = [];
let queue = Promise.resolve();

/** Serialize every read-modify-write so clash checks are atomic. */
function withLock(task) {
  const run = queue.then(task, task);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

function normalizeStored(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.id !== 'string' || !item.id) return null;
  if (!isValidDate(item.date)) return null;
  const table = SETTINGS.tables.find((t) => t.id === item.tableId);
  if (!table) return null;
  if (!TIME_RE.test(String(item.start || ''))) return null;
  const duration = Number(item.durationMinutes);
  if (!Number.isInteger(duration) || duration < SETTINGS.minDuration || duration > SETTINGS.maxDuration) return null;
  const name = typeof item.name === 'string' ? item.name.trim().slice(0, 60) : '';
  if (!name) return null;
  return {
    id: item.id,
    tableId: table.id,
    tableName: table.name,
    date: item.date,
    start: item.start,
    durationMinutes: duration,
    name,
    notes: typeof item.notes === 'string' ? item.notes.trim().slice(0, 200) : '',
    blocked: item.blocked === true,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString()
  };
}

async function loadBookings() {
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    bookings = Array.isArray(parsed) ? parsed.map(normalizeStored).filter(Boolean) : [];
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[store] Could not read ' + DATA_FILE + ': ' + error.message);
    }
    bookings = [];
  }
  console.log('[store] Loaded ' + bookings.length + ' booking(s) from ' + DATA_FILE);
}

async function persist() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const temp = DATA_FILE + '.tmp';
  await fsp.writeFile(temp, JSON.stringify(bookings, null, 2), 'utf8');
  await fsp.rename(temp, DATA_FILE);
}

/* ------------------------------------------------------------------ */
/* Validation and conflicts                                            */
/* ------------------------------------------------------------------ */

function validateDateKey(date) {
  if (!isValidDate(date)) return 'Choose a valid date.';
  const today = localDateKey(new Date());
  if (date < today) return 'That date is in the past.';
  if (date > addDays(today, 365)) return 'Dates can be up to one year ahead.';
  return null;
}

function pastStartError(date, start) {
  if (date !== localDateKey(new Date())) return null;
  const now = new Date();
  return toMinutes(start) < now.getHours() * 60 + now.getMinutes()
    ? 'That time has already passed.'
    : null;
}

function validateBooking(input) {
  if (!input || typeof input !== 'object') return { error: 'Invalid request body.' };

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return { error: 'Please enter a name for the booking.' };
  if (name.length > 60) return { error: 'Name must be 60 characters or fewer.' };

  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (notes.length > 200) return { error: 'Notes must be 200 characters or fewer.' };

  const table = SETTINGS.tables.find((t) => t.id === input.tableId || t.name === input.tableId);
  if (!table) return { error: 'Choose a valid table.' };

  const date = String(input.date || '');
  const dateError = validateDateKey(date);
  if (dateError) return { error: dateError };

  const today = localDateKey(new Date());

  const start = String(input.start || '');
  if (!TIME_RE.test(start)) return { error: 'Choose a valid start time.' };
  const startMin = toMinutes(start);

  const duration = Number(input.durationMinutes);
  if (!Number.isInteger(duration) || duration < SETTINGS.minDuration || duration > SETTINGS.maxDuration) {
    return { error: 'Choose a duration between ' + SETTINGS.minDuration + ' and ' + SETTINGS.maxDuration + ' minutes.' };
  }
  if (duration % SETTINGS.slotMinutes !== 0) {
    return { error: 'Durations must be in ' + SETTINGS.slotMinutes + '-minute steps.' };
  }
  if (startMin < OPEN_MIN) return { error: 'The first slot is at ' + SETTINGS.open + '.' };
  if ((startMin - OPEN_MIN) % SETTINGS.slotMinutes !== 0) {
    return { error: 'Start times are every ' + SETTINGS.slotMinutes + ' minutes from ' + SETTINGS.open + '.' };
  }
  if (startMin + duration > CLOSE_MIN) {
    return { error: 'That would run past closing time at ' + SETTINGS.close + '.' };
  }

  const now = new Date();
  if (date === today) {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (startMin < nowMinutes - 5) return { error: 'That time has already passed.' };
  }

  return {
    value: {
      tableId: table.id,
      tableName: table.name,
      date,
      start,
      durationMinutes: duration,
      name,
      notes,
      blocked: input.blocked === true
    }
  };
}

function findConflict(tableId, date, startMin, endMin, excludeId) {
  return bookings.find((booking) => {
    if (booking.id === excludeId) return false;
    if (booking.tableId !== tableId || booking.date !== date) return false;
    const otherStart = toMinutes(booking.start);
    return overlaps(startMin, endMin, otherStart, otherStart + booking.durationMinutes);
  });
}

function publicBooking(booking) {
  const endMin = toMinutes(booking.start) + booking.durationMinutes;
  return {
    id: booking.id,
    tableId: booking.tableId,
    tableName: booking.tableName,
    date: booking.date,
    start: booking.start,
    end: toTime(endMin),
    durationMinutes: booking.durationMinutes,
    name: booking.name,
    notes: booking.notes,
    blocked: booking.blocked === true,
    createdAt: booking.createdAt
  };
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function readJson(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks = [];
    let size = 0;

    function fail(error) {
      if (settled) return;
      settled = true;
      reject(error);
    }

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) return fail(Object.assign(new Error('Request body is too large.'), { status: 413 }));
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', fail);
  });
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

function configPayload() {
  const now = new Date();
  return {
    league: SETTINGS.league,
    tables: SETTINGS.tables,
    open: SETTINGS.open,
    close: SETTINGS.close,
    slotMinutes: SETTINGS.slotMinutes,
    minDuration: SETTINGS.minDuration,
    maxDuration: SETTINGS.maxDuration,
    defaultDuration: SETTINGS.defaultDuration,
    defaultStart: SETTINGS.defaultStart,
    today: localDateKey(now),
    serverTime: now.toISOString()
  };
}

async function handleApi(req, res, url) {
  const pathname = url.pathname.replace(/\/+$/, '');

  if (pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, configPayload());
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, bookings: bookings.length });
  }

  // Admin: block one or more tables for a future date/time. Password is
  // required again on the server, not just in the browser form.
  if (pathname === '/api/blocks' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: 'bad_request', message: error.message });
    }

    if (!isAdmin(req, body)) {
      return sendJson(res, 401, { error: 'bad_password', message: 'Incorrect schedule password.' });
    }

    const requested = Array.isArray(body && body.tableIds) ? body.tableIds : [];
    if (requested.length === 0) {
      return sendJson(res, 400, { error: 'invalid', message: 'Select at least one table to block.' });
    }

    const tables = [];
    for (const requestedId of requested) {
      const table = SETTINGS.tables.find((item) => item.id === requestedId || item.name === requestedId);
      if (!table) return sendJson(res, 400, { error: 'invalid', message: 'Choose valid tables.' });
      if (!tables.some((item) => item.id === table.id)) tables.push(table);
    }

    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
    if (!label) {
      return sendJson(res, 400, { error: 'invalid', message: 'Enter a label for the schedule.' });
    }

    // A single request can block a whole recurring series. The client builds
    // the dates for the preview; the server re-validates every one of them.
    const requestedDates = Array.isArray(body && body.dates)
      ? body.dates
      : (body && body.date ? [body.date] : []);
    if (requestedDates.length === 0) {
      return sendJson(res, 400, { error: 'invalid', message: 'Choose at least one date to block.' });
    }
    if (requestedDates.length > 400) {
      return sendJson(res, 400, {
        error: 'invalid',
        message: 'A repeating block can cover at most 400 dates.'
      });
    }

    const today = localDateKey(new Date());
    const dates = [...new Set(requestedDates.map(String))].sort();
    for (const date of dates) {
      const dateError = validateDateKey(date);
      if (dateError) return sendJson(res, 400, { error: 'invalid', message: dateError });
      if (date < today) {
        return sendJson(res, 400, {
          error: 'invalid',
          message: 'Tables can only be blocked for today or a future date.'
        });
      }
    }

    const validated = validateBooking({
      name: label,
      tableId: tables[0].id,
      date: dates[0],
      start: body.start,
      durationMinutes: body.durationMinutes
    });
    if (validated.error) return sendJson(res, 400, { error: 'invalid', message: validated.error });

    const pastError = pastStartError(validated.value.date, validated.value.start);
    if (pastError) return sendJson(res, 400, { error: 'invalid', message: pastError });

    const outcome = await withLock(async () => {
      const startMin = toMinutes(validated.value.start);
      const endMin = startMin + validated.value.durationMinutes;
      const created = [];
      const conflicts = [];

      for (const date of dates) {
        for (const table of tables) {
          const conflict = findConflict(table.id, date, startMin, endMin, null);
          if (conflict) {
            conflicts.push({
              date,
              tableId: table.id,
              tableName: table.name,
              conflict: publicBooking(conflict)
            });
            continue;
          }

          const booking = {
            id: crypto.randomUUID(),
            tableId: table.id,
            tableName: table.name,
            date,
            start: validated.value.start,
            durationMinutes: validated.value.durationMinutes,
            name: label,
            notes: '',
            blocked: true,
            createdAt: new Date().toISOString()
          };
          bookings.push(booking);
          created.push(publicBooking(booking));
        }
      }

      if (created.length) {
        try {
          await persist();
        } catch (error) {
          const createdIds = new Set(created.map((item) => item.id));
          bookings = bookings.filter((item) => !createdIds.has(item.id));
          throw error;
        }
      }

      return { created, conflicts, dates: dates.length };
    });

    if (outcome.created.length === 0) {
      return sendJson(res, 409, Object.assign({
        error: 'conflict',
        message: 'Every selected table and date is already booked at that time.'
      }, outcome));
    }
    return sendJson(res, 201, outcome);
  }

  // Admin: remove every blocked entry with this label (a whole schedule).
  // Matching is exact, so a label can only delete the schedule it names.
  if (pathname === '/api/blocks' && req.method === 'DELETE') {
    if (!isAdmin(req, null)) {
      return sendJson(res, 401, { error: 'bad_password', message: 'Incorrect schedule password.' });
    }

    const label = String(url.searchParams.get('label') || '').trim();
    if (!label) {
      return sendJson(res, 400, { error: 'invalid', message: 'Enter a schedule label.' });
    }

    const outcome = await withLock(async () => {
      const ids = new Set(bookings
        .filter((item) => item.blocked === true && item.name === label)
        .map((item) => item.id));
      if (ids.size === 0) return { removed: [] };

      const before = bookings;
      bookings = bookings.filter((item) => !ids.has(item.id));
      try {
        await persist();
      } catch (error) {
        bookings = before;
        throw error;
      }
      return { removed: before.filter((item) => ids.has(item.id)).map(publicBooking) };
    });

    return sendJson(res, 200, Object.assign({ ok: true }, outcome));
  }

  // The browser asks the server to verify the password. This keeps the
  // password out of the client bundle; it is checked only against the
  // server-side ADMIN_PASSWORD value.
  if (pathname === '/api/admin/verify' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: 'bad_request', message: error.message });
    }

    const supplied = body && typeof body.password === 'string' ? body.password.trim() : '';
    if (supplied !== ADMIN_PASSWORD) {
      return sendJson(res, 401, { error: 'bad_password', message: 'Incorrect password. Please try again.' });
    }
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/bookings' && req.method === 'GET') {
    const range = readRange(url);
    if (range.error) return sendJson(res, 400, { error: 'invalid_range', message: range.error });

    const list = bookings
      .filter((booking) => booking.date >= range.from && booking.date <= range.to)
      .sort(compareBookings)
      .map(publicBooking);

    return sendJson(res, 200, { from: range.from, to: range.to, bookings: list });
  }

  if (pathname === '/api/bookings' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: 'bad_request', message: error.message });
    }

    if (body && body.blocked === true) {
      return sendJson(res, 403, {
        error: 'admin_required',
        message: 'Use the Create schedule form to block tables.'
      });
    }

    const outcome = await withLock(async () => {
      const validated = validateBooking(body);
      if (validated.error) return { status: 400, body: { error: 'invalid', message: validated.error } };

      const pastError = pastStartError(validated.value.date, validated.value.start);
      if (pastError) return { status: 400, body: { error: 'invalid', message: pastError } };

      const value = validated.value;
      const startMin = toMinutes(value.start);
      const endMin = startMin + value.durationMinutes;

      const conflict = findConflict(value.tableId, value.date, startMin, endMin, null);
      if (conflict) {
        return {
          status: 409,
          body: {
            error: 'conflict',
            message: value.tableName + ' is already booked from ' + conflict.start + ' to ' +
              toTime(toMinutes(conflict.start) + conflict.durationMinutes) + '.',
            conflict: publicBooking(conflict)
          }
        };
      }

      const booking = Object.assign({ id: crypto.randomUUID(), createdAt: new Date().toISOString() }, value);
      bookings.push(booking);

      try {
        await persist();
      } catch (error) {
        bookings = bookings.filter((item) => item.id !== booking.id);
        throw error;
      }
      return { status: 201, body: publicBooking(booking) };
    });

    return sendJson(res, outcome.status, outcome.body);
  }

  const bookingMatch = pathname.match(/^\/api\/bookings\/([A-Za-z0-9-]+)$/);

  if (bookingMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
    const id = bookingMatch[1];
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: 'bad_request', message: error.message });
    }

    const outcome = await withLock(async () => {
      const index = bookings.findIndex((booking) => booking.id === id);
      if (index === -1) return { status: 404, body: { error: 'not_found', message: 'That booking no longer exists.' } };

      const existing = bookings[index];
      if (existing.blocked && !isAdmin(req, body)) {
        return { status: 401, body: { error: 'bad_password', message: 'Incorrect schedule password.' } };
      }

      const candidate = {
        name: existing.name,
        tableId: existing.tableId,
        date: existing.date,
        start: existing.start,
        durationMinutes: existing.durationMinutes,
        notes: existing.notes,
        blocked: existing.blocked === true
      };
      for (const key of ['date', 'start', 'durationMinutes']) {
        if (body && Object.prototype.hasOwnProperty.call(body, key)) candidate[key] = body[key];
      }

      const validated = validateBooking(candidate);
      if (validated.error) return { status: 400, body: { error: 'invalid', message: validated.error } };

      const value = validated.value;
      const startMin = toMinutes(value.start);
      const endMin = startMin + value.durationMinutes;

      const conflict = findConflict(value.tableId, value.date, startMin, endMin, id);
      if (conflict) {
        return {
          status: 409,
          body: {
            error: 'conflict',
            message: value.tableName + ' is already booked from ' + conflict.start + ' to ' +
              toTime(toMinutes(conflict.start) + conflict.durationMinutes) + '.',
            conflict: publicBooking(conflict)
          }
        };
      }

      const previous = Object.assign({}, existing);
      Object.assign(existing, value);
      try {
        await persist();
      } catch (error) {
        bookings[index] = previous;
        throw error;
      }
      return { status: 200, body: publicBooking(existing) };
    });

    return sendJson(res, outcome.status, outcome.body);
  }

  if (bookingMatch && req.method === 'DELETE') {
    const id = bookingMatch[1];
    const outcome = await withLock(async () => {
      const index = bookings.findIndex((booking) => booking.id === id);
      if (index === -1) return { status: 404, body: { error: 'not_found', message: 'That booking no longer exists.' } };

      if (bookings[index].blocked && !isAdmin(req, null)) {
        return { status: 401, body: { error: 'bad_password', message: 'Incorrect schedule password.' } };
      }

      const [removed] = bookings.splice(index, 1);
      try {
        await persist();
      } catch (error) {
        bookings.splice(index, 0, removed);
        throw error;
      }
      return { status: 200, body: { ok: true, removed: publicBooking(removed) } };
    });

    return sendJson(res, outcome.status, outcome.body);
  }

  return sendJson(res, 404, { error: 'not_found', message: 'Unknown API endpoint.' });
}

function readRange(url) {
  const date = url.searchParams.get('date');
  if (date) {
    if (!isValidDate(date)) return { error: 'date must be YYYY-MM-DD.' };
    return { from: date, to: date };
  }

  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from && !to) {
    const today = localDateKey(new Date());
    return { from: today, to: addDays(today, 6) };
  }
  if (!from || !to) return { error: 'Provide both from and to.' };
  if (!isValidDate(from) || !isValidDate(to)) return { error: 'Dates must be YYYY-MM-DD.' };
  if (to < from) return { error: 'to must be on or after from.' };
  if (daysBetween(from, to) > 62) return { error: 'Range is limited to 62 days.' };
  return { from, to };
}

function compareBookings(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const diff = toMinutes(a.start) - toMinutes(b.start);
  if (diff !== 0) return diff;
  return a.tableId < b.tableId ? -1 : a.tableId > b.tableId ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* Static files                                                        */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method_not_allowed', message: 'Use GET.' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: 'bad_request', message: 'Malformed path.' });
  }

  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (pathname.includes('\0')) return sendJson(res, 404, { error: 'not_found' });

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 404, { error: 'not_found' });
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return sendJson(res, 404, { error: 'not_found', message: 'File not found.' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: 'not_found' });

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache'
  });

  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch {
    return sendJson(res, 400, { error: 'bad_request' });
  }

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error('[server] ' + escapeForLog(error && error.message));
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'server_error', message: 'Something went wrong. Please try again.' });
    } else {
      res.end();
    }
  }
});

loadBookings()
  .catch((error) => {
    console.error('[store] ' + error.message);
  })
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log('[' + SETTINGS.league + '] listening on http://localhost:' + PORT);
      console.log('[config] ' + SETTINGS.tables.length + ' tables, ' + SETTINGS.open + '-' + SETTINGS.close +
        ', ' + SETTINGS.slotMinutes + '-minute slots');
    });
  });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nShutting down.');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
