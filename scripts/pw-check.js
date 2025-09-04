// scripts/pw-check.js
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt'); // ou 'bcryptjs'

const [,, identifier, plain] = process.argv;
if (!identifier || !plain) {
  console.error('Usage: node scripts/pw-check.js <email|username|id> <plainPassword>');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

(async () => {
  try {
    const q = `
      SELECT id, email, COALESCE(username, '') AS username, password
      FROM users
      WHERE email = $1 OR username = $1 OR CAST(id AS TEXT) = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(q, [identifier]);
    if (rows.length === 0) {
      console.log('❌ Utilisateur introuvable');
      process.exit(2);
    }
    const user = rows[0];
    const ok = await bcrypt.compare(plain, user.password);
    console.log(ok ? `✅ Mot de passe OK pour ${user.email || user.username || user.id}` : '❌ Mot de passe incorrect');
  } catch (e) {
    console.error('Erreur:', e.message);
    process.exit(3);
  } finally {
    await pool.end();
  }
})();
