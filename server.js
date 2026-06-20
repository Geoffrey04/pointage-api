// ─────────────────────────────────────────────────────────────
// Gestionnaires d'erreurs globaux (à déclarer en tout premier)
// ─────────────────────────────────────────────────────────────
process.on('unhandledRejection', (err) => {
  const msg = String(err && (err.message || err))
  if (/WebAssembly\.instantiate|Wasm memory/.test(msg)) {
    console.warn('[ignored wasm init error]', msg)
    return
  }
  console.error('[unhandledRejection]', err)
})
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e))

console.log('[boot] démarrage — NODE_ENV=%s PORT=%s', process.env.NODE_ENV, process.env.PORT)

require('dotenv').config()

// ─────────────────────────────────────────────────────────────
// Résolution des modules : priorité au node_modules local,
// puis au répertoire nodevenv de l'hébergeur (Passenger).
// ─────────────────────────────────────────────────────────────
const path = require('path')
const Module = require('module')
const EXTRA_NODE_PATH = '/home/c2658980c/nodevenv/apps/pointage-api/20/lib/node_modules'

process.env.NODE_PATH = [
  path.join(__dirname, 'node_modules'),
  process.env.NODE_PATH,
  EXTRA_NODE_PATH,
].filter(Boolean).join(':')

Module._initPaths()

// ─────────────────────────────────────────────────────────────
// Chargement des dépendances critiques
// ─────────────────────────────────────────────────────────────
let pool
try {
  pool = require('./db')
} catch (e) {
  console.error('[boot] échec du chargement de ./db :', e)
}

const express = require('express')
const jwt = require('jsonwebtoken')
const webpush = require('web-push')
const cron = require('node-cron')
const inscriptionRouter = require('./routes/inscription')

let bcrypt
try {
  bcrypt = require('bcryptjs')
} catch (e) {
  try {
    bcrypt = require(`${EXTRA_NODE_PATH}/bcryptjs`)
  } catch (e2) {
    try {
      bcrypt = require(`${EXTRA_NODE_PATH}/bcryptjs/dist/bcrypt.min.js`)
    } catch (e3) {
      console.error('[boot] impossible de charger bcryptjs :', e3?.message)
      throw e3
    }
  }
}

const pg = require('pg')

// Les colonnes de type DATE (OID 1082) sont renvoyées en chaîne 'YYYY-MM-DD'
// plutôt que converties en objet Date JavaScript.
pg.types.setTypeParser(1082, (v) => v)

if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET manquant — à définir en production.')
}

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_MAILTO || 'admin@emm-pointage.fr'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  )
} else {
  console.warn('⚠️  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquants — notifications push désactivées.')
}

// ─────────────────────────────────────────────────────────────
// Configuration Express
// ─────────────────────────────────────────────────────────────
const app = express()
const PORT = process.env.PORT || 3000

app.set('trust proxy', 1)
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: false }))

// ─────────────────────────────────────────────────────────────
// CORS : origines autorisées via la variable d'env CORS_ORIGINS
// ─────────────────────────────────────────────────────────────
const ALLOWED = new Set(
  String(process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
)

// Pré-flight OPTIONS intercepté avant tout autre middleware
app.use((req, res, next) => {
  res.setHeader('Vary', 'Origin')
  if (req.method !== 'OPTIONS') return next()

  const origin = (req.headers.origin || '').replace(/\/$/, '')
  const ok = !origin || ALLOWED.size === 0 || ALLOWED.has(origin)

  if (ok && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With')
  return res.status(204).end()
})

// En-têtes CORS sur les requêtes normales
app.use((req, res, next) => {
  const origin = (req.headers.origin || '').replace(/\/$/, '')
  const ok = !origin || ALLOWED.size === 0 || ALLOWED.has(origin)
  if (ok && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }
  res.setHeader('Vary', 'Origin')
  next()
})

// ─────────────────────────────────────────────────────────────
// Surveillance du pool PostgreSQL + arrêt propre
// ─────────────────────────────────────────────────────────────
if (pool && typeof pool.on === 'function') {
  pool.on('error', (err) => console.error('[pg] Pool error:', err))
} else {
  console.error('[boot] pool PostgreSQL indisponible au démarrage')
}

function shutdown(signal) {
  return async () => {
    console.log(`${signal} reçu — fermeture du pool PostgreSQL…`)
    try {
      if (pool && typeof pool.end === 'function') {
        await pool.end()
        console.log('Pool PostgreSQL fermé.')
      }
      process.exit(0)
    } catch (e) {
      console.error('Erreur à la fermeture du pool :', e)
      process.exit(1)
    }
  }
}

process.on('SIGINT', shutdown('SIGINT'))
process.on('SIGTERM', shutdown('SIGTERM'))

// ─────────────────────────────────────────────────────────────
// Routes utilitaires (santé + diagnostic)
// ─────────────────────────────────────────────────────────────
app.get('/__health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

app.get('/__cors', (req, res) => {
  const origin = (req.headers.origin || '').replace(/\/$/, '')
  res.json({ origin, allowedOrigins: [...ALLOWED], method: req.method, headers: req.headers })
})

app.get('/__db', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        current_database() AS db,
        current_user       AS user,
        inet_server_addr() AS server_addr,
        inet_server_port() AS server_port,
        version()          AS version
    `)
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: 'db_probe_failed', detail: String(e.message || e) })
  }
})

// ─────────────────────────────────────────────────────────────
// Middlewares d'authentification et d'autorisation
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

// Vérifie que l'utilisateur connecté a accès à la classe demandée
// (propriétaire ou co-prof). Les admins passent toujours.
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
      `SELECT 1
       FROM classes c
       LEFT JOIN class_users cu ON cu.class_id = c.id AND cu.user_id = $2
       WHERE c.id = $1 AND (c.user_id = $2 OR cu.user_id IS NOT NULL)
       LIMIT 1`,
      [classId, req.user.id],
    )
    if (!rows.length) return res.status(403).json({ message: 'Accès refusé à cette classe' })
    next()
  } catch (e) {
    console.error('ensureClassAccess', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
}

// Résout la classe d'une séance puis délègue à ensureClassAccess.
async function ensureSessionAccess(req, res, next) {
  try {
    if (req.user?.role === 'admin') return next()

    const sessionId = Number(req.params.id ?? req.body.session_id ?? req.query.session_id)
    if (!Number.isInteger(sessionId)) {
      return res.status(400).json({ message: 'sessionId invalide' })
    }

    const { rows } = await pool.query('SELECT class_id FROM sessions WHERE id = $1', [sessionId])
    if (!rows.length) return res.status(404).json({ message: 'Séance introuvable' })

    // On injecte le classId pour que ensureClassAccess puisse le lire
    // sans écraser req.params.id (qui contient le sessionId).
    req.params.classId = rows[0].class_id
    return ensureClassAccess(req, res, next)
  } catch (e) {
    console.error('ensureSessionAccess', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
}

// Résout la classe d'un élève puis délègue à ensureClassAccess.
async function ensureStudentClassAccess(req, res, next) {
  try {
    if (req.user?.role === 'admin') return next()

    const studentId = Number(req.params.id)
    if (!Number.isInteger(studentId)) {
      return res.status(400).json({ message: 'studentId invalide' })
    }

    const { rows } = await pool.query('SELECT class_id FROM students WHERE id = $1', [studentId])
    if (!rows.length) return res.status(404).json({ message: 'Élève introuvable' })

    req.params.classId = String(rows[0].class_id)
    return ensureClassAccess(req, res, next)
  } catch (e) {
    console.error('ensureStudentClassAccess', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
}

// ─────────────────────────────────────────────────────────────
// Utilitaires : dates et génération de séances (UTC)
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
  return { start: utcNoon(sy, 8, 1), end: utcNoon(sy + 1, 6, 14) }
}

const ISO_FROM_FR = {
  dimanche: 7, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
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
  return iso % 7 // ISO 7 (dimanche) → JS 0
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

async function ensureSessionsForWeekday(classId, isoWeekday, startYear = schoolStartYear()) {
  const start = utcNoon(startYear, 8, 1)
  const end = utcNoon(startYear + 1, 6, 14)
  const dates = enumerateDatesByWeekday(start, end, isoWeekday)
  await pool.query(
    `INSERT INTO sessions (class_id, date)
     SELECT $1, unnest($2::date[])
     ON CONFLICT (class_id, date) DO NOTHING`,
    [classId, dates],
  )
}

// ─────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────
const DEV = (process.env.NODE_ENV || 'development') !== 'production'

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {}
    if (!username || !password) {
      return res.status(400).json({ message: 'Username et mot de passe requis' })
    }

    const { rows } = await pool.query(
      `SELECT id, username, role, password
       FROM public.users
       WHERE lower(username) = lower($1)
       LIMIT 1`,
      [String(username).trim()],
    )
    if (!rows.length) {
      return res.status(401).json({ message: 'Utilisateur non trouvé' })
    }

    const user = rows[0]
    const ok = bcrypt.compareSync(String(password), user.password)
    if (!ok) {
      return res.status(401).json({ message: 'Mot de passe incorrect' })
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' },
    )

    return res.json({ token, user: { id: user.id, username: user.username, role: user.role } })
  } catch (err) {
    console.error('POST /login :', err)
    if (DEV) return res.status(500).json({ message: 'Erreur serveur', code: err.code, detail: err.message })
    return res.status(500).json({ message: 'Erreur serveur' })
  }
})

// Renvoie le profil de l'utilisateur connecté (appelé au bootstrap côté client)
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, role FROM users WHERE id = $1',
      [req.user.id],
    )
    if (!rows.length) return res.status(404).json({ message: 'Utilisateur introuvable' })
    res.json(rows[0])
  } catch (e) {
    console.error('GET /api/me :', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

// ─────────────────────────────────────────────────────────────
// ADMIN
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
    console.error('GET /api/admin/profs :', e)
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
    console.error('GET /api/admin/stats :', e)
    res.status(500).json({ message: 'Erreur stats' })
  }
})

admin.get('/attendance-rate', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.nom AS name,
             COUNT(DISTINCT s.id)::int AS sessions,
             COUNT(a.*)::int AS marked,
             SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END)::int AS presents,
             ROUND(
               CASE WHEN COUNT(a.*) = 0 THEN 0
                    ELSE 100.0 * SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) / COUNT(a.*)
               END, 1
             ) AS rate
      FROM classes c
      LEFT JOIN sessions s ON s.class_id = c.id
        AND NOT EXISTS (
          SELECT 1 FROM periodes_exclues pe
          WHERE s.date BETWEEN pe.date_debut AND pe.date_fin
        )
      LEFT JOIN attendances a ON a.session_id = s.id
      GROUP BY c.id, c.nom
      ORDER BY rate ASC
    `)
    res.json(rows)
  } catch (e) {
    console.error('GET /api/admin/attendance-rate :', e)
    res.status(500).json({ message: 'Erreur stats présence' })
  }
})

admin.get('/attendance-by-month', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.nom AS name,
             EXTRACT(YEAR  FROM s.date)::int AS year,
             EXTRACT(MONTH FROM s.date)::int AS month,
             COUNT(a.*)::int AS marked,
             SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END)::int AS presents,
             ROUND(
               CASE WHEN COUNT(a.*) = 0 THEN 0
                    ELSE 100.0 * SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) / COUNT(a.*)
               END, 1
             ) AS rate
      FROM classes c
      JOIN sessions s ON s.class_id = c.id
        AND s.date IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM periodes_exclues pe
          WHERE s.date BETWEEN pe.date_debut AND pe.date_fin
        )
      JOIN attendances a ON a.session_id = s.id
      GROUP BY c.id, c.nom, year, month
      ORDER BY c.id, year, month
    `)
    res.json(rows)
  } catch (e) {
    console.error('GET /api/admin/attendance-by-month :', e)
    res.status(500).json({ message: 'Erreur stats mensuelles' })
  }
})

admin.get('/classes', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id,
             c.nom         AS name,
             c.description,
             c.user_id     AS owner_id,
             u.username    AS owner_username
      FROM classes c
      LEFT JOIN users u ON u.id = c.user_id
      ORDER BY c.nom ASC
    `)
    res.json(rows)
  } catch (e) {
    console.error('GET /api/admin/classes :', e)
    res.status(500).json({ message: 'Erreur chargement classes' })
  }
})

admin.get('/classes/:id/managers', async (req, res) => {
  try {
    const classId = Number(req.params.id)
    if (!Number.isInteger(classId)) return res.status(400).json({ message: 'classId invalide' })

    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.role, TRUE AS is_owner
       FROM users u
       JOIN classes c ON c.user_id = u.id
       WHERE c.id = $1
       UNION
       SELECT u.id, u.username, u.role, FALSE AS is_owner
       FROM users u
       JOIN class_users cu ON cu.user_id = u.id
       WHERE cu.class_id = $1
       ORDER BY is_owner DESC, username ASC`,
      [classId],
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /api/admin/classes/:id/managers :', e)
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
    console.error('POST /api/admin/classes :', e)
    res.status(500).json({ message: 'Erreur création' })
  }
})

admin.patch('/classes/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { name, description, owner_id } = req.body
    const { rows } = await pool.query(
      `UPDATE classes
         SET nom         = COALESCE($1, nom),
             description = COALESCE($2, description),
             user_id     = $3
       WHERE id = $4
       RETURNING id, nom AS name, description, user_id AS owner_id`,
      [name ?? null, description ?? null, owner_id ?? null, id],
    )
    if (!rows[0]) return res.status(404).json({ message: 'Classe introuvable' })
    await upsertOwnerLink(id, owner_id)
    res.json(rows[0])
  } catch (e) {
    console.error('PATCH /api/admin/classes/:id :', e)
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
    console.error('DELETE /api/admin/classes/:id :', e)
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
    console.error('POST /api/admin/class-users :', e)
    res.status(500).json({ message: 'Erreur liaison' })
  }
})

admin.get('/class-users', async (req, res) => {
  try {
    const class_id = Number(req.query.class_id)
    if (!Number.isInteger(class_id)) return res.status(400).json({ message: 'class_id invalide' })

    const { rows } = await pool.query(
      `(
         SELECT u.id, u.username, u.role, FALSE AS is_owner
         FROM class_users cu
         JOIN users u ON u.id = cu.user_id
         WHERE cu.class_id = $1
       )
       UNION
       (
         SELECT u.id, u.username, u.role, TRUE AS is_owner
         FROM classes c
         JOIN users u ON u.id = c.user_id
         WHERE c.id = $1 AND c.user_id IS NOT NULL
       )
       ORDER BY is_owner DESC, username ASC`,
      [class_id],
    )
    res.json(Array.isArray(rows) ? rows : [])
  } catch (e) {
    console.error('GET /api/admin/class-users :', e)
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
    console.error('DELETE /api/admin/class-users :', e)
    res.status(500).json({ message: 'Erreur délier' })
  }
})

// Route publique (pas d'authentification requise)
app.use('/api/public', inscriptionRouter)

app.use('/api/admin', admin)

// ─────────────────────────────────────────────────────────────
// DOSSIERS — lecture admin
// ─────────────────────────────────────────────────────────────
const dossierUploads = require('path').join(__dirname, 'uploads', 'dossiers')

// Liste tous les dossiers reçus (admin uniquement)
app.get('/api/admin/dossiers', authenticateToken, authorizeRoles('admin'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, type, nom_eleve, prenom_eleve, submitted_at FROM dossiers ORDER BY submitted_at DESC',
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /api/admin/dossiers :', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

// Téléchargement d'un PDF de dossier (admin uniquement)
app.get('/api/admin/dossiers/:id/pdf', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT pdf_filename, type, nom_eleve, prenom_eleve FROM dossiers WHERE id = $1',
      [Number(req.params.id)],
    )
    if (!rows.length) return res.status(404).json({ message: 'Dossier introuvable' })

    const { pdf_filename, type, prenom_eleve, nom_eleve } = rows[0]
    const filePath = require('path').join(dossierUploads, pdf_filename)

    if (!require('fs').existsSync(filePath)) {
      return res.status(404).json({ message: 'Fichier PDF introuvable' })
    }

    const safeName = (v) => String(v || '').replace(/[^\wÀ-ɏ\- ]/g, '').trim()
    const safeFilename = `dossier-${type}-${safeName(prenom_eleve)}-${safeName(nom_eleve)}.pdf`
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`)
    require('fs').createReadStream(filePath).pipe(res)
  } catch (e) {
    console.error('GET /api/admin/dossiers/:id/pdf :', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

// ─────────────────────────────────────────────────────────────
// CLASSES
// ─────────────────────────────────────────────────────────────

// Route legacy (admin uniquement) conservée pour compatibilité
app.get('/classes', authenticateToken, authorizeRoles('admin'), async (_req, res) => {
  try {
    const result = await pool.query('SELECT id, nom AS name FROM classes ORDER BY nom ASC')
    res.json(result.rows)
  } catch (err) {
    console.error('GET /classes :', err)
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
      `SELECT DISTINCT c.id, c.nom AS name, c.description, c.user_id AS owner_id
       FROM classes c
       LEFT JOIN class_users cu ON cu.class_id = c.id
       WHERE c.user_id = $1 OR cu.user_id = $1
       ORDER BY c.nom ASC`,
      [req.user.id],
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /my-classes :', err)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

const classesRouter = express.Router()

// Renvoie les classes accessibles à l'utilisateur connecté
classesRouter.get('/', authenticateToken, async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const result = await pool.query('SELECT id, nom AS name FROM classes ORDER BY nom ASC')
      return res.json(result.rows)
    }
    if (req.user.role === 'prof') {
      const result = await pool.query(
        `SELECT DISTINCT c.id, c.nom AS name
         FROM classes c
         LEFT JOIN class_users cu ON cu.class_id = c.id
         WHERE c.user_id = $1 OR cu.user_id = $1
         ORDER BY c.nom ASC`,
        [req.user.id],
      )
      return res.json(result.rows)
    }
    return res.status(403).json({ message: 'Accès interdit' })
  } catch (err) {
    console.error('GET /api/classes :', err)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

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
    console.error('GET /api/classes/:id :', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

app.use('/api/classes', classesRouter)

// Met à jour le jour de cours de la classe et génère les séances manquantes
app.patch(
  ['/api/classes/:id/weekday', '/classes/:id/weekday'],
  authenticateToken,
  authorizeRoles('prof', 'admin'),
  ensureClassAccess,
  async (req, res) => {
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
        `INSERT INTO sessions (class_id, date)
         SELECT $1, unnest($2::date[])
         ON CONFLICT (class_id, date) DO NOTHING`,
        [classId, dates],
      )

      const { rows } = await pool.query(
        "SELECT id, to_char(date,'YYYY-MM-DD') AS date, status, note FROM sessions WHERE class_id=$1 ORDER BY date",
        [classId],
      )
      res.json(rows)
    } catch (e) {
      console.error('PATCH weekday :', e)
      res.status(500).json({ message: 'Erreur mise à jour du jour de classe' })
    }
  },
)

// Route legacy : génère les séances d'une classe pour l'année scolaire active
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
      if (isoWeekday == null) return res.status(400).json({ message: 'Jour de cours requis (weekday)' })

      if (cl.rows[0].weekday !== isoWeekday) {
        await pool.query('UPDATE classes SET weekday = $1 WHERE id = $2', [isoWeekday, classId])
      }

      const { start, end } = getActiveSchoolYear()
      const allDates = enumerateDatesByWeekday(start, end, isoWeekday)

      await pool.query(
        `INSERT INTO sessions (class_id, date)
         SELECT $1, unnest($2::date[])
         ON CONFLICT (class_id, date) DO NOTHING`,
        [classId, allDates],
      )

      const { rows } = await pool.query(
        "SELECT id, to_char(date,'YYYY-MM-DD') AS date, status, note FROM sessions WHERE class_id=$1 ORDER BY date",
        [classId],
      )
      res.json(rows)
    } catch (e) {
      console.error('POST /classes/:id/generate-sessions :', e)
      res.status(500).json({ message: 'Erreur génération sessions' })
    }
  },
)

// ─────────────────────────────────────────────────────────────
// STUDENTS
// ─────────────────────────────────────────────────────────────
const studentsRouter = express.Router()

// Toutes les routes élèves nécessitent un token valide et le rôle prof ou admin
studentsRouter.use(authenticateToken, authorizeRoles('prof', 'admin'))

studentsRouter.post('/', ensureClassAccess, async (req, res) => {
  try {
    const { firstname, lastname, class_id, phone, weekday } = req.body
    const iso = normalizeToIsoWeekday(weekday)

    const { rows } = await pool.query(
      `INSERT INTO students (firstname, lastname, class_id, phone, weekday)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [firstname, lastname, class_id, phone ?? null, iso ?? null],
    )

    // Si l'élève a un jour spécifique, on génère ses séances pour l'année en cours
    if (iso) await ensureSessionsForWeekday(Number(class_id), iso)
    res.json(rows[0])
  } catch (err) {
    console.error('POST /api/students :', err)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

studentsRouter.get('/:classId', ensureClassAccess, async (req, res) => {
  try {
    const { classId } = req.params
    const result = await pool.query(
      'SELECT * FROM students WHERE class_id = $1 ORDER BY lastname ASC',
      [classId],
    )
    res.json(result.rows)
  } catch (err) {
    console.error('GET /api/students/:classId :', err)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

studentsRouter.delete('/:id', ensureStudentClassAccess, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id invalide' })
  try {
    const { rowCount } = await pool.query('DELETE FROM students WHERE id=$1', [id])
    if (rowCount === 0) return res.status(404).json({ error: 'élève introuvable' })
    return res.status(204).end()
  } catch (err) {
    console.error('DELETE /api/students/:id :', err)
    return res.status(500).json({ error: 'server_error' })
  }
})

studentsRouter.patch('/:id', ensureStudentClassAccess, async (req, res) => {
  try {
    const id = Number(req.params.id)
    const { phone, weekday } = req.body

    const iso = weekday !== undefined ? normalizeToIsoWeekday(weekday) : undefined

    const fields = []
    const values = []
    let index = 1

    if (iso !== undefined) {
      fields.push(`weekday = $${index}`)
      values.push(iso ?? null)
      index++
    }
    if (phone !== undefined) {
      fields.push(`phone = $${index}`)
      values.push(phone || null)
      index++
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: 'Aucune donnée à mettre à jour' })
    }

    values.push(id)

    const { rows } = await pool.query(
      `UPDATE students
         SET ${fields.join(', ')}
       WHERE id = $${index}
       RETURNING id, firstname, lastname, class_id, phone, weekday`,
      values,
    )

    if (!rows.length) return res.status(404).json({ message: 'Élève introuvable' })

    if (iso) await ensureSessionsForWeekday(Number(rows[0].class_id), iso)

    res.json(rows[0])
  } catch (e) {
    console.error('PATCH /api/students/:id :', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

app.use('/api/students', studentsRouter)

// ─────────────────────────────────────────────────────────────
// SESSIONS
// ─────────────────────────────────────────────────────────────
const sessionsRouter = express.Router()

sessionsRouter.get(
  '/:classId',
  authenticateToken,
  authorizeRoles('prof', 'admin'),
  ensureClassAccess,
  async (req, res) => {
    try {
      const { classId } = req.params
      const { rows } = await pool.query(
        "SELECT id, to_char(date,'YYYY-MM-DD') AS date, status, note FROM sessions WHERE class_id=$1 ORDER BY date",
        [classId],
      )
      res.json(rows)
    } catch (err) {
      console.error('GET /sessions/:classId :', err)
      res.status(500).json({ error: 'Erreur serveur' })
    }
  },
)

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
          `INSERT INTO sessions (class_id, date)
           SELECT $1, unnest($2::date[])
           ON CONFLICT (class_id, date) DO NOTHING`,
          [class_id, newDates],
        )
      }

      res.json([...existingDates, ...newDates].sort())
    } catch (err) {
      console.error('POST /sessions :', err)
      res.status(500).json({ error: 'Erreur serveur' })
    }
  },
)

app.use('/sessions', sessionsRouter)

// ─────────────────────────────────────────────────────────────
// ATTENDANCE (présences)
// ─────────────────────────────────────────────────────────────

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
      console.error('GET /attendance/:classId :', err)
      res.status(500).json({ message: 'Erreur serveur' })
    }
  },
)

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

      const { rows: sRows } = await pool.query(
        'SELECT status FROM sessions WHERE id=$1',
        [session_id],
      )
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
      console.error('POST /attendance :', err)
      res.status(500).json({ message: 'Erreur serveur' })
    }
  },
)

// Met à jour le statut d'une séance. Si le nouveau statut est non-pointable
// et que des présences existent, ?force=true est requis pour les supprimer.
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
            message: 'Des pointages existent pour cette séance. Confirmez avec ?force=true pour les supprimer.',
            existing: cnt[0].n,
          })
        }
        if (cnt[0].n > 0 && force) {
          await pool.query('DELETE FROM attendances WHERE session_id=$1', [id])
        }
      }

      const { rows, rowCount } = await pool.query(
        `UPDATE sessions
           SET status = $1,
               note   = $2
         WHERE id = $3
         RETURNING id, to_char(date,'YYYY-MM-DD') AS date, status, note`,
        [status, note ?? null, id],
      )

      if (rowCount === 0) return res.status(404).json({ message: 'Séance introuvable' })
      return res.json(rows[0])
    } catch (e) {
      console.error('PATCH /sessions/:id/status :', e)
      res.status(500).json({ message: 'Erreur mise à jour statut' })
    }
  },
)

// Crée une séance extra (hors planning habituel) pour une classe
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

      const { rows } = await pool.query(
        `INSERT INTO sessions (class_id, date, status, note)
         VALUES ($1, $2::date, 'extra', $3)
         ON CONFLICT (class_id, date) DO NOTHING
         RETURNING id, to_char(date,'YYYY-MM-DD') AS date, status, note`,
        [classId, date, note ?? null],
      )

      if (!rows.length) {
        return res.status(409).json({ message: 'Une séance existe déjà à cette date pour cette classe.' })
      }
      res.status(201).json(rows[0])
    } catch (e) {
      console.error('POST /classes/:classId/sessions/extra :', e)
      res.status(500).json({ message: 'Erreur création séance extra' })
    }
  },
)

// ─────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS — abonnement + test admin
// ─────────────────────────────────────────────────────────────
app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
  const { endpoint, keys } = req.body
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ message: 'Abonnement invalide' })
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = $3, auth = $4`,
      [req.user.id, endpoint, keys.p256dh, keys.auth],
    )
    res.json({ ok: true })
  } catch (e) {
    console.error('POST /api/push/subscribe :', e)
    res.status(500).json({ message: 'Erreur serveur' })
  }
})

// Fallback 404
// ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

// ─────────────────────────────────────────────────────────────
// Init : table periodes_exclues + seed Zone B 2024-2025
// Dates à vérifier sur education.gouv.fr si l'année change
// ─────────────────────────────────────────────────────────────
async function initPeriodesExclues() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS periodes_exclues (
      id         SERIAL PRIMARY KEY,
      label      VARCHAR(100) NOT NULL,
      date_debut DATE NOT NULL,
      date_fin   DATE NOT NULL
    )
  `)
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM periodes_exclues')
  if (rows[0].n > 0) return
  await pool.query(`
    INSERT INTO periodes_exclues (label, date_debut, date_fin) VALUES
      ('Toussaint 2024',          '2024-10-19', '2024-11-03'),
      ('Armistice 2024',          '2024-11-11', '2024-11-11'),
      ('Noel 2024',               '2024-12-21', '2025-01-05'),
      ('Hiver Zone B 2025',       '2025-02-22', '2025-03-09'),
      ('Printemps Zone B 2025',   '2025-04-19', '2025-05-04'),
      ('Victoire 1945 2025',      '2025-05-08', '2025-05-08'),
      ('Ascension 2025',          '2025-05-29', '2025-05-29'),
      ('Pentecote 2025',          '2025-06-09', '2025-06-09')
  `)
  console.log('[init] periodes_exclues seeded')
}

async function initPushSubscriptions() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint   TEXT NOT NULL,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, endpoint)
    )
  `)
}

// ─────────────────────────────────────────────────────────────
// CRON — rappel pointage chaque jour à 12h (Europe/Paris)
// ─────────────────────────────────────────────────────────────
cron.schedule('0 12 * * *', async () => {
  if (!process.env.VAPID_PUBLIC_KEY) return

  const jsDay = new Date().getDay()
  const isoDay = jsDay === 0 ? 7 : jsDay

  try {
    const { rows: profs } = await pool.query(`
      SELECT t.user_id, u.username, array_agg(DISTINCT t.nom ORDER BY t.nom) AS class_names
      FROM (
        SELECT c.user_id, c.nom FROM classes c WHERE c.weekday = $1
        UNION ALL
        SELECT cu.user_id, c.nom
        FROM classes c JOIN class_users cu ON cu.class_id = c.id
        WHERE c.weekday = $1
      ) t
      JOIN users u ON u.id = t.user_id
      GROUP BY t.user_id, u.username
    `, [isoDay])

    for (const prof of profs) {
      const { rows: subs } = await pool.query(
        'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
        [prof.user_id],
      )
      for (const sub of subs) {
        const classNames = prof.class_names
        const isSingle = classNames.length === 1
        const prenom = prof.username

        const title = 'Rappel pointage 🎵'
        const body = isSingle
          ? `Bonjour ${prenom}, n'oubliez pas de faire le pointage de votre classe ${classNames[0]} aujourd'hui, ce serait dommage !`
          : `Bonjour ${prenom}, vous avez ${classNames.length} classes aujourd'hui : ${classNames.join(', ')}. N'oubliez pas de pointer, ce serait dommage !`

        const payload = JSON.stringify({ title, body, url: '/classes' })
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        ).catch(async (err) => {
          if (err.statusCode === 410) {
            await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint])
          }
        })
      }
    }
    console.log('[cron] rappels pointage envoyés —', profs.length, 'prof(s) concerné(s)')
  } catch (e) {
    console.error('[cron] erreur rappel pointage :', e)
  }
}, { timezone: 'Europe/Paris' })

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`)
})
initPeriodesExclues().catch(e => console.error('[init] periodes_exclues :', e))
initPushSubscriptions().catch(e => console.error('[init] push_subscriptions :', e))