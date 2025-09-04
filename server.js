// server.js
// ─────────────────────────────────────────────────────────────
// Bootstrap & dépendances
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const pg = require('pg');
const pool = require('./db');      // ✅ on importe le *pool* prêt à l’emploi

// Forcer le type DATE (OID 1082) à 'YYYY-MM-DD'
pg.types.setTypeParser(1082, (v) => v);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));  // ✅ pas besoin de body-parser

// Whitelist depuis la variable d'env CORS_ORIGINS
// accepte CORS_ORIGINS (pluriel) ou CORS_ORIGIN (singulier)
const rawAllowed = String(process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || '');

const ALLOWED = new Set(
  rawAllowed
    .split(',')
    .map(s => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
);


app.use((req, res, next) => { res.setHeader('Vary', 'Origin'); next(); });

app.use((req, res, next) => {
  const origin = (req.headers.origin || '').replace(/\/$/, '');
  const allowed = !origin || ALLOWED.size === 0 || ALLOWED.has(origin);

  if (allowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
// ---------------------------------------------------------------

// Log propre si le pool rencontre un souci
pool.on('error', (err) => console.error('[pg] Pool error:', err));


// Arrêt propre (containers / PM2 / systemd)
function shutdown(signal) {
  return async () => {
    console.log(`\n${signal} reçu → fermeture des connexions…`)
    try {
      await pool.end()
      console.log('Pool PostgreSQL fermé. Bye!')
      process.exit(0)
    } catch (e) {
      console.error('Erreur à la fermeture du pool:', e)
      process.exit(1)
    }
  }
}
process.on('SIGINT', shutdown('SIGINT'))
process.on('SIGTERM', shutdown('SIGTERM'))

// Sanity checks env
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET manquant. Définis-le en production.')
}

// ─────────────────────────────────────────────────────────────
// Middlewares AuthN/AuthZ
// ─────────────────────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]
  if (!token) return res.sendStatus(401)
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403)
    req.user = user
    next()
  })
}
function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.sendStatus(403)
    next()
  }
}

// ────────────────────────────────────────────────────────────f─
// Healthcheck (optionnel) & démarrage
// ─────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    const r = await pool.query('SELECT 1::int AS ok');
    return res.json({ ok: true, db: String(r.rows?.[0]?.ok) === '1', v: 'h4' });
  } catch (e) {
    // log côté serveur (visible dans cPanel > Setup Node.js App > Error Log)
    console.error('HEALTH ERROR:', e);
    // renvoie un message utile même si e.message est vide
    const msg = (e && (e.message || e.code || e.name)) || String(e || '');
    return res.status(500).json({ ok: false, error: msg, v: 'h4' });
  }
});


// ─────────────────────────────────────────────────────────────
// Utils Date / Génération de séances (UTC safe)
// ─────────────────────────────────────────────────────────────
function utcNoon(y, m0, d) {
  return new Date(Date.UTC(y, m0, d, 12))
}
function schoolStartYear(now = new Date()) {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1
  return m >= 9 ? y : y - 1
}
function getActiveSchoolYear(now = new Date()) {
  const sy = schoolStartYear(now)
  return { start: utcNoon(sy, 8, 1), end: utcNoon(sy + 1, 6, 14) } // 01/09 -> 14/07
}
const ISO_FROM_FR = {
  dimanche: 7,
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
}
function normalizeToIsoWeekday(input) {
  if (typeof input === 'string') return ISO_FROM_FR[input.toLowerCase()] ?? null
  if (typeof input === 'number') {
    if (input >= 1 && input <= 7) return input
    if (input >= 0 && input <= 6) return input + 1
  }
  return null
}
function jsDowFromIso(iso) {
  return iso % 7 // ISO 7=dim → JS 0
}
function firstOnOrAfter(startUtc, jsTarget) {
  const d = new Date(startUtc.getTime())
  const delta = (jsTarget - d.getUTCDay() + 7) % 7
  d.setUTCDate(d.getUTCDate() + delta)
  return d
}
function ymdUTC(d) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function enumerateDatesByWeekday(startUtc, endUtc, isoDow) {
  const jsTarget = jsDowFromIso(isoDow)
  const s = utcNoon(startUtc.getUTCFullYear(), startUtc.getUTCMonth(), startUtc.getUTCDate())
  const e = utcNoon(endUtc.getUTCFullYear(), endUtc.getUTCMonth(), endUtc.getUTCDate())
  let d = firstOnOrAfter(s, jsTarget)
  const out = []
  while (d <= e) {
    out.push(ymdUTC(d))
    d = new Date(d.getTime() + 7 * 86400000)
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// Garde-fous d’accès aux classes/sessions (owner ou co-prof)
// ─────────────────────────────────────────────────────────────
async function ensureClassAccess(req, res, next) {
  try {
    if (req.user?.role === 'admin') return next()

    const classId = Number(
      req.params.classId ?? req.params.id ?? req.body.class_id ?? req.query.class_id,
    )
    if (!Number.isInteger(classId)) {
      return res.status(400).json({ message: 'classId invalide' })
    }

    const { rows } = await pool.query(
      `
      SELECT 1
      FROM classes c
      LEFT JOIN class_users cu ON cu.class_id = c.id AND cu.user_id = $2
      WHERE c.id = $1 AND (c.user_id = $2 OR cu.user_id IS NOT NULL)
      LIMIT 1
      `,
      [classId, req.user.id],
    )
    if (!rows.length) return res.status(403).json({ message: 'Accès refusé à cette classe' })
    next()
  } catch (e) {
    console.error('ensureClassAccess', e)
    res.status(500).json({ message: 'Erreur serveur (access classe)' })
  }
}
async function ensureSessionAccess(req, res, next) {
  try {
    if (req.user?.role === 'admin') return next()

    const sessionId = Number(req.params.id ?? req.body.session_id ?? req.query.session_id)
    if (!Number.isInteger(sessionId)) return res.status(400).json({ message: 'sessionId invalide' })

    const { rows } = await pool.query('SELECT class_id FROM sessions WHERE id = $1', [sessionId])
    if (!rows.length) return res.status(404).json({ message: 'Séance introuvable' })

    req.params.classId = rows[0].class_id
    req.params.id = rows[0].class_id
    return ensureClassAccess(req, res, next)
  } catch (e) {
    console.error('ensureSessionAccess', e)
    res.status(500).json({ message: 'Erreur serveur (access session)' })
  }
}
async function ensureSessionsForWeekday(classId, isoWeekday, startYear = schoolStartYear()) {
  const start = utcNoon(startYear, 8, 1)
  const end = utcNoon(startYear + 1, 6, 14)
  const dates = enumerateDatesByWeekday(start, end, isoWeekday)
  await pool.query(
    `
    INSERT INTO sessions (class_id, date)
    SELECT $1, unnest($2::date[])
    ON CONFLICT (class_id, date) DO NOTHING
    `,
    [classId, dates],
  )
}

// ─────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password)
      return res.status(400).json({ message: 'Username et mot de passe requis' })

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim()])
    if (result.rows.length === 0) return res.status(401).json({ message: 'Utilisateur non trouvé' })

    const user = result.rows[0]
    const validPassword = await bcrypt.compare(password, user.password)
    if (!validPassword) return res.status(401).json({ message: 'Mot de passe incorrect' })

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' },
    )
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } })
  } catch (err) {
    console.error('Erreur serveur login:', err)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

// ─────────────────────────────────────────────────────────────
// ADMIN API
// ─────────────────────────────────────────────────────────────
const admin = express.Router()
admin.use(authenticateToken, authorizeRoles('admin'))

admin.get('/profs', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, username FROM users WHERE role = 'prof' ORDER BY username ASC",
    )
    res.json(rows)
  } catch (e) {
    console.error('admin/profs', e)
    res.status(500).json({ message: 'Erreur chargement profs' })
  }
})

admin.get('/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users)    AS users,
        (SELECT COUNT(*) FROM students) AS students,
        (SELECT COUNT(*) FROM classes)  AS classes,
        (SELECT COUNT(*) FROM sessions) AS sessions
    `)
    res.json(rows[0])
  } catch (e) {
    console.error('admin/stats', e)
    res.status(500).json({ message: 'Erreur stats' })
  }
})

admin.get('/attendance-rate', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.nom AS name,
             COUNT(a.*) AS marked,
             SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS presents,
             ROUND(
               CASE WHEN COUNT(a.*)=0 THEN 0
                    ELSE 100.0*SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END)/COUNT(a.*)
               END, 1
             ) AS rate
      FROM classes c
      LEFT JOIN sessions s ON s.class_id = c.id
      LEFT JOIN attendances a ON a.session_id = s.id
      GROUP BY c.id, c.nom
      ORDER BY c.nom ASC;
    `)
    res.json(rows)
  } catch (e) {
    console.error('admin/attendance-rate', e)
    res.status(500).json({ message: 'Erreur stats présence' })
  }
})

admin.get('/classes', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, nom AS name, description, user_id AS owner_id FROM classes ORDER BY nom ASC',
    )
    res.json(rows)
  } catch (e) {
    console.error('admin/classes', e)
    res.status(500).json({ message: 'Erreur chargement classes' })
  }
})

// Liste owner + co-profs (par id de classe)
admin.get('/classes/:id/managers', async (req, res) => {
  try {
    const classId = Number(req.params.id)
    if (!Number.isInteger(classId)) return res.status(400).json({ message: 'classId invalide' })

    const { rows } = await pool.query(
      `
      SELECT u.id, u.username, u.role, TRUE AS is_owner
      FROM users u
      JOIN classes c ON c.user_id = u.id
      WHERE c.id = $1

      UNION

      SELECT u.id, u.username, u.role, FALSE AS is_owner
      FROM users u
      JOIN class_users cu ON cu.user_id = u.id
      WHERE cu.class_id = $1

      ORDER BY is_owner DESC, username ASC
      `,
      [classId],
    )
    res.json(rows)
  } catch (e) {
    console.error('admin GET /classes/:id/managers', e)
    res.status(500).json({ message: 'Erreur chargement gestionnaires' })
  }
})

async function upsertOwnerLink(classId, ownerId) {
  if (!ownerId) return
  await pool.query(
    `INSERT INTO class_users (class_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [classId, ownerId],
  )
}

admin.post('/classes', async (req, res) => {
  try {
    const { name, description, owner_id } = req.body
    if (!name || !name.trim()) return res.status(400).json({ message: 'Nom requis' })

    const { rows } = await pool.query(
      `INSERT INTO classes (nom, description, user_id)
       VALUES ($1, $2, $3)
       RETURNING id, nom AS name, description, user_id AS owner_id`,
      [name.trim(), description ?? null, owner_id ?? null],
    )
    await upsertOwnerLink(rows[0].id, owner_id)
    res.json(rows[0])
  } catch (e) {
    console.error('admin POST /classes', e)
    res.status(500).json({ message: 'Erreur création' })
  }
})

admin.patch('/classes/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { name, description, owner_id } = req.body
    const { rows } = await pool.query(
      `UPDATE classes
         SET nom = COALESCE($1, nom),
             description = COALESCE($2, description),
             user_id = $3
       WHERE id = $4
       RETURNING id, nom AS name, description, user_id AS owner_id`,
      [name ?? null, description ?? null, owner_id ?? null, id],
    )
    if (!rows[0]) return res.status(404).json({ message: 'Classe introuvable' })
    await upsertOwnerLink(id, owner_id)
    res.json(rows[0])
  } catch (e) {
    console.error('admin PATCH /classes/:id', e)
    res.status(500).json({ message: 'Erreur mise à jour' })
  }
})

admin.delete('/classes/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { rowCount } = await pool.query('DELETE FROM classes WHERE id = $1', [id])
    if (rowCount === 0) return res.status(404).json({ message: 'Classe introuvable' })
    res.json({ ok: true })
  } catch (e) {
    console.error('admin DELETE /classes/:id', e)
    res.status(500).json({ message: 'Erreur suppression' })
  }
})

admin.post('/class-users', async (req, res) => {
  try {
    const { class_id, user_id } = req.body
    if (!class_id || !user_id) return res.status(400).json({ message: 'Paramètres manquants' })
    await pool.query(
      `INSERT INTO class_users (class_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [class_id, user_id],
    )
    res.json({ ok: true })
  } catch (e) {
    console.error('admin POST /class-users', e)
    res.status(500).json({ message: 'Erreur liaison' })
  }
})

admin.get('/class-users', async (req, res) => {
  try {
    const class_id = Number(req.query.class_id)
    if (!Number.isInteger(class_id)) return res.status(400).json({ message: 'class_id invalide' })

    const sql = `
      (
        SELECT u.id, u.username, u.role, FALSE AS is_owner
        FROM class_users cu
        JOIN users u ON u.id = cu.user_id
        WHERE cu.class_id = $1
      )
      UNION
      (
        SELECT u.id, u.username, u.role, TRUE AS is_owner
        FROM classes c
        JOIN users   u ON u.id = c.user_id
        WHERE c.id = $1 AND c.user_id IS NOT NULL
      )
      ORDER BY is_owner DESC, username ASC
    `
    const { rows } = await pool.query(sql, [class_id])
    res.json(Array.isArray(rows) ? rows : [])
  } catch (e) {
    console.error('admin GET /class-users', e)
    res.status(500).json({ message: 'Erreur chargement gestionnaires' })
  }
})

admin.delete('/class-users', async (req, res) => {
  try {
    const { class_id, user_id } = req.body
    await pool.query('DELETE FROM class_users WHERE class_id = $1 AND user_id = $2', [
      class_id,
      user_id,
    ])
    res.json({ ok: true })
  } catch (e) {
    console.error('admin DELETE /class-users', e)
    res.status(500).json({ message: 'Erreur délier' })
  }
})

app.use('/api/admin', admin)

// ─────────────────────────────────────────────────────────────
// CLASSES (legacy + /api/classes unifié)
// ─────────────────────────────────────────────────────────────
app.get('/classes', authenticateToken, authorizeRoles('admin'), async (_req, res) => {
  try {
    const result = await pool.query('SELECT id, nom AS name FROM classes ORDER BY nom ASC')
    res.json(result.rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

app.get('/my-classes', authenticateToken, authorizeRoles('prof', 'admin'), async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const { rows } = await pool.query(
        'SELECT id, nom AS name, description, user_id AS owner_id FROM classes ORDER BY nom ASC',
      )
      return res.json(rows)
    }
    const { rows } = await pool.query(
      `
      SELECT DISTINCT c.id, c.nom AS name, c.description, c.user_id AS owner_id
      FROM classes c
      LEFT JOIN class_users cu ON cu.class_id = c.id
      WHERE c.user_id = $1 OR cu.user_id = $1
      ORDER BY c.nom ASC
      `,
      [req.user.id],
    )
    res.json(rows)
  } catch (err) {
    console.error('Erreur route /my-classes :', err)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

const classesRouter = express.Router()

classesRouter.get('/', authenticateToken, async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const result = await pool.query('SELECT id, nom AS name FROM classes ORDER BY nom ASC')
      return res.json(result.rows)
    }
    if (req.user.role === 'prof') {
      const result = await pool.query(
        `
        SELECT DISTINCT c.id, c.nom AS name
        FROM classes c
        LEFT JOIN class_users cu ON cu.class_id = c.id
        WHERE c.user_id = $1 OR cu.user_id = $1
        ORDER BY c.nom ASC
        `,
        [req.user.id],
      )
      return res.json(result.rows)
    }
    return res.status(403).json({ message: 'Accès interdit' })
  } catch (err) {
    console.error('Erreur route /api/classes :', err)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

// GET /api/classes/:id → { id, name, weekday }
classesRouter.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params
    const { rows } = await pool.query(
      'SELECT id, nom AS name, weekday FROM classes WHERE id = $1',
      [id],
    )
    if (!rows.length) return res.status(404).json({ message: 'Classe introuvable' })
    res.json(rows[0])
  } catch (e) {
    console.error('GET /api/classes/:id', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})
app.use('/api/classes', classesRouter)

// PATCH /classes/:id/weekday (ne supprime plus les autres dates)
const patchClassWeekdayHandler = async (req, res) => {
  try {
    const classId = Number(req.params.id)
    const iso = normalizeToIsoWeekday(req.body.weekday)
    if (!iso) return res.status(400).json({ message: 'weekday invalide' })

    await pool.query('UPDATE classes SET weekday=$1 WHERE id=$2', [iso, classId])

    const sy = Number.isInteger(req.body.startYear) ? req.body.startYear : schoolStartYear()
    const start = utcNoon(sy, 8, 1)
    const end = utcNoon(sy + 1, 6, 14)

    const dates = enumerateDatesByWeekday(start, end, iso)
    await pool.query(
      `
      INSERT INTO sessions (class_id, date)
      SELECT $1, unnest($2::date[])
      ON CONFLICT (class_id, date) DO NOTHING
      `,
      [classId, dates],
    )

    const { rows } = await pool.query(
      "SELECT id, to_char(date,'YYYY-MM-DD') AS date, status, note \
       FROM sessions WHERE class_id=$1 ORDER BY date",
      [classId],
    )
    res.json(rows)
  } catch (e) {
    console.error('PATCH weekday', e)
    res.status(500).json({ message: 'Erreur mise à jour du jour de classe' })
  }
}
app.patch(
  ['/api/classes/:id/weekday', '/classes/:id/weekday'],
  authenticateToken,
  authorizeRoles('prof', 'admin'),
  ensureClassAccess,
  patchClassWeekdayHandler,
)

// Génération (legacy)
app.post(
  '/classes/:id/generate-sessions',
  authenticateToken,
  authorizeRoles('prof', 'admin'),
  ensureClassAccess,
  async (req, res) => {
    try {
      const classId = Number(req.params.id)
      if (!Number.isInteger(classId)) return res.status(400).json({ message: 'classId invalide' })

      const cl = await pool.query('SELECT id, weekday FROM classes WHERE id = $1', [classId])
      if (!cl.rows[0]) return res.status(404).json({ message: 'Classe introuvable' })

      let isoWeekday = normalizeToIsoWeekday(req.body?.weekday)
      if (isoWeekday == null) isoWeekday = normalizeToIsoWeekday(cl.rows[0].weekday)
      if (isoWeekday == null)
        return res.status(400).json({ message: 'Jour de cours requis (weekday)' })

      if (cl.rows[0].weekday !== isoWeekday) {
        await pool.query('UPDATE classes SET weekday = $1 WHERE id = $2', [isoWeekday, classId])
      }

      const { start, end } = getActiveSchoolYear()
      const allDates = enumerateDatesByWeekday(start, end, isoWeekday)

      await pool.query(
        `
        INSERT INTO sessions (class_id, date)
        SELECT $1, unnest($2::date[])
        ON CONFLICT (class_id, date) DO NOTHING
        `,
        [classId, allDates],
      )

      const { rows } = await pool.query(
        "SELECT id, to_char(date,'YYYY-MM-DD') AS date, status, note \
         FROM sessions WHERE class_id=$1 ORDER BY date",
        [classId],
      )
      res.json(rows)
    } catch (e) {
      console.error('generate-sessions', e)
      res.status(500).json({ message: 'Erreur génération sessions' })
    }
  },
)

// ─────────────────────────────────────────────────────────────
// STUDENTS
// ─────────────────────────────────────────────────────────────
const studentsRouter = express.Router()

// POST /api/students
studentsRouter.post('/', async (req, res) => {
  try {
    const { firstname, lastname, class_id, phone, weekday } = req.body
    let iso = normalizeToIsoWeekday(weekday) // optionnel

    const insertSql = `
      INSERT INTO students (firstname, lastname, class_id, phone, weekday)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `
    const { rows } = await pool.query(insertSql, [
      firstname,
      lastname,
      class_id,
      phone ?? null,
      iso ?? null,
    ])

    if (iso) await ensureSessionsForWeekday(Number(class_id), iso)
    res.json(rows[0])
  } catch (err) {
    console.error('POST /api/students', err)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

// GET /api/students/:class_id
studentsRouter.get('/:class_id', async (req, res) => {
  try {
    const { class_id } = req.params
    const result = await pool.query(
      'SELECT * FROM students WHERE class_id = $1 ORDER BY lastname ASC',
      [class_id],
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET /api/students/:class_id', err)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})
app.use('/api/students', studentsRouter)

// DELETE /api/students/:id
app.delete('/api/students/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id invalide' })
  try {
    const q = 'DELETE FROM students WHERE id=$1'
    const { rowCount } = await pool.query(q, [id])
    if (rowCount === 0) return res.status(404).json({ error: 'élève introuvable' })
    return res.status(204).end()
  } catch (err) {
    console.error('delete student', err)
    return res.status(500).json({ error: 'server_error' })
  }
})

// PATCH /api/students/:id (weekday élève)
studentsRouter.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    let iso = normalizeToIsoWeekday(req.body.weekday)

    const { rows } = await pool.query(
      `UPDATE students
         SET weekday = $1
       WHERE id = $2
       RETURNING id, firstname, lastname, class_id, phone, weekday`,
      [iso ?? null, id],
    )
    if (!rows.length) return res.status(404).json({ message: 'Élève introuvable' })
    if (iso) await ensureSessionsForWeekday(Number(rows[0].class_id), iso)
    res.json(rows[0])
  } catch (e) {
    console.error('PATCH /api/students/:id', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

// ─────────────────────────────────────────────────────────────
// SESSIONS (dates de cours)
// ─────────────────────────────────────────────────────────────
const sessionsRouter = express.Router()

// GET /sessions/:classId
sessionsRouter.get(
  '/:classId',
  authenticateToken,
  authorizeRoles('prof', 'admin'),
  ensureClassAccess,
  async (req, res) => {
    try {
      const { classId } = req.params
      const { rows } = await pool.query(
        "SELECT id, to_char(date,'YYYY-MM-DD') AS date, status, note \
         FROM sessions WHERE class_id=$1 ORDER BY date",
        [classId],
      )
      res.json(rows)
    } catch (err) {
      console.error('GET /sessions/:classId', err)
      res.status(500).json({ error: 'Erreur serveur' })
    }
  },
)

// POST /sessions
sessionsRouter.post(
  '/',
  authenticateToken,
  authorizeRoles('prof', 'admin'),
  ensureClassAccess,
  async (req, res) => {
    try {
      const { class_id, dates } = req.body
      if (!class_id || !Array.isArray(dates) || dates.length === 0) {
        return res.status(400).json({ error: 'Classe ou dates manquantes' })
      }

      const existingResult = await pool.query(
        "SELECT to_char(date, 'YYYY-MM-DD') AS date FROM sessions WHERE class_id = $1",
        [class_id],
      )
      const existingDates = existingResult.rows.map((row) => row.date)
      const newDates = dates.filter((d) => !existingDates.includes(d))

      if (newDates.length > 0) {
        await pool.query(
          `
          INSERT INTO sessions (class_id, date)
          SELECT $1, unnest($2::date[])
          ON CONFLICT (class_id, date) DO NOTHING
          `,
          [class_id, newDates],
        )
      }

      const allDates = [...existingDates, ...newDates].sort()
      res.json(allDates)
    } catch (err) {
      console.error('POST /sessions', err)
      res.status(500).json({ error: 'Erreur serveur' })
    }
  },
)
app.use('/sessions', sessionsRouter)

// ─────────────────────────────────────────────────────────────
// ATTENDANCE (présences)
// ─────────────────────────────────────────────────────────────

// GET /attendance/:classId  (protégé + contrôle d’accès)
app.get(
  '/attendance/:classId',
  authenticateToken,
  authorizeRoles('prof', 'admin'),
  ensureClassAccess,
  async (req, res) => {
    try {
      const { classId } = req.params
      const { rows } = await pool.query(
        `SELECT a.student_id, a.session_id, a.status, a.comment
         FROM attendances a
         JOIN sessions s ON s.id = a.session_id
         WHERE s.class_id = $1`,
        [classId],
      )
      res.json(rows)
    } catch (err) {
      console.error('GET /attendance/:classId', err)
      res.status(500).json({ message: 'Erreur serveur' })
    }
  },
)

// POST /attendance (upsert)
app.post(
  '/attendance',
  authenticateToken,
  authorizeRoles('prof', 'admin'),
  ensureSessionAccess,
  async (req, res) => {
    try {
      let { student_id, session_id, status, comment } = req.body
      student_id = Number(student_id)
      session_id = Number(session_id)
      if (!student_id || !session_id || !status) {
        return res.status(400).json({ message: 'Paramètres manquants' })
      }

      const allowed = new Set(['present', 'absent', 'excused'])
      if (!allowed.has(status)) return res.status(400).json({ message: 'Statut invalide' })

      if (status === 'excused') {
        if (!comment || !String(comment).trim()) {
          return res.status(400).json({ message: 'Commentaire requis pour "excusé(e)"' })
        }
        comment = String(comment).trim()
      } else {
        comment = null
      }

      const fk = await pool.query(
        `SELECT
           (SELECT 1 FROM students WHERE id = $1) AS has_student,
           (SELECT 1 FROM sessions  WHERE id = $2) AS has_session`,
        [student_id, session_id],
      )
      if (!fk.rows[0].has_student) return res.status(400).json({ message: 'Élève introuvable' })
      if (!fk.rows[0].has_session) return res.status(400).json({ message: 'Session introuvable' })

      const { rows: sRows } = await pool.query('SELECT status FROM sessions WHERE id=$1', [
        session_id,
      ])
      if (!sRows.length) return res.status(404).json({ message: 'Séance introuvable' })

      const nonPointables = new Set(['cancelled', 'holiday', 'vacation'])
      if (nonPointables.has(sRows[0].status)) {
        return res.status(409).json({
          message: "Pointage interdit : cette séance n'est pas tenable (annulée/férié/vacances).",
        })
      }

      await pool.query(
        `INSERT INTO attendances (student_id, session_id, status, comment)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (student_id, session_id)
         DO UPDATE SET status = EXCLUDED.status, comment = EXCLUDED.comment`,
        [student_id, session_id, status, comment],
      )
      res.json({ message: 'Présence enregistrée' })
    } catch (err) {
      if (err.code === '23514') {
        return res.status(400).json({ message: 'Commentaire requis pour "excusé(e)"' })
      }
      console.error('POST /attendance error:', err)
      res.status(500).json({ message: 'Erreur serveur' })
    }
  },
)

// PATCH /sessions/:id/status
app.patch(
  '/sessions/:id/status',
  authenticateToken,
  authorizeRoles('prof', 'admin'),
  ensureSessionAccess,
  async (req, res) => {
    try {
      const id = Number(req.params.id)
      const { status, note } = req.body ?? {}
      const force = String(req.query.force || 'false') === 'true'

      const allowed = new Set(['scheduled', 'cancelled', 'holiday', 'vacation', 'extra'])
      if (!allowed.has(status)) return res.status(400).json({ message: 'Statut invalide' })

      const nonPointables = new Set(['cancelled', 'holiday', 'vacation'])
      if (nonPointables.has(status)) {
        const { rows: cnt } = await pool.query(
          'SELECT COUNT(*)::int AS n FROM attendances WHERE session_id=$1',
          [id],
        )
        if (cnt[0].n > 0 && !force) {
          return res.status(409).json({
            message:
              'Des pointages existent pour cette séance. Confirmez avec ?force=true pour les supprimer.',
            existing: cnt[0].n,
          })
        }
        if (cnt[0].n > 0 && force) {
          await pool.query('DELETE FROM attendances WHERE session_id=$1', [id])
        }
      }

      await pool.query('UPDATE sessions SET status=$1, note=$2 WHERE id=$3', [
        status,
        note ?? null,
        id,
      ])

      const { rows } = await pool.query(
        "SELECT id, to_char(date,'YYYY-MM-DD') AS date, status, note FROM sessions WHERE id=$1",
        [id],
      )
      res.json(rows[0])
    } catch (e) {
      console.error('PATCH /sessions/:id/status', e)
      res.status(500).json({ message: 'Erreur mise à jour statut' })
    }
  },
)

// POST /classes/:classId/sessions/extra
app.post(
  '/classes/:classId/sessions/extra',
  authenticateToken,
  authorizeRoles('prof', 'admin'),
  ensureClassAccess,
  async (req, res) => {
    try {
      const classId = Number(req.params.classId)
      const { date, note } = req.body ?? {}
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
        return res.status(400).json({ message: 'Date invalide (YYYY-MM-DD)' })
      }

      const sql = `
      INSERT INTO sessions (class_id, date, status, note)
      VALUES ($1, $2::date, 'extra', $3)
      ON CONFLICT (class_id, date) DO NOTHING
      RETURNING id, to_char(date,'YYYY-MM-DD') AS date, status, note
      `
      const { rows } = await pool.query(sql, [classId, date, note ?? null])
      if (!rows.length) {
        return res
          .status(409)
          .json({ message: 'Une séance existe déjà à cette date pour cette classe.' })
      }
      res.status(201).json(rows[0])
    } catch (e) {
      console.error('POST extra session', e)
      res.status(500).json({ message: 'Erreur création séance extra' })
    }
  },
)

/** 404 par défaut */
app.use((req, res) => res.status(404).json({ error: 'Not found' }));


app.listen(PORT, () => {
  console.log(`✅ Serveur démarré sur http://localhost:${PORT}`)
})
