  const express = require('express')
  const router = express.Router()
  const pool = require('../db')

  // GET /api/admin/enrollments?class_id=X&school_year_id=Y
  router.get('/', async (req, res) => {
    try {
      const { class_id, school_year_id } = req.query
      const conditions = []
      const params = []
      if (class_id) conditions.push(`ce.class_id = $${params.push(Number(class_id))}`)
      if (school_year_id) conditions.push(`ce.school_year_id = $${params.push(Number(school_year_id))}`)
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

      const { rows } = await pool.query(`
        SELECT ce.id, ce.student_id, ce.class_id, ce.school_year_id,
              s.firstname, s.lastname, s.phone, s.weekday,
              c.nom AS class_name, sy.label AS year_label
        FROM class_enrollments ce
        JOIN students s ON s.id = ce.student_id
        JOIN classes c ON c.id = ce.class_id
        JOIN school_years sy ON sy.id = ce.school_year_id
        ${where}
        ORDER BY s.lastname ASC, s.firstname ASC
      `, params)
      res.json(rows)
    } catch (e) {
      console.error('GET /api/admin/enrollments :', e)
      res.status(500).json({ message: 'Erreur serveur' })
    }
  })

  // POST /api/admin/enrollments — ajoute manuellement un élève à une classe pour une année
  router.post('/', async (req, res) => {
    try {
      const { student_id, class_id, school_year_id } = req.body
      if (!student_id || !class_id || !school_year_id) {
        return res.status(400).json({ message: 'student_id, class_id et school_year_id requis' })
      }
      const { rows } = await pool.query(`
        INSERT INTO class_enrollments (student_id, class_id, school_year_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (student_id, class_id, school_year_id) DO NOTHING
        RETURNING *
      `, [Number(student_id), Number(class_id), Number(school_year_id)])
      res.status(201).json(rows[0] ?? { already_exists: true })
    } catch (e) {
      console.error('POST /api/admin/enrollments :', e)
      res.status(500).json({ message: 'Erreur serveur' })
    }
  })

  // DELETE /api/admin/enrollments/:id
  router.delete('/:id', async (req, res) => {
    try {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return res.status(400).json({ message: 'id invalide' })
      const { rowCount } = await pool.query('DELETE FROM class_enrollments WHERE id = $1', [id])
      if (rowCount === 0) return res.status(404).json({ message: 'Inscription introuvable' })
      res.status(204).end()
    } catch (e) {
      console.error('DELETE /api/admin/enrollments/:id :', e)
      res.status(500).json({ message: 'Erreur serveur' })
    }
  })

  module.exports = router