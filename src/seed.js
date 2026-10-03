require('dotenv').config();
const { ensureInitialAdmin } = require('./db');

ensureInitialAdmin();
console.log('Seed complete. If an admin already existed, nothing changed.');
