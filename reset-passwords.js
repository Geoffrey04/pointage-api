/**
 * Script de réinitialisation des mots de passe
 * Usage : node reset-passwords.js
 * Génère un mot de passe temporaire pour chaque utilisateur (sauf IDs exclus),
 * met à jour la BDD et affiche le tableau clair username → mot de passe.
 */

const EXCLUDED_IDS = [4, 8] // admin + Geoffrey, déjà connus

let bcrypt
try {
  bcrypt = require('bcryptjs')
} catch {
  const path = require('path')
  bcrypt = require(path.join(process.env.EXTRA_NODE_PATH || '', 'bcryptjs'))
}

const pool = require('./db')

function generatePassword(username) {
  const base = (username || 'Cours').charAt(0).toUpperCase() + (username || 'Cours').slice(1)
  const rand = Math.floor(1000 + Math.random() * 9000)
  return `${base}${rand}!`
}

async function run() {
  const placeholders = EXCLUDED_IDS.map((_, i) => `$${i + 1}`).join(', ')
  const { rows: users } = await pool.query(
    `SELECT id, username FROM users WHERE id NOT IN (${placeholders}) ORDER BY username`,
    EXCLUDED_IDS,
  )

  if (users.length === 0) {
    console.log('Aucun utilisateur à réinitialiser.')
    process.exit(0)
  }

  console.log(`\nRéinitialisation de ${users.length} compte(s)...\n`)

  const results = []
  for (const u of users) {
    const plain = generatePassword(u.username)
    const hash = bcrypt.hashSync(plain, 10)
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, u.id])
    results.push({ id: u.id, username: u.username, password: plain })
  }

  console.log('┌────┬──────────────────────────┬──────────────────────┐')
  console.log('│ ID │ Utilisateur              │ Mot de passe temp.   │')
  console.log('├────┼──────────────────────────┼──────────────────────┤')
  for (const r of results) {
    const id = String(r.id).padEnd(2)
    const user = r.username.padEnd(24)
    const pwd = r.password.padEnd(20)
    console.log(`│ ${id} │ ${user} │ ${pwd} │`)
  }
  console.log('└────┴──────────────────────────┴──────────────────────┘')
  console.log('\nCommuniquez ces mots de passe aux profs — ils pourront les changer ensuite.\n')

  process.exit(0)
}

run().catch((e) => {
  console.error('Erreur :', e.message)
  process.exit(1)
})
