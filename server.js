// ============================================================================
//  server.js  —  Interactive Class Booking System (back-end API)
// ----------------------------------------------------------------------------
//    1. DYNAMIC RESPONSES   : GET /api/classes returns live seat counts as
//                             JSON. The front-end polls it and re-renders the
//                             badges, so availability updates without a reload.
//
//    2. CONCURRENCY SAFETY  : POST /api/bookings wraps the "check seats then
//                             insert" step in a SQLite TRANSACTION. This is the
//                             core problem of the project: if two people try to
//                             grab the last seat at the same instant, only one
//                             can succeed. See bookClassAtomically() below. it
//                             is the most important function in the codebase.
// ============================================================================

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { sendConfirmationEmail } = require('./notify');

const app = express();
const PORT = process.env.PORT || 3000;

const db = new DatabaseSync(path.join(__dirname, 'db', 'app.db'));

app.use(express.json());                    
app.use(express.static('public'));         
app.use(session({
  secret: process.env.SESSION_SECRET || 'mmm-art-studio-dev-secret',
  resave: false,
  saveUninitialized: false,
}));


function statusFor(remaining) {
  if (remaining <= 0) return 'full';
  if (remaining <= 2) return 'limited';
  return 'available';
}

function makeRefCode() {
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase(); 
  return `MMM-${new Date().getFullYear()}-${rand}`;
}

function toClassDTO(row) {
  const remaining = row.max_spots - row.booked_spots;
  return {
    id: row.id,
    name: row.name,
    day: row.day,
    time: row.time,
    ageGroup: row.age_group,
    price: row.price,
    maxSpots: row.max_spots,
    remaining,
    status: statusFor(remaining),
  };
}

//  FEATURE 1 : DYNAMIC AVAILABILITY
app.get('/api/classes', (req, res) => {
  const rows = db.prepare('SELECT * FROM classes ORDER BY id').all();
  res.json(rows.map(toClassDTO));
});

app.get('/api/classes/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM classes WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Class not found' });
  res.json(toClassDTO(row));
});

// ===========================================================================
//  FEATURE 2 : CONCURRENCY-SAFE BOOKING  
// ---------------------------------------------------------------------------
//  bookClassAtomically() performs the read-modify-write as ONE transaction.
//
//  BEGIN IMMEDIATE takes a write lock at the start, so a second request that
//  arrives mid-transaction must wait until this one COMMITs or ROLLBACKs. By
//  the time it runs, it sees the already-incremented booked_spots and is
//  correctly rejected if the class is now full. Without this lock, two
//  requests could both read "1 spot left" and both insert.
// ===========================================================================
function bookClassAtomically({ classId, name, email, phone, spots }) {
  db.exec('BEGIN IMMEDIATE');               
  try {
    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
    if (!cls) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }

    const remaining = cls.max_spots - cls.booked_spots;

    if (remaining <= 0) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'full' };
    }
    if (spots > remaining) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'too_many', remaining };
    }

    db.prepare('UPDATE classes SET booked_spots = booked_spots + ? WHERE id = ?')
      .run(spots, classId);

    const refCode = makeRefCode();
    db.prepare(`
      INSERT INTO bookings (class_id, name, email, phone, spots, ref_code)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(classId, name, email, phone || null, spots, refCode);

    db.exec('COMMIT');                     

    return {
      ok: true,
      booking: {
        refCode,
        className: cls.name,
        when: `${cls.day} ${cls.time}`,
        spots,
        price: cls.price,
        name,
        email,
        phone: phone || null,
      },
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

app.post('/api/bookings', async (req, res) => {
  const { classId, name, email, phone, spots } = req.body;

  if (!classId || !name || !email || !spots) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  const spotCount = Number(spots);
  if (!Number.isInteger(spotCount) || spotCount < 1) {
    return res.status(400).json({ error: 'Spots must be a whole number of at least 1.' });
  }

  let result;
  try {
    result = bookClassAtomically({ classId: Number(classId), name, email, phone, spots: spotCount });
  } catch (err) {
    console.error('Booking transaction failed:', err);
    return res.status(500).json({ error: 'Could not complete the booking. Please try again.' });
  }

  if (!result.ok) {
    if (result.reason === 'not_found') return res.status(404).json({ error: 'Class not found.' });
    if (result.reason === 'full')      return res.status(409).json({ error: 'Sorry, this class just filled up.', offerWaitlist: true });
    if (result.reason === 'too_many')  return res.status(409).json({ error: `Only ${result.remaining} spot(s) remaining.`, remaining: result.remaining });
    return res.status(400).json({ error: 'Booking could not be completed.' });
  }

  // --- Post-booking communication (real email) ---
  // The booking is already safely committed to the database above. Sending the
  // email is a best-effort step: if it fails (e.g. bad SMTP credentials), we
  // log it but STILL return success, so a confirmed booking is never lost just
  // because a message could not be delivered.
  const b = result.booking;

  let emailResult = { sent: false };
  try {
    emailResult = await sendConfirmationEmail(b);
  } catch (err) {
    console.error('Confirmation email failed (booking still confirmed):', err.message);
  }

  res.status(201).json({
    refCode: b.refCode,
    className: b.className,
    when: b.when,
    spots: b.spots,
    emailSent: emailResult.sent,
  });
});

// ===========================================================================
//  WAITLIST : when a class is full, users join the queue instead.
// ===========================================================================
app.post('/api/waitlist', async (req, res) => {
  const { classId, name, email, phone } = req.body;

  if (!classId || !name || !email) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(Number(classId));
  if (!cls) return res.status(404).json({ error: 'Class not found.' });

  db.prepare(`
    INSERT INTO waitlist (class_id, name, email, phone)
    VALUES (?, ?, ?, ?)
  `).run(Number(classId), name, email, phone || null);

  res.status(201).json({ message: "You're on the waitlist. We'll notify you if a spot opens." });
});

// ---------------------------------------------------------------------------
//  Start the server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`MMM Art Studio booking server running at http://localhost:${PORT}`);
});
