const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'madaraka_session';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function issueSessionCookie(res, user) {
  const token = jwt.sign(
    { id: user.id, role: user.role, loginId: user.login_id, name: user.name },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// Reads the cookie (if any) and attaches req.user. Never rejects — routes
// decide for themselves whether a user is required.
function readSession(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      // invalid/expired token — treat as logged out
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    // A browser opening a link (e.g. a shared file) asks for HTML — show a
    // readable page; API calls from the app still get JSON.
    if (req.accepts(['json', 'html']) === 'html') {
      return res.status(401).type('html').send(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Madaraka Primary</title><body style="font-family:system-ui,sans-serif;max-width:460px;margin:15vh auto;padding:0 20px;text-align:center;color:#222">' +
        '<div style="font-size:48px">🔒</div><h2>Please sign in again</h2><p>Your session has ended. Sign in, then open the file again.</p>' +
        '<p><a href="/" style="color:#1A6B3A;font-weight:700">Go to the sign-in page</a></p></body>'
      );
    }
    return res.status(401).json({ error: 'Not signed in.' });
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
    if (req.user.role !== role) {
      return res.status(403).json({ error: `Only ${role}s can do that.` });
    }
    next();
  };
}

module.exports = { COOKIE_NAME, issueSessionCookie, clearSessionCookie, readSession, requireAuth, requireRole };
