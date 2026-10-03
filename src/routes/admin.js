const express = require('express');
const {
  createUser,
  listUsers,
  listUsersByRole,
  deleteUser,
  setParentChildren,
  getChildrenOfParent,
  isParentAccount,
  CLASSES,
} = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
const ROLES = ['student', 'teacher', 'parent', 'admin'];

// Every route below requires the caller to be signed in as an admin.
router.use(requireRole('admin'));

// GET /api/admin/classes — the fixed list of classes to assign
// students/teachers to (used to populate dropdowns on the create-account form).
router.get('/classes', (req, res) => {
  res.json({ classes: CLASSES });
});

// GET /api/admin/users — list every account. Parent rows include a
// `children` array (their currently linked student accounts).
router.get('/users', (req, res) => {
  res.json({ users: listUsers() });
});

// GET /api/admin/students — lightweight list of student accounts, used to
// populate the "link to student(s)" picker when creating/editing a parent.
router.get('/students', (req, res) => {
  res.json({ students: listUsersByRole('student') });
});

// POST /api/admin/users — create a new account (any role, including admin)
//   - student / teacher: optional `klass` assigns them to one of CLASSES
//   - parent: optional `studentIds` (array) links them to one or more
//     existing student accounts in the same request
router.post('/users', (req, res) => {
  const { role, id, name, password, klass, detail, studentIds } = req.body || {};

  if (!role || !ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }
  if (!id || !name || !password) {
    return res.status(400).json({ error: 'Name, login ID, and password are required.' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }
  if (klass && !CLASSES.includes(klass)) {
    return res.status(400).json({ error: `Class must be one of: ${CLASSES.join(', ')}.` });
  }

  try {
    const user = createUser({
      role,
      loginId: String(id).trim(),
      name: String(name).trim(),
      password,
      klass: (role === 'student' || role === 'teacher') && klass ? klass : '',
      detail: detail ? String(detail).trim() : '',
      createdBy: req.user.loginId,
    });

    let children = [];
    if (role === 'parent' && Array.isArray(studentIds) && studentIds.length) {
      setParentChildren(user.id, studentIds);
      children = getChildrenOfParent(user.id);
    }

    res.status(201).json({
      user: { id: user.id, role: user.role, loginId: user.login_id, name: user.name, class: user.class, detail: user.detail, children },
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'An account with that login ID already exists. Login IDs must be unique across all roles.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

// GET /api/admin/users/:id/children — a parent's currently linked students
router.get('/users/:id/children', (req, res) => {
  const parentId = Number(req.params.id);
  if (!isParentAccount(parentId)) {
    return res.status(404).json({ error: 'That account is not a parent account.' });
  }
  res.json({ children: getChildrenOfParent(parentId) });
});

// PUT /api/admin/users/:id/children — replace a parent's linked students
// (send the full new set of student IDs, e.g. to add or remove a child
// without recreating the parent account). Any id that isn't an existing
// student account is silently ignored server-side (see setParentChildren).
router.put('/users/:id/children', (req, res) => {
  const parentId = Number(req.params.id);
  const { studentIds } = req.body || {};
  if (!isParentAccount(parentId)) {
    return res.status(404).json({ error: 'That account is not a parent account.' });
  }
  if (!Array.isArray(studentIds)) {
    return res.status(400).json({ error: 'studentIds must be an array of student account IDs.' });
  }
  setParentChildren(parentId, studentIds);
  res.json({ children: getChildrenOfParent(parentId) });
});

// DELETE /api/admin/users/:id — remove an account (also removes any
// parent↔student links it was part of, via ON DELETE CASCADE)
router.delete('/users/:id', (req, res) => {
  const targetId = Number(req.params.id);

  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'You cannot remove your own admin account while signed in.' });
  }

  const info = deleteUser(targetId);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'Account not found.' });
  }
  res.json({ ok: true });
});

module.exports = router;
