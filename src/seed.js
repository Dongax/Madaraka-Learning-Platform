require('dotenv').config();
const { initSchema, ensureInitialAdmin } = require('./db');

(async () => {
  await initSchema();
  await ensureInitialAdmin();
  console.log('Seed complete. If an admin already existed, nothing changed.');
  process.exit(0);
})().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
