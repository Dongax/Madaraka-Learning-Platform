require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { ensureInitialAdmin, ensureBooksSeeded } = require('./db');
const { readSession } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const bookRoutes = require('./routes/books');
const academicRoutes = require('./routes/academic');

ensureInitialAdmin();
ensureBooksSeeded();

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Madaraka Primary platform running at http://localhost:${PORT}`);
});
