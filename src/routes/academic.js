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
  saveMaterialFile,
  getMaterialFile,
  getChildrenOfParent,
  deleteMaterial,
  addQuizQuestion,
  getQuizzesForClass,
  getQuizQuestion,
  deleteQuizQuestion,
  saveQuizResponse,
  getResponsesForQuestion,
  getStudentResponse,
  createAssessment,
  getAssessment,
  listAssessmentsForClass,
  setAssessmentPublished,
  deleteAssessment,
  getGradesRoster,
  saveGrades,
  getPublishedResultsForStudent,
  sendMessage,
  getThreadForStudent,
} = require('../db');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { nairobiToday, isValidISODate } = require('../time');
const { ALLOWED, MAX_UPLOAD_MB, validateUpload } = require('../uploads');

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
async function canManageClass(req, klass) {
  if (!klass || !CLASSES.includes(klass)) return false;
  if (req.user.role === 'admin') return true;
  if (req.user.role !== 'teacher') return false;
  const me = await getRawUserById(req.user.id);
  return !!me && me.class === klass;
}

// True if req.user is allowed to READ data about a specific student —
// the student themself, a parent linked to them, their real class teacher,
// or an admin.
async function canViewStudent(req, studentId) {
  if (req.user.role === 'admin') return true;
  if (req.user.role === 'student' && req.user.id === studentId) return true;
  if (req.user.role === 'parent') return await isParentLinkedToStudent(req.user.id, studentId);
  if (req.user.role === 'teacher') {
    const student = await getRawUserById(studentId);
    const teacher = await getRawUserById(req.user.id);
    return !!student && !!teacher && !!student.class && student.class === teacher.class;
  }
  return false;
}

// ─────────────────────────── TIMETABLE ───────────────────────────

// GET /api/timetable?class=Grade 2A — any signed-in user can read a
// class's timetable (a student/parent needs to see it too).
router.get('/timetable', asyncHandler(async (req, res) => {
  const klass = req.query.class;
  if (!klass || !CLASSES.includes(klass)) {
    return res.status(400).json({ error: 'A valid class is required.' });
  }
  res.json({ entries: await getTimetableForClass(klass) });
}));

// POST /api/timetable — only the class's own teacher (or an admin) can add
// a period to it.
router.post('/timetable', asyncHandler(async (req, res) => {
  const { class: klass, day, startTime, endTime, learningArea, topic } = req.body || {};
  if (!await canManageClass(req, klass)) {
    return res.status(403).json({ error: 'You can only edit the timetable for your own class.' });
  }
  if (!DAYS.includes(day)) {
    return res.status(400).json({ error: 'Day must be a weekday (Monday–Friday).' });
  }
  if (!startTime || !endTime || !learningArea) {
    return res.status(400).json({ error: 'Start time, end time and learning area are required.' });
  }
  const entry = await addTimetableEntry({
    klass, day, startTime, endTime, learningArea, topic, teacherId: req.user.id,
  });
  res.status(201).json({ entry });
}));

// DELETE /api/timetable/:id
router.delete('/timetable/:id', asyncHandler(async (req, res) => {
  const entry = await getTimetableEntry(Number(req.params.id));
  if (!entry) return res.status(404).json({ error: 'Timetable entry not found.' });
  if (!await canManageClass(req, entry.class)) {
    return res.status(403).json({ error: 'You can only edit the timetable for your own class.' });
  }
  await deleteTimetableEntry(entry.id);
  res.json({ ok: true });
}));

// ─────────────────────── ATTENDANCE / CLASS REGISTER ───────────────────────

// GET /api/attendance/register?class=Grade 2A&date=2026-09-17 — the
// teacher's real class roster for that date, with each student's marked
// status (or null if not yet marked). This IS the class register.
router.get('/attendance/register', asyncHandler(async (req, res) => {
  const { class: klass, date } = req.query;
  if (!await canManageClass(req, klass)) {
    return res.status(403).json({ error: 'You can only view the register for your own class.' });
  }
  if (!isValidISODate(date)) return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required.' });
  res.json({
    roster: await getRegisterForClassOnDate(klass, date),
    counts: await getAttendanceCountsForClassOnDate(klass, date),
  });
}));

// POST /api/attendance/register — { class, date, entries: [{studentId, status}] }
// Marks (or re-marks) attendance for one or more real students in the
// teacher's own class on a given date.
router.post('/attendance/register', asyncHandler(async (req, res) => {
  const { class: klass, date, entries } = req.body || {};
  if (!await canManageClass(req, klass)) {
    return res.status(403).json({ error: 'You can only take the register for your own class.' });
  }
  if (!isValidISODate(date)) return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required.' });
  // Dates follow Kenya time; the register can't be marked for a day that
  // hasn't happened yet in Nairobi.
  if (date > nairobiToday()) {
    return res.status(400).json({ error: "You can't take the register for a future date." });
  }
  if (!Array.isArray(entries) || !entries.length) {
    return res.status(400).json({ error: 'At least one attendance entry is required.' });
  }
  const roster = new Set((await getStudentsInClass(klass)).map(s => s.id));
  const validStatuses = new Set(['present', 'absent', 'late']);
  const clean = entries.filter(e => roster.has(Number(e.studentId)) && validStatuses.has(e.status))
    .map(e => ({ studentId: Number(e.studentId), status: e.status }));
  if (!clean.length) {
    return res.status(400).json({ error: 'None of the submitted students belong to this class.' });
  }
  const roster2 = await markAttendanceBulk({ klass, date, entries: clean, markedBy: req.user.id });
  res.json({ roster: roster2, counts: await getAttendanceCountsForClassOnDate(klass, date) });
}));

// GET /api/attendance/student/:id — a specific student's attendance
// history + summary. Used by the parent dashboard (for a linked child)
// and could be used by a student viewing their own record.
router.get('/attendance/student/:id', asyncHandler(async (req, res) => {
  const studentId = Number(req.params.id);
  if (!await canViewStudent(req, studentId)) {
    return res.status(403).json({ error: 'You are not authorized to view this student\'s attendance.' });
  }
  res.json(await getAttendanceForStudent(studentId));
}));

// ─────────────────────────── MATERIALS ───────────────────────────

router.get('/materials', asyncHandler(async (req, res) => {
  const klass = req.query.class;
  if (!klass || !CLASSES.includes(klass)) {
    return res.status(400).json({ error: 'A valid class is required.' });
  }
  res.json({ materials: await getMaterialsForClass(klass) });
}));

// What teachers may upload and how big — the page reads this to show hints.
router.get('/upload-limits', (req, res) => {
  res.json({ maxMb: MAX_UPLOAD_MB, extensions: Object.keys(ALLOWED) });
});

// POST /api/materials — { class, learningArea, title, notes, file?: {name, data} }
// A material can be just a title/notes, or also carry one uploaded file.
router.post('/materials', asyncHandler(async (req, res) => {
  const { class: klass, learningArea, notes, file } = req.body || {};
  let { title } = req.body || {};
  if (!await canManageClass(req, klass)) {
    return res.status(403).json({ error: 'You can only add materials for your own class.' });
  }
  if (!LEARNING_AREAS.includes(learningArea)) {
    return res.status(400).json({ error: 'A valid learning area is required.' });
  }
  // Validate the file BEFORE creating anything, so a rejected upload never
  // leaves a half-created material behind.
  let upload = null;
  if (file) {
    try { upload = validateUpload(file); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  title = (title || '').trim() || (upload ? upload.fileName.replace(/\.[^.]+$/, '') : '');
  if (!title) {
    return res.status(400).json({ error: 'A title (or a file) is required.' });
  }
  const material = await addMaterial({ klass, learningArea, title, notes, teacherId: req.user.id });
  if (upload) {
    await saveMaterialFile({ materialId: material.id, ...upload });
    material.file_name = upload.fileName;
    material.mime_type = upload.mimeType;
    material.file_size = upload.size;
  }
  res.status(201).json({ material });
}));

// Who may open a class's files: admins, that class's teacher, students in
// that class, and parents with a child in that class.
async function canAccessClassContent(req, klass) {
  if (await canManageClass(req, klass)) return true;
  if (req.user.role === 'student') {
    const me = await getRawUserById(req.user.id);
    return !!me && me.class === klass;
  }
  if (req.user.role === 'parent') {
    const children = await getChildrenOfParent(req.user.id);
    return children.some(c => c.class === klass);
  }
  return false;
}

// Links to files are opened in a new browser tab, so a failure there should
// be a readable page rather than raw JSON.
function fileError(req, res, status, message) {
  if (req.accepts(['json', 'html']) === 'html') {
    return res.status(status).type('html').send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Madaraka Primary</title><body style="font-family:system-ui,sans-serif;max-width:460px;margin:15vh auto;padding:0 20px;text-align:center;color:#222">` +
      `<div style="font-size:48px">📄</div><h2>${message}</h2><p><a href="/" style="color:#1A6B3A;font-weight:700">Go back to Madaraka Primary</a></p></body>`
    );
  }
  res.status(status).json({ error: message });
}

// GET /api/materials/:id/file — the uploaded file itself. PDFs and images
// open in the browser; everything else downloads.
router.get('/materials/:id/file', asyncHandler(async (req, res) => {
  const material = await getMaterial(Number(req.params.id));
  if (!material) return fileError(req, res, 404, 'This material no longer exists.');
  if (!await canAccessClassContent(req, material.class)) {
    return fileError(req, res, 403, "You don't have access to this file.");
  }
  const file = await getMaterialFile(material.id);
  if (!file) return fileError(req, res, 404, 'This material has no file attached.');

  const ext = (file.file_name.split('.').pop() || '').toLowerCase();
  // ?download=1 forces a download even for PDFs/images.
  const inline = !!(ALLOWED[ext] && ALLOWED[ext].inline) && req.query.download !== '1';
  const asciiName = file.file_name.replace(/[^\x20-\x7e]/g, '_');
  res.set({
    'Content-Type': file.mime_type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=300',
  });
  res.send(Buffer.from(file.data_b64, 'base64'));
}));

router.delete('/materials/:id', asyncHandler(async (req, res) => {
  const material = await getMaterial(Number(req.params.id));
  if (!material) return res.status(404).json({ error: 'Material not found.' });
  if (!await canManageClass(req, material.class)) {
    return res.status(403).json({ error: 'You can only remove materials for your own class.' });
  }
  await deleteMaterial(material.id);
  res.json({ ok: true });
}));

// ─────────────────────────── QUIZZES ───────────────────────────

// Students get the quiz WITHOUT the answer key (structured questions) —
// teachers/admins managing the bank get the full row, since they wrote
// the questions. Unstructured questions have no answer key to strip.
router.get('/quizzes', asyncHandler(async (req, res) => {
  const klass = req.query.class;
  if (!klass || !CLASSES.includes(klass)) {
    return res.status(400).json({ error: 'A valid class is required.' });
  }
  const quizzes = await getQuizzesForClass(klass);

  // Only the class's own teacher (or an admin) gets the full rows with the
  // answer keys. Everyone else — including parents and teachers of OTHER
  // classes — must never receive correct_index or model_answer.
  if (await canManageClass(req, klass)) {
    return res.json({ quizzes });
  }
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: "You don't have access to this class's quiz." });
  }
  const me = await getRawUserById(req.user.id);
  if (!me || me.class !== klass) {
    return res.status(403).json({ error: 'This quiz is not for your class.' });
  }
  const forStudent = await Promise.all(quizzes.map(async ({ correct_index, model_answer, reveal_answer, ...rest }) => {
    if (rest.type !== 'unstructured') return rest;
    // For unstructured questions, also tell the student what they've already
    // written (so the form pre-fills), and — only once they have answered,
    // and only if the teacher allows it — the teacher's model answer.
    const mine = await getStudentResponse(rest.id, req.user.id);
    const out = { ...rest, myResponse: mine ? mine.answer_text : null };
    if (mine && model_answer && reveal_answer) out.modelAnswer = model_answer;
    return out;
  }));
  return res.json({ quizzes: forStudent });
}));

router.post('/quizzes', asyncHandler(async (req, res) => {
  const { class: klass, learningArea, type, question, optionA, optionB, optionC, optionD, correctIndex, modelAnswer, revealAnswer } = req.body || {};
  if (!await canManageClass(req, klass)) {
    return res.status(403).json({ error: 'You can only add quiz questions for your own class.' });
  }
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'A question is required.' });
  }
  const isUnstructured = type === 'unstructured';

  if (isUnstructured) {
    const cleanModel = typeof modelAnswer === 'string' ? modelAnswer.trim() : '';
    if (cleanModel.length > 2000) {
      return res.status(400).json({ error: 'The model answer is too long (2000 characters maximum).' });
    }
    const quiz = await addQuizQuestion({
      klass, learningArea, type: 'unstructured', question: question.trim(),
      modelAnswer: cleanModel || null, revealAnswer: revealAnswer !== false, teacherId: req.user.id,
    });
    return res.status(201).json({ quiz });
  }

  if (!optionA || !optionB || !optionC || !optionD) {
    return res.status(400).json({ error: 'A structured question needs a question and all four options.' });
  }
  const idx = Number(correctIndex);
  if (![0, 1, 2, 3].includes(idx)) {
    return res.status(400).json({ error: 'correctIndex must be 0, 1, 2 or 3.' });
  }
  const quiz = await addQuizQuestion({
    klass, learningArea, type: 'structured', question: question.trim(),
    optionA, optionB, optionC, optionD, correctIndex: idx, teacherId: req.user.id,
  });
  res.status(201).json({ quiz });
}));

router.delete('/quizzes/:id', asyncHandler(async (req, res) => {
  const quiz = await getQuizQuestion(Number(req.params.id));
  if (!quiz) return res.status(404).json({ error: 'Quiz question not found.' });
  if (!await canManageClass(req, quiz.class)) {
    return res.status(403).json({ error: 'You can only remove quiz questions for your own class.' });
  }
  await deleteQuizQuestion(quiz.id);
  res.json({ ok: true });
}));

// A student answers a question. Behavior depends on the question's type:
//  - 'structured': the answer key is only revealed here, per-question,
//    after they've committed to a choice — and only to a student who is
//    actually enrolled in that quiz's class. Without this check, any
//    signed-in account could call this endpoint directly with a guessed
//    question id and read back the correct answer, defeating the point of
//    stripping correct_index from the student-facing GET /quizzes listing.
//  - 'unstructured': there's no right/wrong answer to check — the
//    student's free-text response is stored for the teacher to read.
router.post('/quizzes/:id/answer', asyncHandler(async (req, res) => {
  const quiz = await getQuizQuestion(Number(req.params.id));
  if (!quiz) return res.status(404).json({ error: 'Quiz question not found.' });
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Only students can answer quiz questions.' });
  }
  const me = await getRawUserById(req.user.id);
  if (!me || me.class !== quiz.class) {
    return res.status(403).json({ error: 'This quiz question is not for your class.' });
  }

  if (quiz.type === 'unstructured') {
    const answerText = ((req.body || {}).answerText || '').trim();
    if (!answerText) {
      return res.status(400).json({ error: 'Please write an answer before submitting.' });
    }
    const response = await saveQuizResponse({ questionId: quiz.id, studentId: req.user.id, answerText });
    const out = { saved: true, answerText: response.answer_text };
    if (quiz.model_answer && quiz.reveal_answer) out.modelAnswer = quiz.model_answer;
    return res.json(out);
  }

  const selected = Number((req.body || {}).selectedIndex);
  const correct = selected === quiz.correct_index;
  res.json({ correct, correctIndex: quiz.correct_index });
}));

// GET /api/quizzes/:id/responses — every student's free-text answer to one
// unstructured question, for the teacher (or admin) who owns that class to
// review. Not available for structured questions (nothing to review — the
// answer is auto-marked) or to anyone outside that class.
router.get('/quizzes/:id/responses', asyncHandler(async (req, res) => {
  const quiz = await getQuizQuestion(Number(req.params.id));
  if (!quiz) return res.status(404).json({ error: 'Quiz question not found.' });
  if (!await canManageClass(req, quiz.class)) {
    return res.status(403).json({ error: 'You can only view responses for your own class.' });
  }
  if (quiz.type !== 'unstructured') {
    return res.status(400).json({ error: 'Structured questions are marked automatically — there are no free-text responses to review.' });
  }
  res.json({ responses: await getResponsesForQuestion(quiz.id) });
}));

// ─────────────────────────── GRADING / RESULTS ───────────────────────────
// A teacher creates an assessment, grades every student (marks and/or a CBC
// competency level EE/ME/AE/BE, plus remarks), then PUBLISHES it. Students
// and parents only ever see grades from published assessments.
const LEVELS = ['EE', 'ME', 'AE', 'BE'];
const TERMS = ['Term 1', 'Term 2', 'Term 3'];

// GET /api/assessments?class=Grade 2A — the class's teacher/admin sees all
// assessments (drafts included); no one else can list them.
router.get('/assessments', asyncHandler(async (req, res) => {
  const klass = req.query.class;
  if (!klass || !CLASSES.includes(klass)) return res.status(400).json({ error: 'A valid class is required.' });
  if (!await canManageClass(req, klass)) {
    return res.status(403).json({ error: 'You can only view assessments for your own class.' });
  }
  res.json({ assessments: await listAssessmentsForClass(klass) });
}));

router.post('/assessments', asyncHandler(async (req, res) => {
  const { class: klass, learningArea, title, term, assessedOn, maxMarks } = req.body || {};
  if (!await canManageClass(req, klass)) {
    return res.status(403).json({ error: 'You can only create assessments for your own class.' });
  }
  if (!LEARNING_AREAS.includes(learningArea)) return res.status(400).json({ error: 'A valid learning area is required.' });
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'A title is required.' });
  if (term && !TERMS.includes(term)) return res.status(400).json({ error: `Term must be one of: ${TERMS.join(', ')}.` });
  const date = assessedOn || nairobiToday();
  if (!isValidISODate(date)) return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required.' });
  let max = null;
  if (maxMarks !== undefined && maxMarks !== null && maxMarks !== '') {
    max = Number(maxMarks);
    if (!Number.isInteger(max) || max < 1 || max > 1000) {
      return res.status(400).json({ error: 'Maximum marks must be a whole number between 1 and 1000 (or left blank for level-only grading).' });
    }
  }
  const assessment = await createAssessment({
    klass, learningArea, title: String(title).trim().slice(0, 150), term: term || '', assessedOn: date, maxMarks: max, teacherId: req.user.id,
  });
  res.status(201).json({ assessment });
}));

// Loads an assessment and checks the caller manages its class (or sends the
// error response itself and returns null).
async function loadManagedAssessment(req, res) {
  const assessment = await getAssessment(Number(req.params.id));
  if (!assessment) { res.status(404).json({ error: 'Assessment not found.' }); return null; }
  if (!await canManageClass(req, assessment.class)) {
    res.status(403).json({ error: 'You can only manage assessments for your own class.' });
    return null;
  }
  return assessment;
}

router.delete('/assessments/:id', asyncHandler(async (req, res) => {
  const assessment = await loadManagedAssessment(req, res); if (!assessment) return;
  await deleteAssessment(assessment.id);
  res.json({ ok: true });
}));

// PATCH /api/assessments/:id/publish  { published: true|false }
router.patch('/assessments/:id/publish', asyncHandler(async (req, res) => {
  const assessment = await loadManagedAssessment(req, res); if (!assessment) return;
  const published = !!(req.body || {}).published;
  await setAssessmentPublished(assessment.id, published);
  res.json({ ok: true, published });
}));

// GET /api/assessments/:id/grades — the class roster with each student's grade
router.get('/assessments/:id/grades', asyncHandler(async (req, res) => {
  const assessment = await loadManagedAssessment(req, res); if (!assessment) return;
  res.json({ assessment, roster: await getGradesRoster(assessment.id, assessment.class) });
}));

// PUT /api/assessments/:id/grades — { entries: [{ studentId, marks, level, remarks }] }
router.put('/assessments/:id/grades', asyncHandler(async (req, res) => {
  const assessment = await loadManagedAssessment(req, res); if (!assessment) return;
  const { entries } = req.body || {};
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries must be an array.' });

  const roster = new Set((await getStudentsInClass(assessment.class)).map(s => s.id));
  const clean = [];
  for (const e of entries) {
    const studentId = Number(e.studentId);
    if (!roster.has(studentId)) continue; // ignore anyone not in this class
    let marks = null;
    if (e.marks !== undefined && e.marks !== null && e.marks !== '') {
      marks = Number(e.marks);
      if (!Number.isFinite(marks) || marks < 0) {
        return res.status(400).json({ error: 'Marks must be a number, 0 or more.' });
      }
      if (assessment.max_marks == null) {
        return res.status(400).json({ error: 'This assessment is level-only (no maximum marks), so marks cannot be entered.' });
      }
      if (marks > assessment.max_marks) {
        return res.status(400).json({ error: `Marks cannot be more than the maximum of ${assessment.max_marks}.` });
      }
    }
    const level = e.level ? String(e.level).toUpperCase() : null;
    if (level && !LEVELS.includes(level)) {
      return res.status(400).json({ error: `Level must be one of: ${LEVELS.join(', ')}.` });
    }
    const remarks = typeof e.remarks === 'string' ? e.remarks.trim().slice(0, 500) : '';
    clean.push({ studentId, marks, level, remarks });
  }
  await saveGrades(assessment.id, clean);
  res.json({ ok: true, saved: clean.length, roster: await getGradesRoster(assessment.id, assessment.class) });
}));

// GET /api/results/student/:studentId — the PUBLISHED grades of one student.
// Allowed for that student, their linked parents, their class teacher and
// admins (same rule as attendance and messages).
router.get('/results/student/:studentId', asyncHandler(async (req, res) => {
  const studentId = Number(req.params.studentId);
  if (!await canViewStudent(req, studentId)) {
    return res.status(403).json({ error: "You don't have access to this student's results." });
  }
  const rows = await getPublishedResultsForStudent(studentId);
  const results = rows.map(r => ({
    ...r,
    percentage: r.max_marks && r.marks != null ? Math.round((r.marks / r.max_marks) * 100) : null,
  }));
  const withPct = results.filter(r => r.percentage != null);
  res.json({
    results,
    summary: {
      assessments: results.length,
      averagePercentage: withPct.length ? Math.round(withPct.reduce((s, r) => s + r.percentage, 0) / withPct.length) : null,
    },
  });
}));

// ─────────────────────────── MESSAGES ───────────────────────────

// GET /api/messages/:studentId — the full parent↔teacher thread about one
// specific student.
router.get('/messages/:studentId', asyncHandler(async (req, res) => {
  const studentId = Number(req.params.studentId);
  if (!await canViewStudent(req, studentId)) {
    return res.status(403).json({ error: 'You are not authorized to view these messages.' });
  }
  res.json({ thread: await getThreadForStudent(studentId) });
}));

// POST /api/messages — { studentId, body }. Sender must be a parent linked
// to the student, or that student's class teacher (or admin). The
// recipient(s) are derived automatically rather than trusted from the client.
router.post('/messages', asyncHandler(async (req, res) => {
  const { studentId, body } = req.body || {};
  const sid = Number(studentId);
  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }
  if (req.user.role !== 'parent' && req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Only a linked parent or the class teacher can send messages here.' });
  }
  const student = await getRawUserById(sid);
  if (!student || student.role !== 'student') return res.status(404).json({ error: 'Student not found.' });

  if (req.user.role === 'parent') {
    if (!await isParentLinkedToStudent(req.user.id, sid)) {
      return res.status(403).json({ error: 'You are not linked to this student.' });
    }
    const classTeacherRow = await getClassTeacher(student.class);
    if (!classTeacherRow) {
      return res.status(400).json({ error: 'This student\'s class has no teacher assigned yet, so there is no one to message.' });
    }
    const message = await sendMessage({ studentId: sid, fromUserId: req.user.id, toUserId: classTeacherRow.id, body: body.trim() });
    return res.status(201).json({ message });
  }

  if (req.user.role === 'teacher') {
    const me = await getRawUserById(req.user.id);
    if (!me || !student.class || me.class !== student.class) {
      return res.status(403).json({ error: 'You can only message parents of students in your own class.' });
    }
    const parents = await getParentsOfStudent(sid);
    if (!parents.length) {
      return res.status(400).json({ error: 'This student has no parent account linked yet.' });
    }
    const messages = [];
    for (const p of parents) {
      messages.push(await sendMessage({ studentId: sid, fromUserId: req.user.id, toUserId: p.id, body: body.trim() }));
    }
    return res.status(201).json({ messages });
  }

  return res.status(403).json({ error: 'Not authorized to send this message.' });
}));

module.exports = router;
