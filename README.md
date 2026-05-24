# MMM Art Studio : Interactive Class Booking System

**SIT774 Web Technologies and Development · Task 10.3HD**
**Nicolas Lai | s226148849**

A working full-stack prototype of the feature proposed in Task 7.3HD: a class
booking system embedded in the MMM Art Studio site that shows **live seat
availability** and lets visitors **reserve a place** without leaving the page.

The two features this project focuses on:

1. **Dynamic responses** : seat counts update live, without a page reload.
2. **Concurrency safety** : two people cannot both book the last seat.

---

## Tech stack

| Layer      | Technology                                                |
|------------|-----------------------------------------------------------|
| Front-end  | HTML, CSS, vanilla JavaScript (`fetch`, DOM)              |
| Back-end   | Node.js + Express                                         |
| Database   | SQLite via Node's built-in `node:sqlite` (`DatabaseSync`) |
| Email      | Nodemailer (SMTP)                                         |

This is the same Express + `node:sqlite` stack. The
concurrency transaction and the real email integration are the deliberate
extensions beyond the taught scope.

---


Then open <http://localhost:3000> in a browser.

Email is **optional** — the app runs without it and just logs the
messages it *would* have sent to the console. To enable real delivery, copy
`.env.example` to `.env` and fill in your own SMTP credentials. No
secrets are committed to the repository.

---

## How it works — a tutorial for other developers

This section explains the two core features in enough detail that another
developer could reproduce them.

### Feature 1 — Live seat availability (dynamic responses)

**Goal:** the badge on each class card should always reflect the true number of
free seats, even if someone else books while the page is open — with no reload.

**Back-end** exposes the current state as JSON:

```js
// GET /api/classes — returns every class with a computed "remaining" + "status"
app.get('/api/classes', (req, res) => {
  const rows = db.prepare('SELECT * FROM classes ORDER BY id').all();
  res.json(rows.map(toClassDTO)); // toClassDTO adds remaining = max - booked
});
```

`status` is derived from `remaining` so the colour and the label always agree:

```js
function statusFor(remaining) {
  if (remaining <= 0) return 'full';      // grey badge -> waitlist
  if (remaining <= 2) return 'limited';   // amber badge -> urgency
  return 'available';                     // green badge
}
```

**Front-end** polls that endpoint on a timer and re-renders the cards:

```js
const POLL_MS = 5000;
loadClasses();                              // initial load
setInterval(() => {
  if (modalIsClosed) loadClasses();         // refresh every 5s when idle
}, POLL_MS);
```

Polling was chosen over WebSockets because it is simple, reliable, and uses the
same `fetch` pattern taught in the unit — appropriate for a studio whose seat
counts change every few minutes, not every millisecond. After a successful
booking the front-end also calls `loadClasses()` immediately, so the user sees
their own booking reflected at once rather than waiting for the next poll.

> **To reproduce:** expose current state as JSON from one endpoint, render it on
> the client, and re-fetch on an interval. Keep the *derived* state (badge
> colour/label) on the server so the client never disagrees with the database.

### Feature 2 — Preventing double-booking (concurrency)

**The problem:** suppose a class has **1 seat left** and two people click
"Confirm" at the same instant. A naive implementation does this for *both*
requests:

```
read remaining  -> both see "1 left"
insert booking  -> both insert
update seats     -> class is now overbooked (-1 free)
```

Both requests passed the check before either wrote, so both succeed. The class
is overbooked.

**The fix:** wrap *check + update + insert* in a single **SQLite transaction**
opened with `BEGIN IMMEDIATE`, which takes a write lock straight away:

```js
function bookClassAtomically({ classId, name, email, phone, spots }) {
  db.exec('BEGIN IMMEDIATE');               // acquire the write lock NOW
  try {
    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
    const remaining = cls.max_spots - cls.booked_spots;

    if (remaining <= 0)        { db.exec('ROLLBACK'); return { ok:false, reason:'full' }; }
    if (spots > remaining)     { db.exec('ROLLBACK'); return { ok:false, reason:'too_many', remaining }; }

    db.prepare('UPDATE classes SET booked_spots = booked_spots + ? WHERE id = ?')
      .run(spots, classId);
    db.prepare('INSERT INTO bookings (class_id, name, email, phone, spots, ref_code) VALUES (?,?,?,?,?,?)')
      .run(classId, name, email, phone, spots, makeRefCode());

    db.exec('COMMIT');                       // release the lock
    return { ok: true, booking: { /* ... */ } };
  } catch (err) {
    db.exec('ROLLBACK');                     // any failure -> no half-written booking
    throw err;
  }
}
```

Because the lock is held for the whole read-modify-write, the *second* request
cannot run its `SELECT` until the first has `COMMIT`ted. By then `booked_spots`
is already incremented, so the second request sees `remaining = 0` and is
correctly rejected with HTTP **409**.

**Verified.** Firing 10 simultaneous requests at a class with 1 free seat
produces exactly **1 success (201)** and **9 rejections (409)**, with the
database ending at `booked = max` and exactly one new booking row — no
overbooking. (See the project walkthrough video.)

> **To reproduce:** never check-then-act across two separate statements on
> shared data. Put the check and the write in one transaction and take the lock
> before the read (`BEGIN IMMEDIATE`), so concurrent writers serialise instead
> of racing.

---

## API reference

| Method | Route              | Purpose                                              |
|--------|--------------------|------------------------------------------------------|
| GET    | `/api/classes`     | All classes with live `remaining` + `status`         |
| GET    | `/api/classes/:id` | A single class (used to refresh the open modal)      |
| POST   | `/api/bookings`    | Make a booking (concurrency-safe). 201 / 400 / 409   |
| POST   | `/api/waitlist`    | Join the waitlist for a full class                   |

---

## Project structure

```
mmm-booking/
├── server.js            # Express app + the concurrency-safe booking logic
├── notify.js            # real email (Nodemailer) integration
├── db/
│   ├── seed.js          # creates tables + loads sample classes
│   └── app.db           # SQLite database (created by seed; git-ignored)
├── public/
│   ├── index.html       # classes page, booking modal, confirmation screen
│   ├── styles.css       # studio-themed, accessible styling
│   └── app.js           # polling, validation, booking/waitlist flow
├── .env.example         # template for email credentials (no secrets)
└── package.json
```

---

## Accessibility & security notes

- Availability is conveyed by **both colour and text** ("3 spots left"), not
  colour alone.
- The modal traps focus on open and returns it to the trigger on close; it is
  dismissible with `Escape`.
- All SQL uses **parameterised queries** (`?` placeholders) to prevent
  injection.
- Booking references are **random** (`MMM-2026-XXXXXX`), not sequential, so they
  can't be enumerated.
- User contact details are stored only in the `bookings` table and never appear
  in any API response or URL.

--


## Email confirmation

I would like to talk about how I learn to make the email confirmation part. 

After a booking, we send a real confirmation email. Create `notify.js`:

```js
// notify.js : sends the booking confirmation email via Nodemailer
const nodemailer = require('nodemailer');

let mailer = null;

function getMailer() {
  if (mailer) return mailer;
  // No credentials configured -> return null (we'll fall back to logging).
  if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER) return null;

  mailer = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: Number(process.env.EMAIL_PORT) === 465,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
  return mailer;
}

async function sendConfirmationEmail(booking) {
  const transport = getMailer();

  const subject = `Booking confirmed: ${booking.className} (${booking.refCode})`;
  const text =
    `Hi ${booking.name},\n\n` +
    `Your place at MMM Art Studio is confirmed.\n\n` +
    `Class:     ${booking.className}\n` +
    `When:      ${booking.when}\n` +
    `Spots:     ${booking.spots}\n` +
    `Reference: ${booking.refCode}\n\n` +
    `— MMM Art Studio`;

  // If no email is configured, log instead of failing — handy during development.
  if (!transport) {
    console.log('[email:fallback] No SMTP configured. Would have sent:\n' + text);
    return { sent: false, info: 'logged-to-console' };
  }

  const info = await transport.sendMail({
    from: process.env.EMAIL_FROM || `"MMM Art Studio" <${process.env.EMAIL_USER}>`,
    to: booking.email,
    subject,
    text,
  });
  return { sent: true, info: info.messageId };
}

module.exports = { sendConfirmationEmail };
```

Two important design choices:

- **Credentials come from `process.env`**, never hard-coded. They live in a `.env`
  file (below) which is excluded by `.gitignore`.
- **It fails gracefully.** If no email is set up, it logs the message instead of
  crashing. And back in the booking route, the email call is wrapped in
  `try/catch`, so even a delivery failure never undoes a confirmed booking.

To enable real email with a Gmail account, create a `.env` file:

```
PORT=3000
SESSION_SECRET=change-me-to-a-long-random-string

EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your.address@gmail.com
EMAIL_PASS=your-16-char-app-password
EMAIL_FROM="MMM Art Studio <your.address@gmail.com>"
```

The `EMAIL_PASS` is **not** your normal Gmail password — it's a 16-character "App
Password". To create one: turn on 2-Step Verification on your Google account, then
go to <https://myaccount.google.com/apppasswords>, generate a password, and paste
it here with the spaces removed. The app runs fine without any of this; email just
logs to the console until you fill it in.

> **Never commit `.env` to GitHub.** It holds a working credential. This is the
> single most important security habit in this project.

It's also good practice to ship a `.env.example` (same keys, placeholder values)
so others know what settings the project expects, without exposing your real ones.

---
