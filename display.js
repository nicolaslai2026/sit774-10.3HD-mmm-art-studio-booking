const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'db', 'app.db'));

console.log('\n=== CLASSES (live seat counts) ===');
console.table(
  db.prepare(
    'SELECT id, name, max_spots, booked_spots, max_spots - booked_spots AS remaining FROM classes ORDER BY id'
  ).all()
);

console.log('\n=== BOOKINGS (confirmed reservations) ===');
const bookings = db.prepare('SELECT * FROM bookings ORDER BY id').all();
if (bookings.length === 0) {
  console.log('(no bookings yet)');
} else {
  console.table(bookings);
}

console.log('\n=== WAITLIST ===');
const waitlist = db.prepare('SELECT * FROM waitlist ORDER BY id').all();
if (waitlist.length === 0) {
  console.log('(no one on the waitlist yet)');
} else {
  console.table(waitlist);
}

console.log('');
db.close();
