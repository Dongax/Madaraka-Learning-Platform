require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { initSchema, ensureInitialAdmin, ensureBooksSeeded } = require('./db');
const { readSession } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const bookRoutes = require('./routes/books');
const academicRoutes = require('./routes/academic');

async function main() {
  // Schema creation/migration and seeding finish before the app starts
  // accepting requests.
  await initSchema();
  await ensureInitialAdmin();
  await ensureBooksSeeded();

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(readSession);

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
