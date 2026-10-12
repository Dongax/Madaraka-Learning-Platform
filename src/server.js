require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { initSchema, ensureInitialAdmin, ensureBooksSeeded, usingRemote } = require('./db');
const { readSession } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const bookRoutes = require('./routes/books');
const academicRoutes = require('./routes/academic');
const { nairobiToday } = require('./time');

async function main() {
  // Schema creation/migration and seeding finish before the app starts
  // accepting requests.
  await initSchema();
  await ensureInitialAdmin();
  await ensureBooksSeeded();

  console.log(usingRemote
    ? '[db] Connected to remote Turso database.'
    : '[db] Using a local SQLite file (set TURSO_DATABASE_URL to use a hosted database instead).');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(readSession);

  // Authoritative "now" in Kenya time (Africa/Nairobi, UTC+3, no daylight
  // saving). The browser uses this so "today" on the register, dashboards
  // and messages never depends on the device's own clock or time zone.
  app.get('/api/now', (req, res) => {
    const now = new Date();
    res.json({ epochMs: now.getTime(), today: nairobiToday(now), timeZone: 'Africa/Nairobi' });
  });

  // ─── API ───
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/books', bookRoutes);
  app.use('/api', academicRoutes);

  // ─── FRONTEND ───
  // Single page app: one login screen, four dashboards (student / teacher /
  // parent / admin) shown/hidden client-side after the API confirms who's
  // signed in.
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
  });

  // Fallback error handler — catches anything forwarded via next(err) from
  // asyncHandler-wrapped routes (e.g. an unexpected database error) so the
  // client gets a clean 500 instead of a hung connection.
  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Madaraka Primary platform running at http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start the server:', err);
  process.exit(1);
});
