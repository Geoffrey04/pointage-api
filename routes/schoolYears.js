const express = require('express')
const router = express.Router()
const pool = require('../db')

// ─── Vacances scolaires Zone B + jours fériés ────────────────
// Source : education.gouv.fr — à vérifier chaque année
const VACANCES_ZONE_B = {
  '2025-2026': [
    { start: '2025-10-18', end: '2025-11-02', label: 'Toussaint' },
    { start: '2025-12-20', end: '2026-01-04', label: 'Noël' },
    { start: '2026-02-14', end: '2026-03-01', label: 'Hiver' },
    { start: '2026-04-11', end: '2026-04-26', label: 'Printemps' },
  ],
  '2026-2027': [
    { start: '2026-10-17', end: '2026-11-01', label: 'Toussaint' },
    { start: '2026-12-19', end: '2027-01-03', label: 'Noël' },
    { start: '2027-02-13', end: '2027-02-28', label: 'Hiver' },
    { start: '2027-04-17', end: '2027-05-02', label: 'Printemps' },
  ],
}

const JOURS_FERIES = {
  '2025-2026': [
    '2025-11-11', // Armistice
    '2026-04-06', // Lundi de Pâques
    '2026-05-01', // Fête du Travail
    '2026-05-08', // Victoire 1945
    '2026-05-14', // Ascension
    '2026-05-25', // Lundi de Pentecôte
  ],
  '2026-2027': [
    '2026-11-01', // Toussaint
    '2026-11-11', // Armistice
    '2027-03-29', // Lundi de Pâques
    '2027-05-01', // Fête du Travail
    '2027-05-06', // Ascension
    '2027-05-08', // Victoire 1945
    '2027-05-17', // Lundi de Pentecôte
  ],
}

// ─── Utilitaires dates (UTC strict, même logique que server.js) ─
function utcNoon(y, m0, d) {
  return new Date(Date.UTC(y, m0, d, 12))
}

function parseYMD(s) {
  const [y, m, d] = s.split('-').map(Number)
  return utcNoon(y, m - 1, d)
}

function ymdUTC(d) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ISO weekday: 1=Lun … 6=Sam, 7=Dim → JS: 0=Dim … 6=Sam
function jsDowFromIso(iso) { return iso % 7 }

function firstOnOrAfter(startUtc, jsTarget) {
  const d = new Date(startUtc.getTime())
  const delta = (jsTarget - d.getUTCDay() + 7) % 7
  d.setUTCDate(d.getUTCDate() + delta)
  return d
}

function enumerateDates(start, end, isoDow) {
  const jsTarget = jsDowFromIso(isoDow)
  let d = firstOnOrAfter(start, jsTarget)
  const out = []
  while (d <= end) {
    out.push(ymdUTC(d))
    d = new Date(d.getTime() + 7 * 86400000)
  }
  return out
}

// ─── Statut d'une séance selon le calendrier ─────────────────
function getStatus(dateStr, yearLabel) {
  if ((JOURS_FERIES[yearLabel] || []).includes(dateStr)) return 'holiday'
  for (const vac of (VACANCES_ZONE_B[yearLabel] || [])) {
    if (dateStr >= vac.start && dateStr <= vac.end) return 'vacation'
  }
  return null
}

// ─── Génération des séances pour toutes les classes ──────────
async function generateSessions(schoolYearId, yearLabel, startDate, endDate) {
  const start = parseYMD(startDate)
  const end = parseYMD(endDate)

  const { rows: classes } = await pool.query(
    'SELECT id, weekday FROM classes WHERE weekday IS NOT NULL',
  )

  let total = 0

  for (const cls of classes) {
    const dates = enumerateDates(start, end, cls.weekday)

    const normal = [], vacation = [], holiday = []
    for (const d of dates) {
      const s = getStatus(d, yearLabel)
      if (s === 'vacation') vacation.push(d)
      else if (s === 'holiday') holiday.push(d)
      else normal.push(d)
    }

    if (normal.length) {
      await pool.query(
        `INSERT INTO sessions (class_id, date, school_year_id)
         SELECT $1, unnest($2::date[]), $3
         ON CONFLICT (class_id, date) DO NOTHING`,
        [cls.id, normal, schoolYearId],
      )
    }
    if (vacation.length) {
      await pool.query(
        `INSERT INTO sessions (class_id, date, status, school_year_id)
         SELECT $1, unnest($2::date[]), 'vacation', $3
         ON CONFLICT (class_id, date) DO NOTHING`,
        [cls.id, vacation, schoolYearId],
      )
    }
    if (holiday.length) {
      await pool.query(
        `INSERT INTO sessions (class_id, date, status, school_year_id)
         SELECT $1, unnest($2::date[]), 'holiday', $3
         ON CONFLICT (class_id, date) DO NOTHING`,
        [cls.id, holiday, schoolYearId],
      )
    }
    total += dates.length
  }

  return total
}

// ─── Routes ──────────────────────────────────────────────────

// GET /api/admin/school-years
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, label,
              to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(end_date,   'YYYY-MM-DD') AS end_date,
              is_current
       FROM school_years
       ORDER BY start_date DESC`,
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /api/admin/school-years :', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

// POST /api/admin/school-years — crée une année et génère ses séances
router.post('/', async (req, res) => {
  const { label, start_date, end_date } = req.body || {}
  if (!label || !start_date || !end_date) {
    return res.status(400).json({ message: 'label, start_date et end_date requis' })
  }
  if (!/^\d{4}-\d{4}$/.test(label)) {
    return res.status(400).json({ message: 'label doit être au format AAAA-AAAA (ex: 2026-2027)' })
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO school_years (label, start_date, end_date)
       VALUES ($1, $2, $3)
       RETURNING id, label,
                 to_char(start_date, 'YYYY-MM-DD') AS start_date,
                 to_char(end_date,   'YYYY-MM-DD') AS end_date,
                 is_current`,
      [label, start_date, end_date],
    )
    const year = rows[0]

    const sessionsCount = await generateSessions(year.id, label, start_date, end_date)

    res.status(201).json({ ...year, sessions_generated: sessionsCount })
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ message: `L'année "${label}" existe déjà` })
    }
    console.error('POST /api/admin/school-years :', e)
    res.status(500).json({ message: 'Erreur lors de la création' })
  }
})

// POST /api/admin/school-years/:id/regenerate — supprime et recrée toutes les séances
router.post('/:id/regenerate', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'id invalide' })

  try {
    const { rows } = await pool.query(
      `SELECT id, label,
              to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(end_date,   'YYYY-MM-DD') AS end_date
       FROM school_years WHERE id = $1`,
      [id],
    )
    if (!rows.length) return res.status(404).json({ message: 'Année introuvable' })
    const year = rows[0]

    await pool.query('DELETE FROM sessions WHERE school_year_id = $1', [id])
    const count = await generateSessions(id, year.label, year.start_date, year.end_date)

    res.json({ message: `${count} séances régénérées pour ${year.label}`, sessions_generated: count })
  } catch (e) {
    console.error('POST /api/admin/school-years/:id/regenerate :', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

// PATCH /api/admin/school-years/:id/current — définit l'année courante
router.patch('/:id/current', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'id invalide' })

  try {
    await pool.query('UPDATE school_years SET is_current = false WHERE is_current = true')
    const { rows } = await pool.query(
      `UPDATE school_years SET is_current = true WHERE id = $1
       RETURNING id, label,
                 to_char(start_date, 'YYYY-MM-DD') AS start_date,
                 to_char(end_date,   'YYYY-MM-DD') AS end_date,
                 is_current`,
      [id],
    )
    if (!rows.length) return res.status(404).json({ message: 'Année introuvable' })
    res.json(rows[0])
  } catch (e) {
    console.error('PATCH /api/admin/school-years/:id/current :', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

module.exports = router