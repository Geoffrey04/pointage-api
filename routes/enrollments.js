const express = require('express')
const router = express.Router()
const pool = require('../db')

// GET /api/admin/enrollments?class_id=X&year_id=Y
// Liste les élèves inscrits dans une classe pour une année donnée
router.get('/', async (req, res) => {
  const { class_id, year_id } = req.query
  if (!class_id || !year_id) {
    return res.status(400).json({ message: 'class_id et year_id requis' })
  }
  try {
    const { rows } = await pool.query(
      `SELECT ce.id, ce.enrolled_at,
              s.id AS student_id, s.firstname, s.lastname, s.phone,
              c.id AS class_id, c.nom AS class_name
       FROM class_enrollments ce
       JOIN students s ON s.id = ce.student_id
       JOIN classes  c ON c.id = ce.class_id
       WHERE ce.class_id = $1 AND ce.school_year_id = $2
       ORDER BY s.lastname ASC, s.firstname ASC`,
      [class_id, year_id],
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /api/admin/enrollments :', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

// GET /api/admin/enrollments/student/:studentId
// Historique de toutes les inscriptions d'un élève
router.get('/student/:studentId', async (req, res) => {
  const id = Number(req.params.studentId)
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'id invalide' })
  try {
    const { rows } = await pool.query(
      `SELECT ce.id, ce.enrolled_at,
              c.id AS class_id, c.nom AS class_name,
              sy.id AS year_id, sy.label AS year_label
       FROM class_enrollments ce
       JOIN classes      c  ON c.id  = ce.class_id
       JOIN school_years sy ON sy.id = ce.school_year_id
       WHERE ce.student_id = $1
       ORDER BY sy.start_date DESC, c.nom ASC`,
      [id],
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /api/admin/enrollments/student/:id :', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

// POST /api/admin/enrollments
// Inscrit un élève dans une classe pour une année
router.post('/', async (req, res) => {
  const { student_id, class_id, school_year_id } = req.body || {}
  if (!student_id || !class_id || !school_year_id) {
    return res.status(400).json({ message: 'student_id, class_id et school_year_id requis' })
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO class_enrollments (student_id, class_id, school_year_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (student_id, class_id, school_year_id) DO NOTHING
       RETURNING id, student_id, class_id, school_year_id, enrolled_at`,
      [student_id, class_id, school_year_id],
    )
    if (!rows.length) {
      return res.status(409).json({ message: 'Inscription déjà existante' })
    }
    res.status(201).json(rows[0])
  } catch (e) {
    console.error('POST /api/admin/enrollments :', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

// DELETE /api/admin/enrollments/:id
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'id invalide' })
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM class_enrollments WHERE id = $1',
      [id],
    )
    if (rowCount === 0) return res.status(404).json({ message: 'Inscription introuvable' })
    res.status(204).end()
  } catch (e) {
    console.error('DELETE /api/admin/enrollments/:id :', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

module.exports = router