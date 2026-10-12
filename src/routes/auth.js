const express = require('express');
const { findAccount, verifyPassword, getUserProfile } = require('../db');
const { issueSessionCookie, clearSessionCookie, requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

// POST /api/auth/login  { id, password }
// No role is submitted by the client — the account's login ID alone
// determines who signed in, and the server reports back which role (and
// therefore which dashboard) that account belongs to — along with their
// REAL class (student/teacher) or linked children (parent), so the
// dashboard the frontend shows next reflects the actual account, not
// generic placeholder content.
router.post('/login', asyncHandler(async (req, res) => {
  const { id, password } = req.body || {};

  if (!id || !password) {
    return res.status(400).json({ error: 'Please enter both your login ID and password.' });
  }

  const user = await findAccount(String(id).trim());
  if (!user || !verifyPassword(user, password)) {
    return res.status(401).json({
      error: 'No account matches that ID and password. Ask your administrator if you need an account.',
    });
  }

  issueSessionCookie(res, user);
  res.json({ user: await getUserProfile(user.id) });
}));

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me — used on page load to restore a session. Reads fresh
// from the database (not just the JWT) so that if an admin changes a
// student/teacher's class, or edits a parent's linked children, after the
// person logged in, refreshing the page picks up the change immediately —
// no need to log out and back in.
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const profile = await getUserProfile(req.user.id);
  if (!profile) {
    return res.status(401).json({ error: 'This account no longer exists.' });
  }
  res.json({ user: profile });
}));

module.exports = router;
