// db.js — Neon serverless via HTTPS/443
const { Pool, neonConfig } = require('@neondatabase/serverless');
neonConfig.fetchConnectionCache = true;

module.exports = new Pool({
  // ⚠️ utilisera DATABASE_URL sans "-pooler"
  connectionString: process.env.DATABASE_URL,
});
