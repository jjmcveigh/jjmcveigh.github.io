# Leitrim Pool Premier League — Table Scheduler

A shared pool-table booking app with real clash prevention. Everyone opens the same link; the server is the source of truth, so two people can never book the same table at the same time.

## Features

- Day view with a week strip for quick navigation
- One column per table, one row per 30-minute slot
- Tap a free slot or use the green **Book table** button to book; tap a booking to see details, edit its date/time, or cancel
- **Create schedule** (password `5721`) opens an admin form that blocks one or more tables into the future, with Outlook-style recurrence (daily, weekly, monthly or yearly, with end-by/end-after options)
- **Delete schedule** (same password) finds a schedule by its label and removes every block in it after confirmation
- Server-side overlap check — creates, edits and admin blocks all reject clashes
- Live refresh every 20 seconds, plus refresh on focus and tab switch
- "Yours" highlighting for bookings made on this device
- The booking form only offers today or later dates, and start times that have not already passed; the server enforces the same rule
- Mobile-first layout with safe-area padding and 44px tap targets
- Zero npm dependencies — Node's standard library only

## Run locally

Requires **Node 18 or newer**.

```powershell
cd pool-scheduler
npm start
```

Open <http://localhost:3000>.

For auto-restart while editing: `npm run dev`.

## Configuration

All optional, set as environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `LEAGUE_NAME` | `Leitrim Pool Premier League` | Shown in logs |
| `TABLES` | `Table 1,Table 2,Table 3,Table 4` | Comma-separated table names |
| `OPEN_TIME` | `06:00` | First bookable slot |
| `CLOSE_TIME` | `24:00` | Closing time (allows a 23:30 start with a 30-minute booking) |
| `SLOT_MINUTES` | `30` | Slot size (15–120) |
| `DEFAULT_DURATION` | `90` | Pre-selected booking length in minutes |
| `DEFAULT_START` | `18:00` | Start time shown when no slot was tapped |
| `ADMIN_PASSWORD` | `5721` | Password for Create/Delete schedule and for editing/removing blocks. Set this to your own value; it is checked only on the server, never stored in the browser code. |
| `DATA_DIR` | `./data` | Where `bookings.json` lives |

Example:

```powershell
$env:TABLES = "Table 1,Table 2,Table 3,Table 4,Table 5,Table 6"
$env:OPEN_TIME = "12:00"
$env:CLOSE_TIME = "23:30"
npm start
```

Durations can be 30–180 minutes in slot-sized steps. Opening hours must divide evenly into slots.

## How clashes are prevented

1. Every write is serialized through a single in-process queue.
2. Inside that queue, the new booking is checked against every existing booking on the same table and date: two bookings overlap when `startA < endB && startB < endA`.
3. Only if no overlap exists is the booking appended and written to disk.
4. If another booking wins the race, the loser receives HTTP `409` with the conflicting booking, and the UI explains exactly who has the table and when.

This is correct for a single server process. If you ever run multiple instances, move the store to a shared database with a uniqueness constraint or transactional check.

## Deploy

The app is a plain Node server that serves static files and the API.

**Render / Railway / Fly.io**

1. Push this folder to a Git repository.
2. Create a web service with start command `npm start`.
3. Add a **persistent disk** and set `DATA_DIR` to its mount path (for example `/data`). Without a disk, bookings are lost on redeploy.

**Any VPS**

```bash
cd pool-scheduler
PORT=3000 node server.js
```

Put nginx or Caddy in front for HTTPS. Messenger only opens `https://` links reliably.

**Important:** the JSON file is the database. Back it up periodically, and never run two instances against the same file.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/config` | Tables, opening hours, slot size, today's date |
| `GET` | `/api/bookings?from=YYYY-MM-DD&to=YYYY-MM-DD` | Bookings in a range (max 62 days) |
| `GET` | `/api/bookings?date=YYYY-MM-DD` | Bookings for one day |
| `POST` | `/api/bookings` | Create a booking; `409` on clash |
| `POST` | `/api/blocks` | Admin: block multiple tables; requires `x-admin-password` |
| `PATCH` | `/api/bookings/:id` | Edit date/start/duration; `409` on clash |
| `DELETE` | `/api/bookings/:id` | Cancel a booking |
| `GET` | `/api/health` | Health check |

Create payload:

```json
{
  "name": "Sam",
  "tableId": "table-2",
  "date": "2026-11-20",
  "start": "18:30",
  "durationMinutes": 60,
  "notes": "League match"
}
```

Block payload (`x-admin-password: 5721` header required):

```json
{
  "tableIds": ["table-1", "table-3"],
  "dates": ["2026-12-04", "2026-12-11", "2026-12-18"],
  "start": "18:00",
  "durationMinutes": 90,
  "label": "League night"
}
```

`label` is required — it identifies the schedule when you need to find or delete it later. `dates` is generated by the recurrence controls (use the singular `date` for one-off blocks). Up to 400 dates are accepted; all are re-validated on the server and limited to one year ahead. Free table/date combinations are blocked; ones already booked are returned in `conflicts` and skipped, so a block can never double-book. `PATCH` and `DELETE` of a blocked entry also require the password.

To delete a whole schedule, use `DELETE /api/blocks?label=<exact label>` with the `x-admin-password` header. It removes only blocked entries whose label matches exactly and returns the removed entries; regular bookings are never touched.

## Share it in Messenger

1. Deploy with HTTPS.
2. Paste the URL into the Messenger chat.
3. Everyone who taps it sees the same live schedule.

Add `og:url` and an `og:image` (1200×630) to `public/index.html` for a richer link preview.

## Security notes

- There are no accounts. Anyone with the link can create a booking and cancel any booking. That is intentional for a private league group, but do not publish the URL publicly.
- The schedule password is checked by both the browser and the server. It is a shared convenience code, not real authentication — put the app behind HTTPS/basic auth if you need stronger protection.
- If you need protection, add a simple shared password or per-booking cancel codes, or put the whole app behind HTTP basic auth at the proxy.
- Input is validated server-side: name length, date range, slot alignment, duration bounds, opening hours, and past times.

## Files

```
pool-scheduler/
  server.js              # HTTP server, API, clash checks, storage
  package.json
  public/
    index.html
    assets/styles.css
    assets/app.js
  data/bookings.json     # created on first booking (ignored by git)
```
