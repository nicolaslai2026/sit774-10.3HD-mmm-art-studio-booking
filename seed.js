const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'app.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS classes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    day           TEXT    NOT NULL,
    time          TEXT    NOT NULL,
    age_group     TEXT    NOT NULL,
    price         REAL    NOT NULL,
    max_spots     INTEGER NOT NULL,
    booked_spots  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id    INTEGER NOT NULL,
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL,
    phone       TEXT,
    spots       INTEGER NOT NULL,
    ref_code    TEXT    NOT NULL UNIQUE,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (class_id) REFERENCES classes(id)
  );

  CREATE TABLE IF NOT EXISTS waitlist (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id    INTEGER NOT NULL,
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL,
    phone       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    notified_at TEXT,
    FOREIGN KEY (class_id) REFERENCES classes(id)
  );
`);

const count = db.prepare('SELECT COUNT(*) AS c FROM classes').get().c;

if (count === 0) {
  const insert = db.prepare(`
    INSERT INTO classes (name, day, time, age_group, price, max_spots, booked_spots)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // name, day, time, age group, price, max spots, booked spots
  insert.run('Watercolour for Kids',  'Sat', '10:00am – 11:30am', '12yrs & under', 35, 8, 5);  // 3 left  -> green
  insert.run('Teen Acrylic Workshop', 'Sun', '2:00pm – 4:00pm',   'Ages 13–17',    45, 6, 5);  // 1 left  -> amber
  insert.run('Adult Life Drawing',    'Fri', '6:00pm – 8:00pm',   '18+',           50, 10, 10); // 0 left  -> full
  insert.run('Pottery Basics',        'Wed', '5:30pm – 7:00pm',   'All ages',      40, 12, 4);  // 8 left  -> green
  insert.run('Calligraphy Evening',   'Thu', '6:30pm – 8:00pm',   'Ages 16+',      30, 8, 7);   // 1 left  -> amber

  console.log('Seeded 5 sample classes.');
} else {
  console.log(`classes table already has ${count} rows — skipping seed.`);
}

console.log('Database ready at', path.join(__dirname, 'app.db'));
db.close();
