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
    const EXTRA_NODE_PATH = '/home/c2658980c/nodevenv/pointage-api/20/lib/node_modules'

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
    const helmet = require('helmet')
    const rateLimit = require('express-rate-limit')
    const jwt = require('jsonwebtoken')
    const webpush = require('web-push')
    const cron = require('node-cron')
    const handleInscription = require('./routes/inscription')
    const schoolYears   = require('./routes/schoolYears')
    const enrollments   = require('./routes/enrollments')

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

    // Sécurité HTTP headers (désactivé CSP et CORP car API pure JSON)
    app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }))

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

    // Quand aucune origine n'est configurée, les deux middlewares ci-dessous
    // acceptent TOUTES les origines avec Allow-Credentials. Le comportement est
    // conservé pour ne pas couper l'app si la variable venait à manquer, mais
    // l'anomalie doit être visible dans les logs de démarrage.
    if (ALLOWED.size === 0) {
      console.warn(
        '⚠️  CORS_ORIGINS vide — toutes les origines sont acceptées. ' +
        'Définissez CORS_ORIGINS (ex: https://emm-pointage.fr) pour restreindre.',
      )
    } else {
      console.log('[boot] CORS restreint à :', [...ALLOWED].join(', '))
    }

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
      res.json({ ok: true, time: new Date().toISOString(), v: 2 })
    })

    // Les sondes /__cors et /__db sont déclarées plus bas, une fois les
    // middlewares d'authentification définis : elles exposent des informations
    // d'infrastructure et sont réservées aux administrateurs.

    // ─────────────────────────────────────────────────────────────
    // Middlewares d'authentification et d'autorisation
    // ─────────────────────────────────────────────────────────────

    function authenticateToken(req, res, next) {
      const authHeader = req.headers['authorization']
      const token = authHeader && authHeader.split(' ')[1]
      if (!token) return res.sendStatus(401)
      jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        // 401 et non 403 : le jeton est absent ou invalide, donc la session est
        // à refaire. Le 403 reste réservé aux refus d'autorisation, ce qui permet
        // au client de distinguer « reconnecte-toi » de « tu n'as pas le droit ».
        if (err) return res.sendStatus(401)
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

    // ─────────────────────────────────────────────────────────────
    // Sondes de diagnostic — réservées aux administrateurs.
    // Elles révèlent la configuration CORS et l'identité du serveur
    // PostgreSQL (base, utilisateur, hôte, version) : autant d'éléments
    // qui n'ont rien à faire en accès public.
    // ─────────────────────────────────────────────────────────────
    app.get('/__cors', authenticateToken, authorizeRoles('admin'), (req, res) => {
      const origin = (req.headers.origin || '').replace(/\/$/, '')
      // On ne renvoie pas req.headers : inutile au diagnostic et cela
      // réfléchirait l'en-tête Authorization dans la réponse.
      res.json({ origin, allowedOrigins: [...ALLOWED], method: req.method })
    })

    app.get('/__db', authenticateToken, authorizeRoles('admin'), async (_req, res) => {
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

    // Résout la classe d'un élève (enrollment année courante, puis fallback students.class_id).
    async function ensureStudentClassAccess(req, res, next) {
      try {
        if (req.user?.role === 'admin') return next()

        const studentId = Number(req.params.id)
        if (!Number.isInteger(studentId)) {
          return res.status(400).json({ message: 'studentId invalide' })
        }

        const { rows } = await pool.query(`
          SELECT class_id FROM (
            SELECT ce.class_id FROM class_enrollments ce
            JOIN school_years sy ON sy.id = ce.school_year_id AND sy.is_current = true
            WHERE ce.student_id = $1
            UNION
            SELECT class_id FROM students WHERE id = $1 AND class_id IS NOT NULL
          ) AS sources LIMIT 1
        `, [studentId])
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

    async function ensureSessionsForWeekday(classId, isoWeekday) {
      // Utilise la vraie start_date/end_date de l'année en cours (pas Sep 1 hardcodé)
      const { rows: sy } = await pool.query(
        `SELECT id, label,
                to_char(start_date, 'YYYY-MM-DD') AS start_date,
                to_char(end_date,   'YYYY-MM-DD') AS end_date
        FROM school_years WHERE is_current = true LIMIT 1`,
      )
      if (!sy[0]) return
      const { id: schoolYearId, label: yearLabel, start_date: startDate, end_date: endDate } = sy[0]

      const start = new Date(startDate + 'T12:00:00Z')
      const end   = new Date(endDate   + 'T12:00:00Z')
      const dates = enumerateDatesByWeekday(start, end, isoWeekday)

      if (dates.length) {
        await pool.query(
          `INSERT INTO sessions (class_id, date, school_year_id)
          SELECT $1, unnest($2::date[]), $3
          ON CONFLICT (class_id, date) DO NOTHING`,
          [classId, dates, schoolYearId],
        )
      }
    }

    // ─────────────────────────────────────────────────────────────
    // AUTH
    // ─────────────────────────────────────────────────────────────
    // Le détail des erreurs n'est renvoyé au client qu'en développement déclaré.
    // Auparavant un NODE_ENV absent suffisait à activer ce mode et à exposer
    // err.code / err.message en production.
    const DEV = process.env.NODE_ENV === 'development'

    // Haché de comparaison utilisé quand le compte n'existe pas, pour que la
    // réponse coûte le même temps qu'une vraie vérification (cf. /login).
    const DUMMY_HASH = bcrypt.hashSync('mot-de-passe-inexistant', 10)

    const loginLimiter = rateLimit({
      windowMs: 5 * 60 * 1000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { message: 'Trop de tentatives de connexion, réessayez dans 5 minutes.' },
    })

    // Chaque soumission génère un PDF, écrit sur disque et déclenche un e-mail :
    // sans limite, l'endpoint public permettait de saturer le disque et d'inonder
    // la boîte de l'administrateur. 10 par heure laisse largement la place à une
    // famille inscrivant plusieurs enfants depuis la même connexion.
    const inscriptionLimiter = rateLimit({
      windowMs: 60 * 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { message: 'Trop de soumissions depuis cette connexion. Réessayez dans une heure.' },
    })

    app.post('/login', loginLimiter, async (req, res) => {
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

        const user = rows[0]

        // Message unique quel que soit le cas, et comparaison bcrypt même quand
        // le compte n'existe pas : deux messages distincts, ou une réponse
        // immédiate faute de hachage à vérifier, permettaient d'énumérer les
        // comptes valides. Les identifiants étant de la forme Prénom.Nom,
        // l'information était facile à exploiter.
        const hash = user ? user.password : DUMMY_HASH
        const ok = await bcrypt.compare(String(password), hash)

        if (!user || !ok) {
          return res.status(401).json({ message: 'Identifiant ou mot de passe incorrect' })
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

    // Pointages "attendus" pour une année : une ligne par (séance pointable, élève attendu).
    // Reprend la logique de la matrice : class_student_weekday prime sur classes.weekday.
    // Bornée à CURRENT_DATE — les séances futures ne sont pas encore pointables.
    const EXPECTED_CTE = `
      WITH cur AS (
        SELECT id FROM school_years
        WHERE ($1::int IS NOT NULL AND id = $1::int)
           OR ($1::int IS NULL AND is_current = true)
        LIMIT 1
      ),
      pointable AS (
        SELECT s.id, s.class_id, s.date
        FROM sessions s
        WHERE s.school_year_id = (SELECT id FROM cur)
          AND s.status IN ('scheduled', 'extra')
          AND s.date <= CURRENT_DATE
      ),
      expected AS (
        SELECT p.class_id, p.id AS session_id, p.date, ce.student_id
        FROM pointable p
        JOIN classes c ON c.id = p.class_id
        JOIN class_enrollments ce
          ON ce.class_id = p.class_id
         AND ce.school_year_id = (SELECT id FROM cur)
        LEFT JOIN class_student_weekday csw
          ON csw.class_id = p.class_id AND csw.student_id = ce.student_id
        WHERE CASE
          WHEN csw.weekday IS NOT NULL THEN EXTRACT(ISODOW FROM p.date)::int = csw.weekday
          WHEN c.weekday  IS NOT NULL THEN EXTRACT(ISODOW FROM p.date)::int = c.weekday
          ELSE TRUE
        END
      )`

    admin.get('/attendance-rate', async (req, res) => {
      try {
        const yearId = req.query.year_id ? Number(req.query.year_id) : null
        const { rows } = await pool.query(
          `${EXPECTED_CTE}
          SELECT c.id, c.nom AS name,
                COUNT(DISTINCT e.session_id)::int AS sessions,
                COUNT(e.session_id)::int         AS expected,
                COUNT(a.status)::int             AS marked,
                SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END)::int AS presents,
                SUM(CASE WHEN a.status = 'excused' THEN 1 ELSE 0 END)::int AS excused,
                SUM(CASE WHEN a.status = 'absent'  THEN 1 ELSE 0 END)::int AS absents,
                ROUND(
                  CASE WHEN COUNT(a.status) = 0 THEN 0
                       ELSE 100.0 * SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) / COUNT(a.status)
                  END, 1
                ) AS rate,
                ROUND(
                  CASE WHEN COUNT(e.session_id) = 0 THEN 0
                       ELSE 100.0 * COUNT(a.status) / COUNT(e.session_id)
                  END, 1
                ) AS coverage
          FROM classes c
          LEFT JOIN expected e ON e.class_id = c.id
          LEFT JOIN attendances a
            ON a.session_id = e.session_id AND a.student_id = e.student_id
          GROUP BY c.id, c.nom
          ORDER BY rate ASC, c.nom ASC`,
          [yearId],
        )
        res.json(rows)
      } catch (e) {
        console.error('GET /api/admin/attendance-rate :', e)
        res.status(500).json({ message: 'Erreur stats présence' })
      }
    })

    admin.get('/attendance-by-month', async (req, res) => {
      try {
        const yearId = req.query.year_id ? Number(req.query.year_id) : null
        const { rows } = await pool.query(
          `${EXPECTED_CTE}
          SELECT c.id, c.nom AS name,
                EXTRACT(YEAR  FROM e.date)::int AS year,
                EXTRACT(MONTH FROM e.date)::int AS month,
                COUNT(e.session_id)::int AS expected,
                COUNT(a.status)::int     AS marked,
                SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END)::int AS presents,
                ROUND(
                  CASE WHEN COUNT(a.status) = 0 THEN 0
                       ELSE 100.0 * SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) / COUNT(a.status)
                  END, 1
                ) AS rate,
                ROUND(
                  CASE WHEN COUNT(e.session_id) = 0 THEN 0
                       ELSE 100.0 * COUNT(a.status) / COUNT(e.session_id)
                  END, 1
                ) AS coverage
          FROM classes c
          JOIN expected e ON e.class_id = c.id
          LEFT JOIN attendances a
            ON a.session_id = e.session_id AND a.student_id = e.student_id
          GROUP BY c.id, c.nom, year, month
          ORDER BY c.id, year, month`,
          [yearId],
        )
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
                c.weekday,
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
        const { name, description, owner_id, weekday } = req.body
        if (!name || !name.trim()) return res.status(400).json({ message: 'Nom requis' })
        const isoWeekday = weekday != null ? normalizeToIsoWeekday(weekday) : null

        const { rows } = await pool.query(
          `INSERT INTO classes (nom, description, user_id, weekday)
          VALUES ($1, $2, $3, $4)
          RETURNING id, nom AS name, description, user_id AS owner_id, weekday`,
          [name.trim(), description ?? null, owner_id ?? null, isoWeekday],
        )
        await upsertOwnerLink(rows[0].id, owner_id)
        if (isoWeekday) await ensureSessionsForWeekday(rows[0].id, isoWeekday)
        res.json(rows[0])
      } catch (e) {
        console.error('POST /api/admin/classes :', e)
        res.status(500).json({ message: 'Erreur création' })
      }
    })

    admin.patch('/classes/:id', async (req, res) => {
      try {
        const { id } = req.params
        const { name, description, owner_id, weekday } = req.body
        const isoWeekday = weekday != null ? Number(weekday) : null
        const { rows } = await pool.query(
          `UPDATE classes
            SET nom         = COALESCE($1, nom),
                description = COALESCE($2, description),
                user_id     = $3,
                weekday     = CASE WHEN $5::int IS NOT NULL THEN $5::int ELSE weekday END
          WHERE id = $4
          RETURNING id, nom AS name, description, user_id AS owner_id, weekday`,
          [name ?? null, description ?? null, owner_id ?? null, id, isoWeekday],
        )
        if (!rows[0]) return res.status(404).json({ message: 'Classe introuvable' })
        await upsertOwnerLink(id, owner_id)
        const finalWeekday = rows[0].weekday
        if (finalWeekday) await ensureSessionsForWeekday(Number(id), finalWeekday)
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

    // Liste les élèves (admin uniquement).
    // Sans paramètre : tous les élèves (utile pour la recherche réinscription).
    // Avec ?enrolled=true : uniquement ceux inscrits pour l'année courante.
    app.get('/api/admin/students', authenticateToken, authorizeRoles('admin'), async (req, res) => {
      try {
        const enrolledOnly = req.query.enrolled === 'true'
        let rows
        if (enrolledOnly) {
          ;({ rows } = await pool.query(`
            SELECT s.id, s.firstname, s.lastname, s.phone, s.weekday,
                  ce.class_id, c.nom AS class_name
            FROM students s
            JOIN class_enrollments ce ON ce.student_id = s.id
            JOIN school_years sy ON sy.id = ce.school_year_id AND sy.is_current = true
            LEFT JOIN classes c ON c.id = ce.class_id
            ORDER BY s.lastname ASC, s.firstname ASC
          `))
        } else {
          ;({ rows } = await pool.query(`
            SELECT s.id, s.firstname, s.lastname, s.phone, s.weekday,
                  s.class_id, c.nom AS class_name
            FROM students s
            LEFT JOIN classes c ON c.id = s.class_id
            ORDER BY s.lastname ASC, s.firstname ASC
          `))
        }
        res.json(rows)
      } catch (e) {
        console.error('GET /api/admin/students :', e)
        res.status(500).json({ message: 'Erreur serveur' })
      }
    })

    // Années scolaires (admin uniquement)
    app.use('/api/admin/school-years',  authenticateToken, authorizeRoles('admin'), schoolYears)
    app.use('/api/admin/enrollments',   authenticateToken, authorizeRoles('admin'), enrollments)

    // Année courante (tous les utilisateurs authentifiés)
    app.get('/api/current-school-year', authenticateToken, async (_req, res) => {
      try {
        const { rows } = await pool.query(
          `SELECT id, label,
                  to_char(start_date, 'YYYY-MM-DD') AS start_date,
                  to_char(end_date,   'YYYY-MM-DD') AS end_date
          FROM school_years WHERE is_current = true LIMIT 1`,
        )
        if (!rows.length) return res.status(404).json({ message: 'Aucune année scolaire active' })
        res.json(rows[0])
      } catch (e) {
        console.error('GET /api/current-school-year :', e)
        res.status(500).json({ message: 'Erreur serveur' })
      }
    })

    // Route publique (pas d'authentification requise)
    app.post('/api/public/inscription', inscriptionLimiter, handleInscription)

    // Déclenchement des rappels par le cron cPanel, authentifié par CRON_SECRET.
    // Doit impérativement être déclarée AVANT le montage du routeur /api/admin :
    // celui-ci applique authenticateToken à tout son préfixe, et tentait donc de
    // valider le CRON_SECRET comme un JWT — la route était injoignable.
    app.post('/api/admin/trigger-reminders', async (req, res) => {
      const secret = process.env.CRON_SECRET
      const auth = req.headers['authorization'] || ''
      if (!secret || auth !== `Bearer ${secret}`) {
        return res.status(401).json({ message: 'Non autorisé' })
      }
      try {
        const result = await sendReminders()
        res.json({ ok: true, ...result })
      } catch (e) {
        console.error('[trigger-reminders] erreur :', e)
        res.status(500).json({ message: 'Erreur serveur' })
      }
    })

    app.use('/api/admin', admin)

    // ─────────────────────────────────────────────────────────────
    // DOSSIERS — lecture admin
    // ─────────────────────────────────────────────────────────────
    const dossierUploads = require('path').join(__dirname, 'uploads', 'dossiers')

    // Liste tous les dossiers reçus (admin uniquement)
    app.get('/api/admin/dossiers', authenticateToken, authorizeRoles('admin'), async (req, res) => {
      try {
        const { status } = req.query
        const params = []
        const where = status ? `WHERE status = $${params.push(status)}` : ''
        const { rows } = await pool.query(
          `SELECT id, type, nom_eleve, prenom_eleve, submitted_at, status, phone
          FROM dossiers ${where} ORDER BY submitted_at DESC`,
          params,
        )
        res.json(rows)
      } catch (e) {
        console.error('GET /api/admin/dossiers :', e)
        res.status(500).json({ message: 'Erreur serveur' })
      }
    })

    // Accepter un dossier : crée l'élève + enrollments (une ou plusieurs classes)
    app.post('/api/admin/dossiers/:id/accept', authenticateToken, authorizeRoles('admin'), async (req, res) => {
      const id = Number(req.params.id)
      const { class_ids, class_id, school_year_id, student_id } = req.body || {}

      // Accepte class_ids (tableau) ou class_id (rétro-compat)
      const classIds = Array.isArray(class_ids) && class_ids.length
        ? class_ids.map(Number).filter(Boolean)
        : class_id ? [Number(class_id)] : []

      if (!classIds.length || !school_year_id) {
        return res.status(400).json({ message: 'Au moins une classe et school_year_id requis' })
      }

      try {
        const { rows: found } = await pool.query(
          'SELECT id, nom_eleve, prenom_eleve, status, phone FROM dossiers WHERE id = $1',
          [id],
        )
        if (!found.length) return res.status(404).json({ message: 'Dossier introuvable' })
        if (found[0].status === 'accepted') return res.status(409).json({ message: 'Dossier déjà accepté' })

        const { nom_eleve, prenom_eleve, phone } = found[0]
        const primaryClassId = classIds[0]

        let studentId = student_id ? Number(student_id) : null

        if (!studentId) {
          const { rows: newSt } = await pool.query(
            `INSERT INTO students (firstname, lastname, class_id, phone, weekday)
            VALUES ($1, $2, $3, $4, NULL) RETURNING id`,
            [prenom_eleve, nom_eleve, primaryClassId, phone || null],
          )
          studentId = newSt[0].id
          // Force weekday = NULL (annule tout trigger DB éventuel)
          await pool.query('UPDATE students SET weekday = NULL WHERE id = $1', [studentId])
        } else {
          // Réinscription : si multi-classes, effacer le weekday pour eviter le filtrage par ancien jour
          if (classIds.length > 1) {
            await pool.query('UPDATE students SET class_id = $1, weekday = NULL WHERE id = $2', [primaryClassId, studentId])
          } else {
            await pool.query('UPDATE students SET class_id = $1 WHERE id = $2', [primaryClassId, studentId])
          }
        }

        // Crée un enrollment par classe sélectionnée
        for (const cid of classIds) {
          await pool.query(
            `INSERT INTO class_enrollments (student_id, class_id, school_year_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (student_id, class_id, school_year_id) DO NOTHING`,
            [studentId, cid, school_year_id],
          )
        }

        // S'assurer que les séances existent pour chaque classe (génère si manquantes)
        for (const cid of classIds) {
          const { rows: cls } = await pool.query('SELECT weekday FROM classes WHERE id = $1', [cid])
          if (cls[0]?.weekday) await ensureSessionsForWeekday(cid, cls[0].weekday)
        }

        await pool.query('UPDATE dossiers SET status = $1, school_year_id = $2 WHERE id = $3', ['accepted', school_year_id || null, id])

        res.json({ success: true, student_id: studentId })
      } catch (e) {
        console.error('POST /api/admin/dossiers/:id/accept :', e)
        res.status(500).json({ message: 'Erreur serveur' })
      }
    })

    // Remet un dossier à "pending" (ex : année test supprimée)
    app.patch('/api/admin/dossiers/:id/reset', authenticateToken, authorizeRoles('admin'), async (req, res) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return res.status(400).json({ message: 'id invalide' })
      try {
        const { rows } = await pool.query(
          "UPDATE dossiers SET status = 'pending', school_year_id = NULL WHERE id = $1 RETURNING id",
          [id],
        )
        if (!rows.length) return res.status(404).json({ message: 'Dossier introuvable' })
        res.json({ message: 'Dossier remis en attente' })
      } catch (e) {
        console.error('POST /api/admin/dossiers/:id/accept :', e)
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
    // ANNÉE SCOLAIRE COURANTE (public — profs + admin)
    // ─────────────────────────────────────────────────────────────

    app.get('/api/school-year', authenticateToken, async (_req, res) => {
      try {
        const { rows } = await pool.query(
          `SELECT id, label,
                  to_char(start_date, 'YYYY-MM-DD') AS start_date,
                  to_char(end_date,   'YYYY-MM-DD') AS end_date
          FROM school_years WHERE is_current = true LIMIT 1`,
        )
        if (!rows[0]) return res.status(404).json({ message: 'Aucune année scolaire active' })
        res.json(rows[0])
      } catch (e) {
        console.error('GET /api/school-year :', e)
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
          const result = await pool.query('SELECT id, nom AS name, weekday FROM classes ORDER BY nom ASC')
          return res.json(result.rows)
        }
        if (req.user.role === 'prof') {
          const result = await pool.query(
            `SELECT DISTINCT c.id, c.nom AS name, c.weekday
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

        // Sync enrollment pour l'année scolaire courante (best-effort)
        const { rows: years } = await pool.query(
          'SELECT id FROM school_years WHERE is_current = true LIMIT 1',
        )
        if (years.length) {
          await pool.query(
            `INSERT INTO class_enrollments (student_id, class_id, school_year_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (student_id, class_id, school_year_id) DO NOTHING`,
            [rows[0].id, class_id, years[0].id],
          )
        }

        // Ne génère plus de séances depuis le jour perso de l'élève.
        // Les séances sont gérées par le jour de la classe (classes.weekday)
        // et, si besoin, par class_student_weekday.
        res.json(rows[0])
      } catch (err) {
        console.error('POST /api/students :', err)
        res.status(500).json({ message: 'Erreur serveur' })
      }
    })

    studentsRouter.get('/:classId', ensureClassAccess, async (req, res) => {
      try {
        const { classId } = req.params
        const { rows } = await pool.query(`
          SELECT s.id, s.firstname, s.lastname, s.phone, s.weekday, ce.class_id,
                csw.weekday AS class_weekday_override
          FROM students s
          JOIN class_enrollments ce ON ce.student_id = s.id
          JOIN school_years sy ON sy.id = ce.school_year_id AND sy.is_current = true
          LEFT JOIN class_student_weekday csw ON csw.student_id = s.id AND csw.class_id = ce.class_id
          WHERE ce.class_id = $1
          ORDER BY s.lastname ASC
        `, [classId])
        res.json(rows)
      } catch (err) {
        console.error('GET /api/students/:classId :', err)
        res.status(500).json({ message: 'Erreur serveur' })
      }
    })

    studentsRouter.delete('/:id', ensureStudentClassAccess, async (req, res) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'id invalide' })
      try {
        // Supprime uniquement l'inscription à l'année courante (préserve l'historique des présences)
        const { rows: sy } = await pool.query('SELECT id FROM school_years WHERE is_current = true LIMIT 1')
        if (!sy.length) return res.status(500).json({ error: 'Aucune année scolaire active' })
        const { rowCount } = await pool.query(
          'DELETE FROM class_enrollments WHERE student_id = $1 AND school_year_id = $2',
          [id, sy[0].id],
        )
        if (rowCount === 0) return res.status(404).json({ error: 'Inscription introuvable pour cette année' })
        return res.status(204).end()
      } catch (err) {
        console.error('DELETE /api/students/:id :', err)
        return res.status(500).json({ error: 'server_error' })
      }
    })

    studentsRouter.patch('/:id', ensureStudentClassAccess, async (req, res) => {
      try {
        const id = Number(req.params.id)
        const { phone, weekday, class_id } = req.body

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
        // Changement de classe réservé aux admins
        if (class_id !== undefined && req.user?.role === 'admin') {
          fields.push(`class_id = $${index}`)
          values.push(Number(class_id))
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

        // Ne génère plus de séances depuis le jour perso de l'élève.
        // Les séances sont toujours gérées par le jour de la classe.

        res.json(rows[0])
      } catch (e) {
        console.error('PATCH /api/students/:id :', e)
        res.status(500).json({ message: 'Erreur serveur' })
      }
    })

    app.use('/api/students', studentsRouter)

    // ─────────────────────────────────────────────────────────────
    // CLASS STUDENT WEEKDAY (jour specifique par eleve par classe)
    // ─────────────────────────────────────────────────────────────

    app.put('/api/class-student-weekday', authenticateToken, authorizeRoles('prof', 'admin'), ensureClassAccess, async (req, res) => {
      try {
        const { class_id, student_id, weekday } = req.body
        if (!class_id || !student_id || !weekday) {
          return res.status(400).json({ message: 'class_id, student_id et weekday requis' })
        }
        const iso = Number(weekday)
        if (iso < 1 || iso > 7) return res.status(400).json({ message: 'weekday invalide (1-7)' })
        await pool.query(
          `INSERT INTO class_student_weekday (class_id, student_id, weekday)
          VALUES ($1, $2, $3)
          ON CONFLICT (class_id, student_id) DO UPDATE SET weekday = $3`,
          [Number(class_id), Number(student_id), iso],
        )
        await ensureSessionsForWeekday(Number(class_id), iso)
        res.json({ class_id, student_id, weekday: iso })
      } catch (e) {
        console.error('PUT /api/class-student-weekday :', e)
        res.status(500).json({ message: 'Erreur serveur' })
      }
    })

    app.delete('/api/class-student-weekday', authenticateToken, authorizeRoles('prof', 'admin'), ensureClassAccess, async (req, res) => {
      try {
        const { class_id, student_id } = req.query
        if (!class_id || !student_id) {
          return res.status(400).json({ message: 'class_id et student_id requis' })
        }
        await pool.query(
          'DELETE FROM class_student_weekday WHERE class_id = $1 AND student_id = $2',
          [Number(class_id), Number(student_id)],
        )
        res.status(204).end()
      } catch (e) {
        console.error('DELETE /api/class-student-weekday :', e)
        res.status(500).json({ message: 'Erreur serveur' })
      }
    })

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
            `SELECT s.id, to_char(s.date,'YYYY-MM-DD') AS date, s.status, s.note
            FROM sessions s
            JOIN school_years sy ON sy.id = s.school_year_id AND sy.is_current = true
            WHERE s.class_id = $1
            ORDER BY s.date`,
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

          // La lecture des séances joint school_years sur is_current : sans
          // school_year_id, la séance extra était créée mais restait invisible
          // dans la matrice comme dans les statistiques.
          const { rows: cy } = await pool.query(
            'SELECT id FROM school_years WHERE is_current = true LIMIT 1',
          )
          if (!cy.length) {
            return res.status(409).json({ message: 'Aucune année scolaire active' })
          }

          const { rows } = await pool.query(
            `INSERT INTO sessions (class_id, date, status, note, school_year_id)
            VALUES ($1, $2::date, 'extra', $3, $4)
            ON CONFLICT (class_id, date) DO NOTHING
            RETURNING id, to_char(date,'YYYY-MM-DD') AS date, status, note`,
            [classId, date, note ?? null, cy[0].id],
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

    // Note : la table periodes_exclues n'est plus utilisée. Les périodes non
    // pointables sont désormais portées par sessions.status (vacation/holiday/
    // cancelled), posé manuellement depuis la matrice. La table subsiste en base
    // mais n'est plus ni lue ni alimentée.

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
    // RAPPELS PUSH — logique extraite pour cron + endpoint HTTP
    // ─────────────────────────────────────────────────────────────
    async function sendReminders() {
      if (!process.env.VAPID_PUBLIC_KEY) {
        console.warn('[reminders] VAPID non configuré — envoi ignoré')
        return { sent: 0, skipped: 'vapid_missing' }
      }

      const jsDay = new Date().getDay()
      const isoDay = jsDay === 0 ? 7 : jsDay

      // Récupère les profs avec une classe aujourd'hui dont le pointage n'est pas encore commencé
      // (au moins 1 présence en base = classe ignorée)
      const { rows: profs } = await pool.query(`
        SELECT t.user_id, u.username, array_agg(DISTINCT t.nom ORDER BY t.nom) AS class_names
        FROM (
          SELECT c.user_id, c.nom, c.id AS class_id FROM classes c WHERE c.weekday = $1
          UNION ALL
          SELECT cu.user_id, c.nom, c.id AS class_id
          FROM classes c JOIN class_users cu ON cu.class_id = c.id
          WHERE c.weekday = $1
        ) t
        JOIN users u ON u.id = t.user_id
        WHERE NOT EXISTS (
          SELECT 1 FROM sessions s
          JOIN attendances a ON a.session_id = s.id
          WHERE s.class_id = t.class_id
            AND s.date = CURRENT_DATE
        )
        GROUP BY t.user_id, u.username
      `, [isoDay])

      let sent = 0
      for (const prof of profs) {
        const { rows: subs } = await pool.query(
          'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
          [prof.user_id],
        )
        const classNames = prof.class_names
        const isSingle = classNames.length === 1
        const prenom = prof.username

        const title = 'Rappel pointage 🎵'
        const body = isSingle
          ? `Bonjour ${prenom}, n'oubliez pas de faire le pointage de votre classe ${classNames[0]} aujourd'hui !`
          : `Bonjour ${prenom}, vous avez ${classNames.length} classes à pointer aujourd'hui : ${classNames.join(', ')}.`

        const payload = JSON.stringify({ title, body, url: '/classes' })
        for (const sub of subs) {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
          ).catch(async (err) => {
            if (err.statusCode === 410) {
              await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint])
            }
          })
          sent++
        }
      }
      console.log(`[reminders] ${sent} notification(s) envoyée(s) — ${profs.length} prof(s) concerné(s)`)
      return { sent, profs: profs.length }
    }

    // CRON — rappel à 12h (Europe/Paris), fallback si Passenger est actif
    cron.schedule('0 12 * * *', () => {
      sendReminders().catch(e => console.error('[cron] erreur rappel :', e))
    }, { timezone: 'Europe/Paris' })

    app.listen(PORT, () => {
      console.log(`Serveur démarré sur le port ${PORT}`)
    })
    pool.query(`
      ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS school_year_id INTEGER REFERENCES school_years(id) ON DELETE SET NULL
    `).catch(e => console.error('[migration] dossiers.school_year_id :', e))
    initPushSubscriptions().catch(e => console.error('[init] push_subscriptions :', e))