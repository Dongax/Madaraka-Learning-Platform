const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

// ─── CONNECTION ───
// Plain SQLite via Node's built-in `node:sqlite` module — no native build
// step and no external service. Data lives in one file (data/school.db by
// default, or wherever DB_PATH points).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'school.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ─── QUERY HELPERS ───
// Small wrappers so the rest of this file (and every route) can use one
// consistent async interface: run() for writes, get() for one row, all()
// for many rows. `args` is either an array (positional `?` placeholders) or
// an object (named `@name` placeholders). node:sqlite is synchronous under
// the hood; the functions stay async so the calling code doesn't change.
function bind(stmt, method, args) {
  if (Array.isArray(args)) return stmt[method](...args);
  if (args && typeof args === 'object') return stmt[method](args);
  return stmt[method]();
}

async function run(sql, args) {
  const info = bind(db.prepare(sql), 'run', args);
  return {
    changes: Number(info.changes),
    lastInsertRowid: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : undefined,
  };
}

async function all(sql, args) {
  return bind(db.prepare(sql), 'all', args).map(row => ({ ...row }));
}

async function get(sql, args) {
  const row = bind(db.prepare(sql), 'get', args);
  return row ? { ...row } : null;
}

// Runs a block of semicolon-separated statements (CREATE TABLE, ALTER
// TABLE, etc.).
async function execMultiple(sql) {
  db.exec(sql);
}

// ─── SCHEMA ───
// One table holds every account. `role` distinguishes student / teacher /
// parent / admin. `login_id` is the admission number / staff ID / parent ID
// / admin username depending on role, and is unique across every account
// regardless of role (login no longer takes a role — see routes/auth.js).
const CLASSES = ['Grade 1A', 'Grade 1B', 'Grade 2A', 'Grade 2B', 'Grade 3A', 'Grade 3B'];

let initPromise = null;
function initSchema() {
  if (!initPromise) initPromise = doInitSchema();
  return initPromise;
}

async function doInitSchema() {
  await execMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      role          TEXT NOT NULL CHECK (role IN ('student','teacher','parent','admin')),
      login_id      TEXT NOT NULL,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      class         TEXT DEFAULT '',
      detail        TEXT DEFAULT '',
      created_by    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(login_id COLLATE NOCASE)
    );

    CREATE TABLE IF NOT EXISTS books (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      grade         TEXT NOT NULL,
      learning_area TEXT NOT NULL,
      title         TEXT NOT NULL,
      publisher     TEXT DEFAULT '',
      link          TEXT DEFAULT '',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS parent_students (
      parent_id     INTEGER NOT NULL,
      student_id    INTEGER NOT NULL,
      PRIMARY KEY (parent_id, student_id),
      FOREIGN KEY (parent_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS timetable_entries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      class         TEXT NOT NULL,
      day           TEXT NOT NULL CHECK (day IN ('Monday','Tuesday','Wednesday','Thursday','Friday')),
      start_time    TEXT NOT NULL,
      end_time      TEXT NOT NULL,
      learning_area TEXT NOT NULL,
      topic         TEXT DEFAULT '',
      teacher_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attendance_records (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      class         TEXT NOT NULL,
      date          TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('present','absent','late')),
      marked_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(student_id, date)
    );

    CREATE TABLE IF NOT EXISTS materials (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      class         TEXT NOT NULL,
      learning_area TEXT NOT NULL,
      title         TEXT NOT NULL,
      notes         TEXT DEFAULT '',
      teacher_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quiz_questions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      class         TEXT NOT NULL,
      learning_area TEXT NOT NULL,
      type          TEXT NOT NULL DEFAULT 'structured' CHECK (type IN ('structured','unstructured')),
      question      TEXT NOT NULL,
      option_a      TEXT,
      option_b      TEXT,
      option_c      TEXT,
      option_d      TEXT,
      correct_index INTEGER CHECK (correct_index IS NULL OR correct_index BETWEEN 0 AND 3),
      teacher_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quiz_responses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id   INTEGER NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
      student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      answer_text   TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(question_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body          TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Backfill columns for databases created before they existed.
  for (const stmt of [
    `ALTER TABLE users ADD COLUMN class TEXT DEFAULT ''`,
    `ALTER TABLE books ADD COLUMN link TEXT DEFAULT ''`,
  ]) {
    try { await run(stmt); } catch (e) { /* column already exists — fine */ }
  }

  // Migrate a pre-existing quiz_questions table (from before 'unstructured'
  // questions existed) to the nullable/typed schema. SQLite can't just
  // ALTER a column to drop NOT NULL, so this rebuilds the table in place —
  // every pre-existing question is implicitly 'structured', the only shape
  // that used to exist.
  const cols = await all(`PRAGMA table_info(quiz_questions)`);
  const hasType = cols.some(c => c.name === 'type');
  if (!hasType) {
    await execMultiple(`
      ALTER TABLE quiz_questions RENAME TO quiz_questions_old;
      CREATE TABLE quiz_questions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        class         TEXT NOT NULL,
        learning_area TEXT NOT NULL,
        type          TEXT NOT NULL DEFAULT 'structured' CHECK (type IN ('structured','unstructured')),
        question      TEXT NOT NULL,
        option_a      TEXT,
        option_b      TEXT,
        option_c      TEXT,
        option_d      TEXT,
        correct_index INTEGER CHECK (correct_index IS NULL OR correct_index BETWEEN 0 AND 3),
        teacher_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO quiz_questions (id, class, learning_area, type, question, option_a, option_b, option_c, option_d, correct_index, teacher_id, created_at)
        SELECT id, class, learning_area, 'structured', question, option_a, option_b, option_c, option_d, correct_index, teacher_id, created_at
        FROM quiz_questions_old;
      DROP TABLE quiz_questions_old;
    `);
  }
}

// ─── USERS ───
async function createUser({ role, loginId, name, password, klass, detail, createdBy }) {
  const password_hash = bcrypt.hashSync(password, 10);
  const info = await run(
    `INSERT INTO users (role, login_id, name, password_hash, class, detail, created_by)
     VALUES (@role, @login_id, @name, @password_hash, @class, @detail, @created_by)`,
    {
      role, login_id: loginId, name, password_hash,
      class: klass || '', detail: detail || '', created_by: createdBy || null,
    }
  );
  return get(`SELECT * FROM users WHERE id = ?`, [info.lastInsertRowid]);
}

async function findAccount(loginId) {
  return get(`SELECT * FROM users WHERE login_id = ? COLLATE NOCASE`, [loginId]);
}

function verifyPassword(user, password) {
  return !!user && bcrypt.compareSync(password, user.password_hash);
}

async function listUsers() {
  const users = await all(
    `SELECT id, role, login_id, name, class, detail, created_by, created_at FROM users ORDER BY created_at DESC`
  );
  // Attach each parent's linked children so the admin directory can show
  // them without a round trip per row.
  const out = [];
  for (const u of users) {
    if (u.role === 'parent') {
      out.push({ ...u, children: await all(
        `SELECT u.id, u.login_id, u.name, u.class FROM parent_students ps JOIN users u ON u.id = ps.student_id WHERE ps.parent_id = ? ORDER BY u.name ASC`,
        [u.id]
      ) });
    } else {
      out.push(u);
    }
  }
  return out;
}

async function listUsersByRole(role) {
  return all(
    `SELECT id, role, login_id, name, class, detail, created_by, created_at FROM users WHERE role = ? ORDER BY name ASC`,
    [role]
  );
}

async function deleteUser(id) {
  return run(`DELETE FROM users WHERE id = ?`, [id]);
}

async function adminCount() {
  const row = await get(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`);
  return row.n;
}

// ─── PARENT ↔ STUDENT LINKS ───
// Replaces the full set of a parent's linked children in one go — simplest
// mental model for an admin form ("these are the children linked to this
// parent now"), and safe to call again any time to update the list. Any id
// that isn't actually a student account is silently skipped, so an admin
// can never accidentally "link" a parent to a teacher or another admin —
// even if a raw API call passes the wrong id.
async function setParentChildren(parentId, studentIds) {
  await run(`DELETE FROM parent_students WHERE parent_id = ?`, [parentId]);
  for (const studentId of (studentIds || [])) {
    const id = Number(studentId);
    if (!Number.isInteger(id)) continue;
    const isStudent = await get(`SELECT id FROM users WHERE id = ? AND role = 'student'`, [id]);
    if (isStudent) {
      await run(`INSERT OR IGNORE INTO parent_students (parent_id, student_id) VALUES (?, ?)`, [parentId, id]);
    }
  }
}

async function isParentAccount(id) {
  return !!(await get(`SELECT id FROM users WHERE id = ? AND role = 'parent'`, [id]));
}

async function getChildrenOfParent(parentId) {
  const children = await all(
    `SELECT u.id, u.login_id, u.name, u.class FROM parent_students ps JOIN users u ON u.id = ps.student_id WHERE ps.parent_id = ? ORDER BY u.name ASC`,
    [parentId]
  );
  // Attach each child's actual class teacher (looked up by matching class),
  // so the parent dashboard can show a real name instead of a placeholder.
  const out = [];
  for (const c of children) {
    const teacher = c.class ? await get(
      `SELECT id, name, detail FROM users WHERE role = 'teacher' AND class = ? ORDER BY name ASC LIMIT 1`, [c.class]
    ) : null;
    out.push({ ...c, classTeacher: teacher?.name || null });
  }
  return out;
}

async function getParentsOfStudent(studentId) {
  return all(
    `SELECT u.id, u.login_id, u.name FROM parent_students ps JOIN users u ON u.id = ps.parent_id WHERE ps.student_id = ? ORDER BY u.name ASC`,
    [studentId]
  );
}

async function getClassTeacher(className) {
  if (!className) return null;
  return get(`SELECT id, name, detail FROM users WHERE role = 'teacher' AND class = ? ORDER BY name ASC LIMIT 1`, [className]);
}

async function countStudentsInClass(className) {
  if (!className) return 0;
  const row = await get(`SELECT COUNT(*) AS n FROM users WHERE role = 'student' AND class = ?`, [className]);
  return row.n;
}

async function getStudentsInClass(className) {
  if (!className) return [];
  return all(`SELECT id, login_id, name FROM users WHERE role = 'student' AND class = ? ORDER BY name ASC`, [className]);
}

// Minimal, password-free lookup used by route handlers to authorize an
// action (e.g. "is this person actually the teacher of this class?").
async function getRawUserById(id) {
  const row = await get(`SELECT * FROM users WHERE id = ?`, [id]);
  if (!row) return null;
  const { password_hash, ...safe } = row;
  return safe;
}

async function isParentLinkedToStudent(parentId, studentId) {
  const parents = await getParentsOfStudent(studentId);
  return parents.some(p => p.id === parentId);
}

// Assembles the full "who is this account, and who are they linked to"
// profile used to personalize a dashboard after login — this is the single
// source of truth the frontend uses to show the REAL class a student/teacher
// is assigned to, and the REAL student(s) a parent is linked to, instead of
// generic placeholder content. Never includes password_hash.
async function getUserProfile(id) {
  const row = await get(`SELECT * FROM users WHERE id = ?`, [id]);
  if (!row) return null;
  const profile = {
    id: row.id,
    role: row.role,
    loginId: row.login_id,
    name: row.name,
    class: row.class || '',
    detail: row.detail || '',
  };
  if (row.role === 'parent') {
    profile.children = await getChildrenOfParent(row.id);
  }
  if (row.role === 'student') {
    profile.parents = await getParentsOfStudent(row.id);
    profile.classTeacher = await getClassTeacher(row.class);
  }
  if (row.role === 'teacher') {
    profile.classSize = await countStudentsInClass(row.class);
  }
  return profile;
}

// ─── TIMETABLE ───
async function addTimetableEntry({ klass, day, startTime, endTime, learningArea, topic, teacherId }) {
  const info = await run(
    `INSERT INTO timetable_entries (class, day, start_time, end_time, learning_area, topic, teacher_id)
     VALUES (@class, @day, @start_time, @end_time, @learning_area, @topic, @teacher_id)`,
    { class: klass, day, start_time: startTime, end_time: endTime, learning_area: learningArea, topic: topic || '', teacher_id: teacherId }
  );
  return get(`SELECT * FROM timetable_entries WHERE id = ?`, [info.lastInsertRowid]);
}

async function getTimetableForClass(klass) {
  return all(
    `SELECT * FROM timetable_entries WHERE class = ? ORDER BY
     CASE day WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 END,
     start_time ASC`,
    [klass]
  );
}

async function getTimetableEntry(id) {
  return get(`SELECT * FROM timetable_entries WHERE id = ?`, [id]);
}

async function deleteTimetableEntry(id) {
  return run(`DELETE FROM timetable_entries WHERE id = ?`, [id]);
}

// ─── ATTENDANCE / CLASS REGISTER ───
async function markAttendance({ studentId, klass, date, status, markedBy }) {
  await run(
    `INSERT INTO attendance_records (student_id, class, date, status, marked_by)
     VALUES (@student_id, @class, @date, @status, @marked_by)
     ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by`,
    { student_id: studentId, class: klass, date, status, marked_by: markedBy }
  );
}

async function markAttendanceBulk({ klass, date, entries, markedBy }) {
  for (const e of entries) {
    await markAttendance({ studentId: e.studentId, klass, date, status: e.status, markedBy });
  }
  return getRegisterForClassOnDate(klass, date);
}

async function getRegisterForClassOnDate(klass, date) {
  const roster = await getStudentsInClass(klass);
  const marked = await all(`SELECT * FROM attendance_records WHERE class = ? AND date = ?`, [klass, date]);
  const byStudent = Object.fromEntries(marked.map(m => [m.student_id, m.status]));
  return roster.map(s => ({ studentId: s.id, loginId: s.login_id, name: s.name, status: byStudent[s.id] || null }));
}

async function getAttendanceForStudent(studentId) {
  const history = await all(`SELECT date, status FROM attendance_records WHERE student_id = ? ORDER BY date DESC LIMIT 60`, [studentId]);
  const summaryRow = await get(
    `SELECT
       SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present,
       SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent,
       SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late,
       COUNT(*) AS total
     FROM attendance_records WHERE student_id = ?`,
    [studentId]
  );
  const total = summaryRow.total || 0;
  const present = summaryRow.present || 0;
  return {
    history,
    present,
    absent: summaryRow.absent || 0,
    late: summaryRow.late || 0,
    total,
    rate: total ? Math.round((present / total) * 100) : null,
  };
}

async function getAttendanceCountsForClassOnDate(klass, date) {
  const rows = await all(`SELECT status, COUNT(*) AS n FROM attendance_records WHERE class = ? AND date = ? GROUP BY status`, [klass, date]);
  const counts = { present: 0, absent: 0, late: 0 };
  rows.forEach(r => { counts[r.status] = r.n; });
  return counts;
}

// ─── MATERIALS ───
async function addMaterial({ klass, learningArea, title, notes, teacherId }) {
  const info = await run(
    `INSERT INTO materials (class, learning_area, title, notes, teacher_id) VALUES (@class, @learning_area, @title, @notes, @teacher_id)`,
    { class: klass, learning_area: learningArea, title, notes: notes || '', teacher_id: teacherId }
  );
  return get(`SELECT * FROM materials WHERE id = ?`, [info.lastInsertRowid]);
}

async function getMaterialsForClass(klass) {
  return all(`SELECT * FROM materials WHERE class = ? ORDER BY created_at DESC`, [klass]);
}

async function getMaterial(id) {
  return get(`SELECT * FROM materials WHERE id = ?`, [id]);
}

async function deleteMaterial(id) {
  return run(`DELETE FROM materials WHERE id = ?`, [id]);
}

// ─── QUIZ QUESTIONS ───
// type: 'structured' (multiple choice — needs all 4 options + correctIndex)
// or 'unstructured' (open-ended — options/correctIndex are left null; a
// student types a free-text answer instead, stored in quiz_responses).
async function addQuizQuestion({ klass, learningArea, type, question, optionA, optionB, optionC, optionD, correctIndex, teacherId }) {
  const isStructured = type !== 'unstructured';
  const info = await run(
    `INSERT INTO quiz_questions (class, learning_area, type, question, option_a, option_b, option_c, option_d, correct_index, teacher_id)
     VALUES (@class, @learning_area, @type, @question, @option_a, @option_b, @option_c, @option_d, @correct_index, @teacher_id)`,
    {
      class: klass, learning_area: learningArea, type: isStructured ? 'structured' : 'unstructured', question,
      option_a: isStructured ? optionA : null, option_b: isStructured ? optionB : null,
      option_c: isStructured ? optionC : null, option_d: isStructured ? optionD : null,
      correct_index: isStructured ? correctIndex : null, teacher_id: teacherId,
    }
  );
  return get(`SELECT * FROM quiz_questions WHERE id = ?`, [info.lastInsertRowid]);
}

async function getQuizzesForClass(klass) {
  return all(`SELECT * FROM quiz_questions WHERE class = ? ORDER BY created_at DESC`, [klass]);
}

async function getQuizQuestion(id) {
  return get(`SELECT * FROM quiz_questions WHERE id = ?`, [id]);
}

async function deleteQuizQuestion(id) {
  return run(`DELETE FROM quiz_questions WHERE id = ?`, [id]);
}

// A student's free-text answer to one unstructured question. Re-submitting
// updates their existing answer rather than creating a duplicate.
async function saveQuizResponse({ questionId, studentId, answerText }) {
  await run(
    `INSERT INTO quiz_responses (question_id, student_id, answer_text)
     VALUES (@question_id, @student_id, @answer_text)
     ON CONFLICT(question_id, student_id) DO UPDATE SET answer_text = excluded.answer_text, created_at = datetime('now')`,
    { question_id: questionId, student_id: studentId, answer_text: answerText }
  );
  return get(`SELECT * FROM quiz_responses WHERE question_id = ? AND student_id = ?`, [questionId, studentId]);
}

async function getResponsesForQuestion(questionId) {
  return all(
    `SELECT qr.*, u.name AS student_name, u.login_id AS student_login_id
     FROM quiz_responses qr JOIN users u ON u.id = qr.student_id
     WHERE qr.question_id = ? ORDER BY qr.created_at ASC`,
    [questionId]
  );
}

async function getStudentResponse(questionId, studentId) {
  return get(`SELECT * FROM quiz_responses WHERE question_id = ? AND student_id = ?`, [questionId, studentId]);
}

// ─── MESSAGES (parent ↔ teacher, scoped per student) ───
async function sendMessage({ studentId, fromUserId, toUserId, body }) {
  const info = await run(
    `INSERT INTO messages (student_id, from_user_id, to_user_id, body) VALUES (@student_id, @from_user_id, @to_user_id, @body)`,
    { student_id: studentId, from_user_id: fromUserId, to_user_id: toUserId, body }
  );
  return { id: info.lastInsertRowid, studentId, fromUserId, toUserId, body };
}

async function getThreadForStudent(studentId) {
  return all(
    `SELECT m.*, fu.name AS from_name, fu.role AS from_role FROM messages m
     JOIN users fu ON fu.id = m.from_user_id
     WHERE m.student_id = ? ORDER BY m.created_at ASC`,
    [studentId]
  );
}

// ─── BOOKS (CBC LOWER PRIMARY COURSE BOOKS) ───
async function createBook({ grade, learningArea, title, publisher, link }) {
  const info = await run(
    `INSERT INTO books (grade, learning_area, title, publisher, link) VALUES (@grade, @learning_area, @title, @publisher, @link)`,
    { grade, learning_area: learningArea, title, publisher: publisher || '', link: link || '' }
  );
  return get(`SELECT * FROM books WHERE id = ?`, [info.lastInsertRowid]);
}

async function listBooks({ grade, learningArea } = {}) {
  if (grade && learningArea) return all(`SELECT * FROM books WHERE grade = ? AND learning_area = ? ORDER BY title ASC`, [grade, learningArea]);
  if (grade) return all(`SELECT * FROM books WHERE grade = ? ORDER BY learning_area ASC, title ASC`, [grade]);
  if (learningArea) return all(`SELECT * FROM books WHERE learning_area = ? ORDER BY grade ASC, title ASC`, [learningArea]);
  return all(`SELECT * FROM books ORDER BY grade ASC, learning_area ASC, title ASC`);
}

async function deleteBook(id) {
  return run(`DELETE FROM books WHERE id = ?`, [id]);
}

async function bookCount() {
  const row = await get(`SELECT COUNT(*) AS n FROM books`);
  return row.n;
}

// Representative KICD-approved lower-primary (Grade 1–3) CBC course books,
// drawn from KICD's published approved-textbook lists. Schools should
// always confirm the current approved titles directly with KICD, since
// approved lists are periodically revised.
// Each seeded title links to its real publisher's official catalog/website
// (verified against multiple independent sources — not a specific product
// page, since publishers don't expose stable per-title URLs, but a real,
// legitimate place to find or buy the book — rather than leaving the
// student with only a generic web search).
const KLB_LINK = 'https://klb.co.ke/cbc-books/';
const EAEP_LINK = 'https://www.eastafricanpublishers.com/';
const OXFORD_LINK = 'https://www.oxford.co.ke/';
const LONGHORN_LINK = 'https://www.longhornpublishers.com/';

const CBC_LOWER_PRIMARY_BOOKS = [
  // Grade 1
  { grade: 'Grade 1', learningArea: 'English Language Activities', title: 'KLB Visionary English Activities Grade 1', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 1', learningArea: 'Kiswahili Language Activities', title: 'KLB Visionary Kiswahili Activities Grade 1', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 1', learningArea: 'Mathematical Activities', title: 'KLB Visionary Mathematics Activities Grade 1', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 1', learningArea: 'Environmental Activities', title: 'Our Lives Today Environmental Activities', publisher: 'Oxford University Press', link: OXFORD_LINK },
  { grade: 'Grade 1', learningArea: 'Religious Education Activities', title: 'KLB Visionary CRE Activities Grade 1', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 1', learningArea: 'Creative Activities', title: 'KLB Visionary Art and Craft Activities Grade 1', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 1', learningArea: 'Creative Activities', title: 'KLB Visionary Music Activities Grade 1', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 1', learningArea: 'Creative Activities', title: 'Longhorn Primary Movement Activities', publisher: 'Longhorn Publishers', link: LONGHORN_LINK },

  // Grade 2
  { grade: 'Grade 2', learningArea: 'English Language Activities', title: 'KLB Visionary English Activities Grade 2', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 2', learningArea: 'Kiswahili Language Activities', title: 'Kiswahili Angaza Grade 2', publisher: 'East African Educational Publishers (EAEP)', link: EAEP_LINK },
  { grade: 'Grade 2', learningArea: 'Mathematical Activities', title: 'KLB Visionary Mathematical Activities Grade 2', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 2', learningArea: 'Environmental Activities', title: 'Our Lives Today Environmental Activities', publisher: 'Oxford University Press', link: OXFORD_LINK },
  { grade: 'Grade 2', learningArea: 'Religious Education Activities', title: 'KLB Visionary CRE Activities Grade 2', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 2', learningArea: 'Creative Activities', title: 'KLB Visionary Art and Craft Activities Grade 2', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 2', learningArea: 'Creative Activities', title: 'KLB Visionary Music Activities Grade 2', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 2', learningArea: 'Creative Activities', title: 'KLB Visionary Movement Activities Grade 2', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },

  // Grade 3
  { grade: 'Grade 3', learningArea: 'English Language Activities', title: 'KLB Visionary English Activities Grade 3', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 3', learningArea: 'Kiswahili Language Activities', title: 'Kiswahili Angaza Grade 3', publisher: 'East African Educational Publishers (EAEP)', link: EAEP_LINK },
  { grade: 'Grade 3', learningArea: 'Mathematical Activities', title: 'KLB Visionary Mathematics Activities Grade 3', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 3', learningArea: 'Environmental Activities', title: 'Our Lives Today Environmental Activities', publisher: 'Oxford University Press', link: OXFORD_LINK },
  { grade: 'Grade 3', learningArea: 'Religious Education Activities', title: 'KLB Visionary CRE Activities Grade 3', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 3', learningArea: 'Creative Activities', title: 'KLB Visionary Art and Craft Activities Grade 3', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 3', learningArea: 'Creative Activities', title: 'KLB Visionary Music Activities Grade 3', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
  { grade: 'Grade 3', learningArea: 'Creative Activities', title: 'KLB Visionary Movement Activities Grade 3', publisher: 'Kenya Literature Bureau (KLB)', link: KLB_LINK },
];

async function ensureBooksSeeded() {
  if ((await bookCount()) > 0) {
    await backfillSeedBookLinks();
    return;
  }
  for (const b of CBC_LOWER_PRIMARY_BOOKS) await createBook(b);
  console.log(`[seed] Loaded ${CBC_LOWER_PRIMARY_BOOKS.length} lower-primary CBC course books (Grade 1–3).`);
}

// One-time repair for databases seeded before publisher links existed: if a
// book's title exactly matches one of our seed titles and it currently has
// no link, fill in the real publisher link. Only touches rows with an empty
// link, so a book an admin has already edited (or added themselves) is
// never overwritten.
async function backfillSeedBookLinks() {
  let updated = 0;
  for (const b of CBC_LOWER_PRIMARY_BOOKS) {
    if (!b.link) continue;
    const info = await run(
      `UPDATE books SET link = ? WHERE title = ? AND (link IS NULL OR link = '')`,
      [b.link, b.title]
    );
    updated += info.changes;
  }
  if (updated > 0) {
    console.log(`[seed] Backfilled publisher links for ${updated} existing course book(s).`);
  }
}

// ─── SEED FIRST ADMIN ───
// If no admin account exists yet, create one from environment variables so
// the platform is never left with zero admins (which would make it
// impossible to create any other account).
async function ensureInitialAdmin() {
  if ((await adminCount()) > 0) return;
  const loginId = process.env.ADMIN_ID || 'admin';
  const name = process.env.ADMIN_NAME || 'School Administrator';
  const password = process.env.ADMIN_PASSWORD || 'change-me-now';
  await createUser({ role: 'admin', loginId, name, password, detail: 'Initial admin account', createdBy: 'system-seed' });
  console.log(`\n[seed] Created initial admin account — login ID: "${loginId}"`);
  if (password === 'change-me-now') {
    console.log('[seed] ⚠️  Using the default password. Set ADMIN_PASSWORD in your .env before deploying, then sign in and consider rotating it.\n');
  }
}

module.exports = {
  db,
  CLASSES,
  initSchema,
  createUser,
  findAccount,
  verifyPassword,
  listUsers,
  listUsersByRole,
  deleteUser,
  ensureInitialAdmin,
  createBook,
  listBooks,
  deleteBook,
  ensureBooksSeeded,
  setParentChildren,
  getChildrenOfParent,
  getParentsOfStudent,
  isParentAccount,
  getUserProfile,
  getClassTeacher,
  countStudentsInClass,
  getStudentsInClass,
  getRawUserById,
  isParentLinkedToStudent,
  addTimetableEntry,
  getTimetableForClass,
  getTimetableEntry,
  deleteTimetableEntry,
  markAttendanceBulk,
  getRegisterForClassOnDate,
  getAttendanceForStudent,
  getAttendanceCountsForClassOnDate,
  addMaterial,
  getMaterialsForClass,
  getMaterial,
  deleteMaterial,
  addQuizQuestion,
  getQuizzesForClass,
  getQuizQuestion,
  deleteQuizQuestion,
  saveQuizResponse,
  getResponsesForQuestion,
  getStudentResponse,
  sendMessage,
  getThreadForStudent,
};
