const express = require('express');
const {
  CLASSES,
  getRawUserById,
  isParentLinkedToStudent,
  getStudentsInClass,
  getClassTeacher,
  getParentsOfStudent,
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
} = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const LEARNING_AREAS = [
  'English Language Activities',
  'Kiswahili Language Activities',
  'Mathematical Activities',
  'Environmental Activities',
  'Religious Education Activities',
  'Creative Activities',
];

// True if req.user is allowed to manage (write to) data for `klass` — the
// teacher actually assigned to that class right now, or an admin. Always
// re-reads the user's current class from the database rather than trusting
// the JWT, since a teacher's class assignment can change after they logged in.
function canManageClass(req, klass) {
  if (!klass || !CLASSES.includes(klass)) return false;
  if (req.user.role === 'admin') return true;
  if (req.user.role !== 'teacher') return false;
  const me = getRawUserById(req.user.id);
  return !!me && me.class === klass;
}

// True if req.user is allowed to READ data about a specific student —
// the student themself, a parent linked to them, their real class teacher,
// or an admin.
function canViewStudent(req, studentId) {
  if (req.user.role === 'admin') return true;
  if (req.user.role === 'student' && req.user.id === studentId) return true;
  if (req.user.role === 'parent') return isParentLinkedToStudent(req.user.id, studentId);
  if (req.user.role === 'teacher') {
    const student = getRawUserById(studentId);
    const teacher = getRawUserById(req.user.id);
    return !!student && !!teacher && !!student.class && student.class === teacher.class;
  }
  return false;
}

// ─────────────────────────── TIMETABLE ───────────────────────────

// GET /api/timetable?class=Grade 2A — any signed-in user can read a
// class's timetable (a student/parent needs to see it too).
router.get('/timetable', (req, res) => {
  const klass = req.query.class;
  if (!klass || !CLASSES.includes(klass)) {
    return res.status(400).json({ error: 'A valid class is required.' });
  }
  res.json({ entries: getTimetableForClass(klass) });
});

// POST /api/timetable — only the class's own teacher (or an admin) can add
// a period to it.
router.post('/timetable', (req, res) => {
  const { class: klass, day, startTime, endTime, learningArea, topic } = req.body || {};
  if (!canManageClass(req, klass)) {
    return res.status(403).json({ error: 'You can only edit the timetable for your own class.' });
  }
  if (!DAYS.includes(day)) {
    return res.status(400).json({ error: 'Day must be a weekday (Monday–Friday).' });
  }
  if (!startTime || !endTime || !learningArea) {
    return res.status(400).json({ error: 'Start time, end time and learning area are required.' });
  }
  const entry = addTimetableEntry({
    klass, day, startTime, endTime, learningArea, topic, teacherId: req.user.id,
  });
  res.status(201).json({ entry });
});

// DELETE /api/timetable/:id
router.delete('/timetable/:id', (req, res) => {
  const entry = getTimetableEntry(Number(req.params.id));
  if (!entry) return res.status(404).json({ error: 'Timetable entry not found.' });
  if (!canManageClass(req, entry.class)) {
    return res.status(403).json({ error: 'You can only edit the timetable for your own class.' });
  }
  deleteTimetableEntry(entry.id);
  res.json({ ok: true });
});

// ─────────────────────── ATTENDANCE / CLASS REGISTER ───────────────────────

// GET /api/attendance/register?class=Grade 2A&date=2026-09-17 — the
// teacher's real class roster for that date, with each student's marked
// status (or null if not yet marked). This IS the class register.
router.get('/attendance/register', (req, res) => {
  const { class: klass, date } = req.query;
  if (!canManageClass(req, klass)) {
    return res.status(403).json({ error: 'You can only view the register for your own class.' });
  }
  if (!date) return res.status(400).json({ error: 'A date is required.' });
  res.json({
    roster: getRegisterForClassOnDate(klass, date),
    counts: getAttendanceCountsForClassOnDate(klass, date),
  });
});

// POST /api/attendance/register — { class, date, entries: [{studentId, status}] }
// Marks (or re-marks) attendance for one or more real students in the
// teacher's own class on a given date.
router.post('/attendance/register', (req, res) => {
  const { class: klass, date, entries } = req.body || {};
  if (!canManageClass(req, klass)) {
    return res.status(403).json({ error: 'You can only take the register for your own class.' });
  }
  if (!date) return res.status(400).json({ error: 'A date is required.' });
  if (!Array.isArray(entries) || !entries.length) {
    return res.status(400).json({ error: 'At least one attendance entry is required.' });
  }
  const roster = new Set(getStudentsInClass(klass).map(s => s.id));
  const validStatuses = new Set(['present', 'absent', 'late']);
  const clean = entries.filter(e => roster.has(Number(e.studentId)) && validStatuses.has(e.status))
    .map(e => ({ studentId: Number(e.studentId), status: e.status }));
  if (!clean.length) {
    return res.status(400).json({ error: 'None of the submitted students belong to this class.' });
  }
  const roster2 = markAttendanceBulk({ klass, date, entries: clean, markedBy: req.user.id });
  res.json({ roster: roster2, counts: getAttendanceCountsForClassOnDate(klass, date) });
});

// GET /api/attendance/student/:id — a specific student's attendance
// history + summary. Used by the parent dashboard (for a linked child)
// and could be used by a student viewing their own record.
router.get('/attendance/student/:id', (req, res) => {
  const studentId = Number(req.params.id);
  if (!canViewStudent(req, studentId)) {
    return res.status(403).json({ error: 'You are not authorized to view this student\'s attendance.' });
  }
  res.json(getAttendanceForStudent(studentId));
});

// ─────────────────────────── MATERIALS ───────────────────────────

router.get('/materials', (req, res) => {
  const klass = req.query.class;
  if (!klass || !CLASSES.includes(klass)) {
    return res.status(400).json({ error: 'A valid class is required.' });
  }
  res.json({ materials: getMaterialsForClass(klass) });
});

router.post('/materials', (req, res) => {
  const { class: klass, learningArea, title, notes } = req.body || {};
  if (!canManageClass(req, klass)) {
    return res.status(403).json({ error: 'You can only add materials for your own class.' });
  }
  if (!title || !LEARNING_AREAS.includes(learningArea)) {
    return res.status(400).json({ error: 'A title and a valid learning area are required.' });
  }
  const material = addMaterial({ klass, learningArea, title, notes, teacherId: req.user.id });
  res.status(201).json({ material });
});

router.delete('/materials/:id', (req, res) => {
  const material = getMaterial(Number(req.params.id));
  if (!material) return res.status(404).json({ error: 'Material not found.' });
  if (!canManageClass(req, material.class)) {
    return res.status(403).json({ error: 'You can only remove materials for your own class.' });
  }
  deleteMaterial(material.id);
  res.json({ ok: true });
});

// ─────────────────────────── QUIZZES ───────────────────────────

// Students get the quiz WITHOUT the answer key (structured questions) —
// teachers/admins managing the bank get the full row, since they wrote
// the questions. Unstructured questions have no answer key to strip.
router.get('/quizzes', (req, res) => {
  const klass = req.query.class;
  if (!klass || !CLASSES.includes(klass)) {
    return res.status(400).json({ error: 'A valid class is required.' });
  }
  const quizzes = getQuizzesForClass(klass);
  if (req.user.role === 'student') {
    const stripped = quizzes.map(({ correct_index, ...rest }) => rest);
    // For unstructured questions, also tell the student whether they've
    // already answered (and what they wrote), so the form can pre-fill
    // instead of silently overwriting a previous submission.
    const withResponses = stripped.map(q => {
      if (q.type !== 'unstructured') return q;
      const mine = getStudentResponse(q.id, req.user.id);
      return { ...q, myResponse: mine ? mine.answer_text : null };
    });
    return res.json({ quizzes: withResponses });
  }
  res.json({ quizzes });
});

router.post('/quizzes', (req, res) => {
  const { class: klass, learningArea, type, question, optionA, optionB, optionC, optionD, correctIndex } = req.body || {};
  if (!canManageClass(req, klass)) {
    return res.status(403).json({ error: 'You can only add quiz questions for your own class.' });
  }
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'A question is required.' });
  }
  const isUnstructured = type === 'unstructured';

  if (isUnstructured) {
    const quiz = addQuizQuestion({ klass, learningArea, type: 'unstructured', question: question.trim(), teacherId: req.user.id });
    return res.status(201).json({ quiz });
  }

  if (!optionA || !optionB || !optionC || !optionD) {
    return res.status(400).json({ error: 'A structured question needs a question and all four options.' });
  }
  const idx = Number(correctIndex);
  if (![0, 1, 2, 3].includes(idx)) {
    return res.status(400).json({ error: 'correctIndex must be 0, 1, 2 or 3.' });
  }
  const quiz = addQuizQuestion({
    klass, learningArea, type: 'structured', question: question.trim(),
    optionA, optionB, optionC, optionD, correctIndex: idx, teacherId: req.user.id,
  });
  res.status(201).json({ quiz });
});

router.delete('/quizzes/:id', (req, res) => {
  const quiz = getQuizQuestion(Number(req.params.id));
  if (!quiz) return res.status(404).json({ error: 'Quiz question not found.' });
  if (!canManageClass(req, quiz.class)) {
    return res.status(403).json({ error: 'You can only remove quiz questions for your own class.' });
  }
  deleteQuizQuestion(quiz.id);
  res.json({ ok: true });
});

// A student answers a question. Behavior depends on the question's type:
//  - 'structured': the answer key is only revealed here, per-question,
//    after they've committed to a choice — and only to a student who is
//    actually enrolled in that quiz's class. Without this check, any
//    signed-in account could call this endpoint directly with a guessed
//    question id and read back the correct answer, defeating the point of
//    stripping correct_index from the student-facing GET /quizzes listing.
//  - 'unstructured': there's no right/wrong answer to check — the
//    student's free-text response is stored for the teacher to read.
router.post('/quizzes/:id/answer', (req, res) => {
  const quiz = getQuizQuestion(Number(req.params.id));
  if (!quiz) return res.status(404).json({ error: 'Quiz question not found.' });
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Only students can answer quiz questions.' });
  }
  const me = getRawUserById(req.user.id);
  if (!me || me.class !== quiz.class) {
    return res.status(403).json({ error: 'This quiz question is not for your class.' });
  }

  if (quiz.type === 'unstructured') {
    const answerText = ((req.body || {}).answerText || '').trim();
    if (!answerText) {
      return res.status(400).json({ error: 'Please write an answer before submitting.' });
    }
    const response = saveQuizResponse({ questionId: quiz.id, studentId: req.user.id, answerText });
    return res.json({ saved: true, answerText: response.answer_text });
  }

  const selected = Number((req.body || {}).selectedIndex);
  const correct = selected === quiz.correct_index;
  res.json({ correct, correctIndex: quiz.correct_index });
});

// GET /api/quizzes/:id/responses — every student's free-text answer to one
// unstructured question, for the teacher (or admin) who owns that class to
// review. Not available for structured questions (nothing to review — the
// answer is auto-marked) or to anyone outside that class.
router.get('/quizzes/:id/responses', (req, res) => {
  const quiz = getQuizQuestion(Number(req.params.id));
  if (!quiz) return res.status(404).json({ error: 'Quiz question not found.' });
  if (!canManageClass(req, quiz.class)) {
    return res.status(403).json({ error: 'You can only view responses for your own class.' });
  }
  if (quiz.type !== 'unstructured') {
    return res.status(400).json({ error: 'Structured questions are marked automatically — there are no free-text responses to review.' });
  }
  res.json({ responses: getResponsesForQuestion(quiz.id) });
});

// ─────────────────────────── MESSAGES ───────────────────────────

// GET /api/messages/:studentId — the full parent↔teacher thread about one
// specific student.
router.get('/messages/:studentId', (req, res) => {
  const studentId = Number(req.params.studentId);
  if (!canViewStudent(req, studentId)) {
    return res.status(403).json({ error: 'You are not authorized to view these messages.' });
  }
  res.json({ thread: getThreadForStudent(studentId) });
});

// POST /api/messages — { studentId, body }. Sender must be a parent linked
// to the student, or that student's class teacher (or admin). The
// recipient(s) are derived automatically rather than trusted from the client.
router.post('/messages', (req, res) => {
  const { studentId, body } = req.body || {};
  const sid = Number(studentId);
  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }
  if (req.user.role !== 'parent' && req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Only a linked parent or the class teacher can send messages here.' });
  }
  const student = getRawUserById(sid);
  if (!student || student.role !== 'student') return res.status(404).json({ error: 'Student not found.' });

  if (req.user.role === 'parent') {
    if (!isParentLinkedToStudent(req.user.id, sid)) {
      return res.status(403).json({ error: 'You are not linked to this student.' });
    }
    const classTeacherRow = getClassTeacher(student.class);
    if (!classTeacherRow) {
      return res.status(400).json({ error: 'This student\'s class has no teacher assigned yet, so there is no one to message.' });
    }
    const message = sendMessage({ studentId: sid, fromUserId: req.user.id, toUserId: classTeacherRow.id, body: body.trim() });
    return res.status(201).json({ message });
  }

  if (req.user.role === 'teacher') {
    const me = getRawUserById(req.user.id);
    if (!me || !student.class || me.class !== student.class) {
      return res.status(403).json({ error: 'You can only message parents of students in your own class.' });
    }
    const parents = getParentsOfStudent(sid);
    if (!parents.length) {
      return res.status(400).json({ error: 'This student has no parent account linked yet.' });
    }
    const messages = parents.map(p => sendMessage({ studentId: sid, fromUserId: req.user.id, toUserId: p.id, body: body.trim() }));
    return res.status(201).json({ messages });
  }

  return res.status(403).json({ error: 'Not authorized to send this message.' });
});

module.exports = router;
