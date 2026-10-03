# Madaraka Primary — Digital Learning Platform (Node.js backend)

A Node.js/Express backend for the Madaraka Primary school platform. Every
dashboard is now driven entirely by real data in the database — there is
no hardcoded demo content left anywhere in the app.

## What's real

- **Accounts.** SQLite (via Node's built-in `node:sqlite` — no native
  compiler/build tools required) stores every student, teacher, parent and
  admin account. Passwords are hashed with `bcryptjs`. Only admins can
  create accounts (`/api/admin/users`, `requireRole('admin')`) — there is
  no public self-signup.
- **One login form, no role picker.** Login IDs are unique across every
  account regardless of role, so the person just enters their ID +
  password and the server reports back which dashboard to show.
- **Classes.** A fixed list (Grade 1A/1B, 2A/2B, 3A/3B) assignable to a
  student or teacher when their account is created.
- **Parents linked to multiple children**, managed from the Admin
  dashboard (at creation, or later via a "🔗 Manage" button / the
  standalone "Parent–Student Links" picker).
- **Timetable.** A teacher builds their own class's weekly timetable
  (day, time, learning area, topic) from the "Class" tab. Students and
  parents of that class see the same real timetable — nobody sees a
  fixed demo schedule anymore.
- **Class register / attendance.** A teacher takes attendance against
  their *real* class roster (pulled from actual student accounts, not
  invented names), for any date. Every student gets their own
  independent **P / A / L** (Present / Absent / Late) buttons, so a
  teacher can set each student's status individually; "Mark All
  Present/Absent" is still there as a quick bulk starting point, not the
  only way to do it. The same records power a student's own attendance
  summary and a parent's attendance tab for their linked child.
- **Learning materials.** A teacher shares materials (learning area,
  title, notes/link) with their class; students and parents of that class
  see the same real list. There's no file-storage backend, so this stores
  a title/notes/link, not an uploaded file itself.
- **Quizzes.** A teacher writes multiple-choice questions for their class;
  students answer them and see live feedback. The answer key
  (`correct_index`) is never sent to a student in the question list, and
  the answer-check endpoint only reveals it to a student who is actually
  enrolled in that quiz's class — not to any other signed-in account.
- **Messages.** A real, threaded, per-student conversation between a
  parent and their child's actual class teacher (looked up automatically
  by matching class) — not a static "Amina" conversation.
- **CBC lower-primary course book library**, seeded from KICD-approved
  titles, browsable by students and manageable by admins. A book can have
  a resource link. Every one of the 24 seeded titles now links to its real
  publisher's official site (KLB, EAEP, Oxford University Press East
  Africa, or Longhorn — verified against multiple independent sources),
  not a generic search — these are commercial textbooks, so a verified
  publisher page is the honest "direct link" available, rather than
  claiming a free PDF exists. Admin-added books without a link still fall
  back to a labeled web search (🔎) so a title is never a dead click.
- **Quizzes can be structured (multiple choice) or unstructured
  (open-ended).** A teacher picks the question type when creating it.
  Structured questions work as before — four options, one correct answer,
  auto-marked. Unstructured questions have no options at all: a student
  types a free-text answer, which is saved (and can be updated) for the
  teacher to read from a "👀 View Responses" panel in the Quiz Bank —
  there's no automatic right/wrong to compute.

There is deliberately **no separate letter-grading / competency-level
module** — the "Results" tab shows an attendance summary computed from the
real register, with an honest note that there's no grading feature yet,
rather than a fake "EE/ME" competency table.

## Project structure

```
package.json
.env.example          copy to .env and edit before running
src/
  server.js            Express app entrypoint
  db.js                SQLite schema + queries (users, books, classes, timetable,
                        attendance, materials, quizzes, messages, parent↔student links)
  seed.js              creates the first admin account (also runs automatically on boot)
  middleware/auth.js   JWT-cookie session handling + role guards
  routes/auth.js       POST /api/auth/login (no role field), /logout, GET /api/auth/me
  routes/admin.js      admin-only: accounts, classes, students picker, parent↔child links
  routes/books.js      GET /api/books (any signed-in user), POST/DELETE (admin only)
  routes/academic.js   timetable, attendance/register, materials, quizzes, messages
public/
  app.html             the whole front end (login screen + 4 dashboards)
data/
  school.db            created automatically on first run (SQLite file)
```

## Requirements

- **Node.js 22.5+** (24.x recommended). This project uses Node's built-in
  `node:sqlite` module instead of a third-party native package, specifically
  to avoid the native-binding / node-gyp build errors those packages cause
  on some machines (especially Windows). You'll see a one-line
  `ExperimentalWarning: SQLite is an experimental feature` on startup —
  that's expected and harmless.

## Getting started

```bash
npm install
cp .env.example .env     # then edit .env, especially JWT_SECRET and ADMIN_PASSWORD
npm start
```

(On Windows PowerShell/cmd, `cp` isn't available — use `copy .env.example .env` instead.)

Open **http://localhost:3000**. Sign in with the `ADMIN_ID` /
`ADMIN_PASSWORD` from your `.env` (defaults: `admin` / `change-me-now` —
change this immediately). From the Admin dashboard, create a teacher
(assigned to a class), some students (in that class), and a parent
(linked to one or more of those students). Everything downstream —
timetable, register, materials, quizzes, messages — is empty until the
teacher actually adds it, and every dashboard reflects that honestly
(empty states, not fake numbers).

If you ever need to (re)create the initial admin without starting the
server, run:

```bash
npm run seed
```

This only creates an admin if none exists yet — it will never overwrite an
existing admin account.

## How the pieces fit together

- **`src/db.js`** owns the schema and every prepared statement. Besides
  `users` and `parent_students` (from earlier), it now has:
  - `books` — includes a `link` column (empty string by default). The 24
    seeded titles ship with real publisher links built in
    (`CBC_LOWER_PRIMARY_BOOKS` in `db.js`); `backfillSeedBookLinks()` runs
    on every boot and fills in the link for any existing book whose title
    matches a seed title and whose `link` is still empty — so upgrading an
    already-running school's database doesn't require re-seeding, and it
    never overwrites a link an admin set themselves.
  - `timetable_entries` — one row per period (`class, day, start_time,
    end_time, learning_area, topic, teacher_id`).
  - `attendance_records` — one row per student per date
    (`UNIQUE(student_id, date)`, upserted so re-marking a day just updates it).
  - `materials` — one row per shared resource (`class, learning_area,
    title, notes, teacher_id`).
  - `quiz_questions` — one row per question, now with a `type` column:
    `'structured'` (multiple choice — needs `option_a..d` + `correct_index`)
    or `'unstructured'` (open-ended — those columns are `NULL`). Older
    databases are migrated automatically on startup: since `option_a..d`
    and `correct_index` used to be `NOT NULL` (SQLite can't just relax
    that with `ALTER TABLE`), the table is rebuilt in place the first time
    the server sees an old-schema database, and every pre-existing
    question is carried over as `'structured'`.
  - `quiz_responses` — a student's free-text answer to one unstructured
    question (`UNIQUE(question_id, student_id)`, upserted so resubmitting
    updates their answer instead of duplicating it).
  - `messages` — one row per message, scoped by `student_id` so a parent
    with more than one child gets a separate thread per child.
- **`src/routes/academic.js`** is where all of the above is exposed, behind
  two authorization helpers:
  - `canManageClass(req, klass)` — true only for an admin, or the teacher
    *currently* assigned to that class (re-checked against the database on
    every request, not trusted from the login-time JWT, so a class
    reassignment takes effect immediately).
  - `canViewStudent(req, studentId)` — true for an admin, the student
    themself, a parent actually linked to them, or their real class
    teacher. Used to gate attendance history and message threads.
  - The quiz-answer endpoint (`POST /quizzes/:id/answer`) checks that the
    caller is a student *enrolled in that quiz's class* before doing
    anything — for a structured question that's what protects
    `correctIndex` from being read back by guessing question ids; for an
    unstructured one it's what's saved into `quiz_responses`.
  - `GET /quizzes/:id/responses` (teacher/admin of that class only) lists
    every student's answer to one unstructured question, and 400s if
    pointed at a structured question — there's nothing to review there,
    it's auto-marked.
- **`src/routes/books.js`** validates `link` server-side (must start with
  `http://` or `https://`, or be left blank) so a book can never end up
  with a `javascript:` URL or similar.
- **Frontend (`public/app.html`)** — every tab that used to show static
  demo rows now calls the matching endpoint on load (`loadRegister()`,
  `loadTimetable()` / `loadStudentTimetable()` / `loadParentTimetable()`,
  `loadMaterials()` and its per-role variants, `loadTeacherQuizzes()` /
  `loadStudentQuiz()`, `loadTeacherThread()` / `loadParentMessageThread()`),
  and shows an honest empty state ("No periods added yet", "No materials
  shared yet", etc.) instead of ever falling back to placeholder content.
  A book's title is rendered through `bookTitleHtml()`, which turns it
  into a real `<a target="_blank" rel="noopener noreferrer">` whenever a
  link is set. The quiz-creation form toggles between the two types via
  `onQuizTypeChange()`; the student quiz view (`renderStudentQuiz()`)
  branches on `q.type` to show either the usual A–D buttons or a textarea
  (`submitOpenAnswer()`); the teacher's Quiz Bank shows a "👀 View
  Responses" toggle (`toggleResponses()`) on each unstructured question.

## Notes & next steps for production

- Set a strong, random `JWT_SECRET` and a non-default `ADMIN_PASSWORD` in
  `.env` before deploying anywhere real.
- Serve over HTTPS — the session cookie is marked `secure` automatically
  when `NODE_ENV=production`.
- Login IDs are global, so pick an ID scheme that won't collide across
  roles in practice — the database rejects a duplicate outright.
- Materials store a title/notes/link, not an actual uploaded file — adding
  real file storage (and a virus/type check on uploads) is the natural
  next step if teachers need to attach PDFs or images directly.
- There's no formal grading/competency module yet (see above) — attendance
  is the only "results" signal right now. A `grades` or `assessments`
  table following the same `class`/`teacher_id`/`student_id` pattern as
  everything else here would be the natural way to add one.
- Timetable, register, materials and quizzes are all scoped by `class`
  (a plain string), not by a `class_id` foreign key — fine for the fixed
  six-class list this school uses, but worth normalizing into its own
  table if classes ever need to be renamed or added dynamically.
- Unstructured quiz responses are stored as-is with no size limit and no
  profanity/safety filtering — fine for a small trusted school deployment,
  but worth adding if this is ever exposed more broadly.
- A book's `link` is only validated for a plausible `http(s)://` shape, not
  checked for reachability — an admin can still enter a URL that 404s.
