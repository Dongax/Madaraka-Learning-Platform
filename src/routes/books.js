const express = require('express');
const { createBook, listBooks, deleteBook } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const GRADES = ['Grade 1', 'Grade 2', 'Grade 3'];

// GET /api/books?grade=Grade%202&area=Mathematical%20Activities
// Any signed-in user (student, teacher, parent, admin) can browse the
// catalog — only admins can change it.
router.get('/', requireAuth, (req, res) => {
  const { grade, area } = req.query;
  res.json({ books: listBooks({ grade, learningArea: area }) });
});

// POST /api/books — admin only
router.post('/', requireRole('admin'), (req, res) => {
  const { grade, learningArea, title, publisher, link } = req.body || {};

  if (!grade || !GRADES.includes(grade)) {
    return res.status(400).json({ error: `Grade must be one of: ${GRADES.join(', ')}.` });
  }
  if (!learningArea || !title) {
    return res.status(400).json({ error: 'Learning area and title are required.' });
  }
  let cleanLink = '';
  if (link && String(link).trim()) {
    cleanLink = String(link).trim();
    if (!/^https?:\/\//i.test(cleanLink)) {
      return res.status(400).json({ error: 'The resource link must start with http:// or https://.' });
    }
  }

  const book = createBook({
    grade,
    learningArea,
    title: String(title).trim(),
    publisher: publisher ? String(publisher).trim() : '',
    link: cleanLink,
  });
  res.status(201).json({ book });
});

// DELETE /api/books/:id — admin only
router.delete('/:id', requireRole('admin'), (req, res) => {
  const info = deleteBook(Number(req.params.id));
  if (info.changes === 0) {
    return res.status(404).json({ error: 'Book not found.' });
  }
  res.json({ ok: true });
});

module.exports = router;
