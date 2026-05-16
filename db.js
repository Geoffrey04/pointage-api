// db.js — Neon via HTTP avec fetch=node-fetch v2, format pg.Pool#query

try { require('dotenv').config(); } catch {}

let usingNodeFetch = false;
try {
  // node-fetch v2 (installé en local: npm i node-fetch@2 --save)
  const nf = require('node-fetch');
  globalThis.fetch = nf;
  // expose aussi les classes, certaines libs les lisent depuis globalThis
  globalThis.Headers = nf.Headers;
  globalThis.Request = nf.Request;
  globalThis.Response = nf.Response;
  usingNodeFetch = true;
  console.log('[db] fetch -> node-fetch v2');
} catch (_e) {
  console.warn('[db] ⚠️ node-fetch v2 introuvable → fallback fetch natif (Undici)');
}

// IPv4 d’abord (souvent utile en mutualisé)
try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}

const { neon, neonConfig } = require('@neondatabase/serverless');
// Supprimer cette ligne dépréciée - maintenant toujours true
// neonConfig.fetchConnectionCache = true;

// URL DB depuis .env, SANS le host "-pooler."
const raw = process.env.DATABASE_URL || '';
if (!raw) throw new Error('DATABASE_URL manquante dans .env');
const connectionString = raw.replace(/-pooler\./, '.');

// Client Neon (tag template + méthodes .query / .unsafe)
const sql = neon(connectionString);

/**
 * query(text, params?) → { rows, rowCount }
 * Retour strictement compatible pg.Pool#query
 */
async function query(text, params = []) {
  try {
    const res = (params && params.length)
      ? await sql.query(text, params)
      : await sql.query(text);

    // Normalisation quel que soit le shape renvoyé par @neondatabase/serverless
    const rows = Array.isArray(res) ? res : (res && res.rows) ? res.rows : [];
    const rowCount = (res && typeof res.rowCount === 'number')
      ? res.rowCount
      : rows.length;

    return { rows, rowCount };
  } catch (err) {
    if (!usingNodeFetch) {
      console.error('[db] HTTP via Undici a échoué:', err && err.message);
    }
    throw err;
  }
}

// Compat "pool-like" attendue par server.js
async function end() {}    // no-op en HTTP
function on() {}           // no-op (pour pool.on('error', ...))

module.exports = { query, end, on };
