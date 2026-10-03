const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'school.db');

// Make sure the data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ─── SCHEMA ───
// One table holds every account. `role` distinguishes student / teacher /
// parent / admin. `login_id` is the admission number / staff ID / parent ID
// / admin username depending on role, and is unique *within* a role (a
// student and a teacher are allowed to share the same-looking ID, but two
// students cannot).
db.exec(`
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
`);

// Backfill `class` for databases created before this column existed.
try {
  db.exec(`ALTER TABLE users ADD COLUMN class TEXT DEFAULT ''`);
} catch (e) {
  // column already exists — fine
}

db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    grade         TEXT NOT NULL,
    learning_area TEXT NOT NULL,
    title         TEXT NOT NULL,
    publisher     TEXT DEFAULT '',
    link          TEXT DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Backfill `link` for databases created before this column existed.
try {
  db.exec(`ALTER TABLE books ADD COLUMN link TEXT DEFAULT ''`);
} catch (e) {
  // column already exists — fine
}

// Many-to-many: one parent account can be linked to several students, and
// (for blended families / guardians) a student can have more than one
// linked parent account too. Deleting either side automatically cleans up
// the link.
db.exec(`
  CREATE TABLE IF NOT EXISTS parent_students (
    parent_id     INTEGER NOT NULL,
    student_id    INTEGER NOT NULL,
    PRIMARY KEY (parent_id, student_id),
    FOREIGN KEY (parent_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Classes lower-primary students/teachers can be assigned to. Kept as a
// fixed list (rather than a free-text field) so the admin picks a valid
// class from a dropdown instead of typing it slightly differently each time.
const CLASSES = ['Grade 1A', 'Grade 1B', 'Grade 2A', 'Grade 2B', 'Grade 3A', 'Grade 3B'];

// A teacher's own timetable for their class — replaces the fixed demo
// schedule that used to be hardcoded in the page. One row per period.
db.exec(`
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
`);

// The class register: one row per student per date. This is what a
// teacher "takes" attendance into, and it's the same data a parent's
// attendance tab now reads back for their real, linked child.
db.exec(`
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
`);

// Learning materials a teacher shares with their class.
db.exec(`
  CREATE TABLE IF NOT EXISTS materials (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    class         TEXT NOT NULL,
    learning_area TEXT NOT NULL,
    title         TEXT NOT NULL,
    notes         TEXT DEFAULT '',
    teacher_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Quiz questions a teacher writes for their class. Two shapes share one
// table: 'structured' (classic multiple-choice, options + correct answer)
// and 'unstructured' (an open-ended prompt with no fixed options — a
// student types a free-text answer for the teacher to read, not something
// the system can mark right/wrong). That's why option_a..d and
// correct_index are nullable: only 'structured' rows use them.
db.exec(`
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
`);

// Migrate a pre-existing quiz_questions table (from before 'unstructured'
// questions existed) to the nullable/typed schema above. SQLite can't just
// ALTER a column to drop NOT NULL, so this rebuilds the table in place —
// every pre-existing question is implicitly 'structured', since that's
// the only shape that used to exist.
{
  const cols = db.prepare(`PRAGMA table_info(quiz_questions)`).all();
  const hasType = cols.some(c => c.name === 'type');
  if (!hasType) {
    db.exec(`
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

// A student's free-text answer to an 'unstructured' question — one row per
// student per question (re-submitting updates it) so the teacher can read
// what each student wrote. Structured questions don't use this table; a
// student's multiple-choice answer is only checked, never stored.
db.exec(`
  CREATE TABLE IF NOT EXISTS quiz_responses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id   INTEGER NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
    student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    answer_text   TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(question_id, student_id)
  );
`);

// Parent ↔ teacher messages, scoped to a specific student so a parent with
// more than one child gets a separate thread per child.
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body          TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─── STATEMENTS ───
const stmts = {
  findByLoginId: db.prepare(
    `SELECT * FROM users WHERE login_id = ? COLLATE NOCASE`
  ),
  insertUser: db.prepare(
    `INSERT INTO users (role, login_id, name, password_hash, class, detail, created_by)
     VALUES (@role, @login_id, @name, @password_hash, @class, @detail, @created_by)`
  ),
  listUsers: db.prepare(
    `SELECT id, role, login_id, name, class, detail, created_by, created_at FROM users ORDER BY created_at DESC`
  ),
  listUsersByRole: db.prepare(
    `SELECT id, role, login_id, name, class, detail, created_by, created_at FROM users WHERE role = ? ORDER BY name ASC`
  ),
  getById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  deleteById: db.prepare(`DELETE FROM users WHERE id = ?`),
  countAdmins: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`),

  insertBook: db.prepare(
    `INSERT INTO books (grade, learning_area, title, publisher, link) VALUES (@grade, @learning_area, @title, @publisher, @link)`
  ),
  listBooksAll: db.prepare(
    `SELECT * FROM books ORDER BY grade ASC, learning_area ASC, title ASC`
  ),
  listBooksByGrade: db.prepare(
    `SELECT * FROM books WHERE grade = ? ORDER BY learning_area ASC, title ASC`
  ),
  listBooksByArea: db.prepare(
    `SELECT * FROM books WHERE learning_area = ? ORDER BY grade ASC, title ASC`
  ),
  listBooksByGradeAndArea: db.prepare(
    `SELECT * FROM books WHERE grade = ? AND learning_area = ? ORDER BY title ASC`
  ),
  getBookById: db.prepare(`SELECT * FROM books WHERE id = ?`),
  deleteBookById: db.prepare(`DELETE FROM books WHERE id = ?`),
  countBooks: db.prepare(`SELECT COUNT(*) AS n FROM books`),

  clearParentLinks: db.prepare(`DELETE FROM parent_students WHERE parent_id = ?`),
  insertParentLink: db.prepare(`INSERT OR IGNORE INTO parent_students (parent_id, student_id) VALUES (?, ?)`),
  isStudent: db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'student'`),
  isParent: db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'parent'`),
  childrenOfParent: db.prepare(`
    SELECT u.id, u.login_id, u.name, u.class
    FROM parent_students ps
    JOIN users u ON u.id = ps.student_id
    WHERE ps.parent_id = ?
    ORDER BY u.name ASC
  `),
  parentsOfStudent: db.prepare(`
    SELECT u.id, u.login_id, u.name
    FROM parent_students ps
    JOIN users u ON u.id = ps.parent_id
    WHERE ps.student_id = ?
    ORDER BY u.name ASC
  `),
  teacherForClass: db.prepare(
    `SELECT id, name, detail FROM users WHERE role = 'teacher' AND class = ? ORDER BY name ASC LIMIT 1`
  ),
  countStudentsInClass: db.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE role = 'student' AND class = ?`
  ),
  studentsInClass: db.prepare(
    `SELECT id, login_id, name FROM users WHERE role = 'student' AND class = ? ORDER BY name ASC`
  ),

  // Timetable
  insertTimetableEntry: db.prepare(
    `INSERT INTO timetable_entries (class, day, start_time, end_time, learning_area, topic, teacher_id)
     VALUES (@class, @day, @start_time, @end_time, @learning_area, @topic, @teacher_id)`
  ),
  listTimetableByClass: db.prepare(
    `SELECT * FROM timetable_entries WHERE class = ? ORDER BY
     CASE day WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 END,
     start_time ASC`
  ),
  getTimetableEntryById: db.prepare(`SELECT * FROM timetable_entries WHERE id = ?`),
  deleteTimetableEntryById: db.prepare(`DELETE FROM timetable_entries WHERE id = ?`),

  // Attendance / class register
  upsertAttendance: db.prepare(`
    INSERT INTO attendance_records (student_id, class, date, status, marked_by)
    VALUES (@student_id, @class, @date, @status, @marked_by)
    ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by
  `),
  attendanceForClassOnDate: db.prepare(
    `SELECT * FROM attendance_records WHERE class = ? AND date = ?`
  ),
  attendanceForStudent: db.prepare(
    `SELECT date, status FROM attendance_records WHERE student_id = ? ORDER BY date DESC LIMIT 60`
  ),
  attendanceSummaryForStudent: db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late,
      COUNT(*) AS total
    FROM attendance_records WHERE student_id = ?
  `),
  attendanceCountForClassOnDate: db.prepare(
    `SELECT status, COUNT(*) AS n FROM attendance_records WHERE class = ? AND date = ? GROUP BY status`
  ),

  // Materials
  insertMaterial: db.prepare(
    `INSERT INTO materials (class, learning_area, title, notes, teacher_id) VALUES (@class, @learning_area, @title, @notes, @teacher_id)`
  ),
  listMaterialsByClass: db.prepare(
    `SELECT * FROM materials WHERE class = ? ORDER BY created_at DESC`
  ),
  getMaterialById: db.prepare(`SELECT * FROM materials WHERE id = ?`),
  deleteMaterialById: db.prepare(`DELETE FROM materials WHERE id = ?`),

  // Quiz questions
  insertQuiz: db.prepare(
    `INSERT INTO quiz_questions (class, learning_area, type, question, option_a, option_b, option_c, option_d, correct_index, teacher_id)
     VALUES (@class, @learning_area, @type, @question, @option_a, @option_b, @option_c, @option_d, @correct_index, @teacher_id)`
  ),
  listQuizzesByClass: db.prepare(
    `SELECT * FROM quiz_questions WHERE class = ? ORDER BY created_at DESC`
  ),
  getQuizById: db.prepare(`SELECT * FROM quiz_questions WHERE id = ?`),
  deleteQuizById: db.prepare(`DELETE FROM quiz_questions WHERE id = ?`),

  // Free-text responses to unstructured quiz questions
  upsertQuizResponse: db.prepare(`
    INSERT INTO quiz_responses (question_id, student_id, answer_text)
    VALUES (@question_id, @student_id, @answer_text)
    ON CONFLICT(question_id, student_id) DO UPDATE SET answer_text = excluded.answer_text, created_at = datetime('now')
  `),
  responsesForQuestion: db.prepare(`
    SELECT qr.*, u.name AS student_name, u.login_id AS student_login_id
    FROM quiz_responses qr
    JOIN users u ON u.id = qr.student_id
    WHERE qr.question_id = ?
    ORDER BY qr.created_at ASC
  `),
  responseForStudent: db.prepare(
    `SELECT * FROM quiz_responses WHERE question_id = ? AND student_id = ?`
  ),

  // Messages
  insertMessage: db.prepare(
    `INSERT INTO messages (student_id, from_user_id, to_user_id, body) VALUES (@student_id, @from_user_id, @to_user_id, @body)`
  ),
  threadForStudent: db.prepare(
    `SELECT m.*, fu.name AS from_name, fu.role AS from_role FROM messages m
     JOIN users fu ON fu.id = m.from_user_id
     WHERE m.student_id = ? ORDER BY m.created_at ASC`
  ),
};

function createUser({ role, loginId, name, password, klass, detail, createdBy }) {
  const password_hash = bcrypt.hashSync(password, 10);
  const info = stmts.insertUser.run({
    role,
    login_id: loginId,
    name,
    password_hash,
    class: klass || '',
    detail: detail || '',
    created_by: createdBy || null,
  });
  return stmts.getById.get(info.lastInsertRowid);
}

function findAccount(loginId) {
  return stmts.findByLoginId.get(loginId);
}

function verifyPassword(user, password) {
  return !!user && bcrypt.compareSync(password, user.password_hash);
}

function listUsers() {
  const users = stmts.listUsers.all();
  // Attach each parent's linked children so the admin directory can show
  // them without a round trip per row.
  return users.map(u => (
    u.role === 'parent' ? { ...u, children: stmts.childrenOfParent.all(u.id) } : u
  ));
}

function listUsersByRole(role) {
  return stmts.listUsersByRole.all(role);
}

function deleteUser(id) {
  return stmts.deleteById.run(id);
}

function adminCount() {
  return stmts.countAdmins.get().n;
}

// ─── PARENT ↔ STUDENT LINKS ───
// Replaces the full set of a parent's linked children in one go — simplest
// mental model for an admin form ("these are the children linked to this
// parent now"), and safe to call again any time to update the list. Any id
// that isn't actually a student account is silently skipped, so an admin
// can never accidentally "link" a parent to a teacher or another admin —
// even if a raw API call passes the wrong id.
function setParentChildren(parentId, studentIds) {
  stmts.clearParentLinks.run(parentId);
  (studentIds || []).forEach(studentId => {
    const id = Number(studentId);
    if (Number.isInteger(id) && stmts.isStudent.get(id)) {
      stmts.insertParentLink.run(parentId, id);
    }
  });
}

function isParentAccount(id) {
  return !!stmts.isParent.get(id);
}

function getChildrenOfParent(parentId) {
  const children = stmts.childrenOfParent.all(parentId);
  // Attach each child's actual class teacher (looked up by matching class),
  // so the parent dashboard can show a real name instead of a placeholder.
  return children.map(c => ({
    ...c,
    classTeacher: c.class ? (stmts.teacherForClass.get(c.class)?.name || null) : null,
  }));
}

function getParentsOfStudent(studentId) {
  return stmts.parentsOfStudent.all(studentId);
}

function getClassTeacher(className) {
  if (!className) return null;
  return stmts.teacherForClass.get(className) || null;
}

function countStudentsInClass(className) {
  if (!className) return 0;
  return stmts.countStudentsInClass.get(className).n;
}

function getStudentsInClass(className) {
  if (!className) return [];
  return stmts.studentsInClass.all(className);
}

// Minimal, password-free lookup used by route handlers to authorize an
// action (e.g. "is this person actually the teacher of this class?").
function getRawUserById(id) {
  const row = stmts.getById.get(id);
  if (!row) return null;
  const { password_hash, ...safe } = row;
  return safe;
}

function isParentLinkedToStudent(parentId, studentId) {
  return stmts.parentsOfStudent.all(studentId).some(p => p.id === parentId);
}

// Assembles the full "who is this account, and who are they linked to"
// profile used to personalize a dashboard after login — this is the single
// source of truth the frontend uses to show the REAL class a student/teacher
// is assigned to, and the REAL student(s) a parent is linked to, instead of
// generic placeholder content. Never includes password_hash.
function getUserProfile(id) {
  const row = stmts.getById.get(id);
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
    profile.children = getChildrenOfParent(row.id);
  }
  if (row.role === 'student') {
    profile.parents = getParentsOfStudent(row.id);
    profile.classTeacher = getClassTeacher(row.class);
  }
  if (row.role === 'teacher') {
    profile.classSize = countStudentsInClass(row.class);
  }
  return profile;
}

// ─── TIMETABLE ───
function addTimetableEntry({ klass, day, startTime, endTime, learningArea, topic, teacherId }) {
  const info = stmts.insertTimetableEntry.run({
    class: klass,
    day,
    start_time: startTime,
    end_time: endTime,
    learning_area: learningArea,
    topic: topic || '',
    teacher_id: teacherId,
  });
  return stmts.getTimetableEntryById.get(info.lastInsertRowid);
}

function getTimetableForClass(klass) {
  return stmts.listTimetableByClass.all(klass);
}

function getTimetableEntry(id) {
  return stmts.getTimetableEntryById.get(id);
}

function deleteTimetableEntry(id) {
  return stmts.deleteTimetableEntryById.run(id);
}

// ─── ATTENDANCE / CLASS REGISTER ───
function markAttendance({ studentId, klass, date, status, markedBy }) {
  stmts.upsertAttendance.run({
    student_id: studentId,
    class: klass,
    date,
    status,
    marked_by: markedBy,
  });
}

function markAttendanceBulk({ klass, date, entries, markedBy }) {
  // entries: [{ studentId, status }]
  entries.forEach(e => markAttendance({ studentId: e.studentId, klass, date, status: e.status, markedBy }));
  return getRegisterForClassOnDate(klass, date);
}

function getRegisterForClassOnDate(klass, date) {
  const roster = getStudentsInClass(klass);
  const marked = stmts.attendanceForClassOnDate.all(klass, date);
  const byStudent = Object.fromEntries(marked.map(m => [m.student_id, m.status]));
  return roster.map(s => ({ studentId: s.id, loginId: s.login_id, name: s.name, status: byStudent[s.id] || null }));
}

function getAttendanceForStudent(studentId) {
  const history = stmts.attendanceForStudent.all(studentId);
  const summaryRow = stmts.attendanceSummaryForStudent.get(studentId);
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

function getAttendanceCountsForClassOnDate(klass, date) {
  const rows = stmts.attendanceCountForClassOnDate.all(klass, date);
  const counts = { present: 0, absent: 0, late: 0 };
  rows.forEach(r => { counts[r.status] = r.n; });
  return counts;
}

// ─── MATERIALS ───
function addMaterial({ klass, learningArea, title, notes, teacherId }) {
  const info = stmts.insertMaterial.run({
    class: klass,
    learning_area: learningArea,
    title,
    notes: notes || '',
    teacher_id: teacherId,
  });
  return stmts.getMaterialById.get(info.lastInsertRowid);
}

function getMaterialsForClass(klass) {
  return stmts.listMaterialsByClass.all(klass);
}

function getMaterial(id) {
  return stmts.getMaterialById.get(id);
}

function deleteMaterial(id) {
  return stmts.deleteMaterialById.run(id);
}

// ─── QUIZ QUESTIONS ───
// type: 'structured' (multiple choice — needs all 4 options + correctIndex)
// or 'unstructured' (open-ended — options/correctIndex are left null; a
// student types a free-text answer instead, stored in quiz_responses).
function addQuizQuestion({ klass, learningArea, type, question, optionA, optionB, optionC, optionD, correctIndex, teacherId }) {
  const isStructured = type !== 'unstructured';
  const info = stmts.insertQuiz.run({
    class: klass,
    learning_area: learningArea,
    type: isStructured ? 'structured' : 'unstructured',
    question,
    option_a: isStructured ? optionA : null,
    option_b: isStructured ? optionB : null,
    option_c: isStructured ? optionC : null,
    option_d: isStructured ? optionD : null,
    correct_index: isStructured ? correctIndex : null,
    teacher_id: teacherId,
  });
  return stmts.getQuizById.get(info.lastInsertRowid);
}

function getQuizzesForClass(klass) {
  return stmts.listQuizzesByClass.all(klass);
}

function getQuizQuestion(id) {
  return stmts.getQuizById.get(id);
}

function deleteQuizQuestion(id) {
  return stmts.deleteQuizById.run(id);
}

// A student's free-text answer to one unstructured question. Re-submitting
// updates their existing answer rather than creating a duplicate.
function saveQuizResponse({ questionId, studentId, answerText }) {
  stmts.upsertQuizResponse.run({ question_id: questionId, student_id: studentId, answer_text: answerText });
  return stmts.responseForStudent.get(questionId, studentId);
}

function getResponsesForQuestion(questionId) {
  return stmts.responsesForQuestion.all(questionId);
}

function getStudentResponse(questionId, studentId) {
  return stmts.responseForStudent.get(questionId, studentId) || null;
}

// ─── MESSAGES (parent ↔ teacher, scoped per student) ───
function sendMessage({ studentId, fromUserId, toUserId, body }) {
  const info = stmts.insertMessage.run({ student_id: studentId, from_user_id: fromUserId, to_user_id: toUserId, body });
  return { id: Number(info.lastInsertRowid), studentId, fromUserId, toUserId, body };
}

function getThreadForStudent(studentId) {
  return stmts.threadForStudent.all(studentId);
}

// ─── BOOKS (CBC LOWER PRIMARY COURSE BOOKS) ───
function createBook({ grade, learningArea, title, publisher, link }) {
  const info = stmts.insertBook.run({
    grade,
    learning_area: learningArea,
    title,
    publisher: publisher || '',
    link: link || '',
  });
  return stmts.getBookById.get(info.lastInsertRowid);
}

function listBooks({ grade, learningArea } = {}) {
  if (grade && learningArea) return stmts.listBooksByGradeAndArea.all(grade, learningArea);
  if (grade) return stmts.listBooksByGrade.all(grade);
  if (learningArea) return stmts.listBooksByArea.all(learningArea);
  return stmts.listBooksAll.all();
}

function deleteBook(id) {
  return stmts.deleteBookById.run(id);
}

function bookCount() {
  return stmts.countBooks.get().n;
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

function ensureBooksSeeded() {
  if (bookCount() > 0) {
    backfillSeedBookLinks();
    return;
  }
  CBC_LOWER_PRIMARY_BOOKS.forEach(createBook);
  console.log(`[seed] Loaded ${CBC_LOWER_PRIMARY_BOOKS.length} lower-primary CBC course books (Grade 1–3).`);
}

// One-time repair for databases seeded before publisher links existed: if a
// book's title exactly matches one of our seed titles and it currently has
// no link, fill in the real publisher link. Only touches rows with an empty
// link, so a book an admin has already edited (or added themselves) is
// never overwritten.
function backfillSeedBookLinks() {
  const updateLink = db.prepare(
    `UPDATE books SET link = ? WHERE title = ? AND (link IS NULL OR link = '')`
  );
  let updated = 0;
  CBC_LOWER_PRIMARY_BOOKS.forEach(b => {
    if (!b.link) return;
    const info = updateLink.run(b.link, b.title);
    updated += info.changes;
  });
  if (updated > 0) {
    console.log(`[seed] Backfilled publisher links for ${updated} existing course book(s).`);
  }
}

// ─── SEED FIRST ADMIN ───
// If no admin account exists yet, create one from environment variables so
// the platform is never left with zero admins (which would make it
// impossible to create any other account).
function ensureInitialAdmin() {
  if (adminCount() > 0) return;
  const loginId = process.env.ADMIN_ID || 'admin';
  const name = process.env.ADMIN_NAME || 'School Administrator';
  const password = process.env.ADMIN_PASSWORD || 'change-me-now';
  createUser({ role: 'admin', loginId, name, password, detail: 'Initial admin account', createdBy: 'system-seed' });
  console.log(`\n[seed] Created initial admin account — login ID: "${loginId}"`);
  if (password === 'change-me-now') {
    console.log('[seed] ⚠️  Using the default password. Set ADMIN_PASSWORD in your .env before deploying, then sign in and consider rotating it.\n');
  }
}

module.exports = {
  db,
  CLASSES,
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
