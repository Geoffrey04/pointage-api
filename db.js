// db.js — Neon serverless via HTTPS (pas de WebSocket), API type pg.Pool

try { require('dotenv').config(); } catch {}

const { Pool, neonConfig } = require('@neondatabase/serverless');

// Évite le WS: force le mode fetch pour chaque requête du Pool (HTTPS/443)
neonConfig.poolQueryViaFetch = true;

// Cache des connexions HTTP pour éviter la latence de handshake à chaque requête
neonConfig.fetchConnectionCache = true;

// Si jamais le runtime a besoin d'un WS (rare avec la ligne ci-dessus), on fournit 'ws'
try { neonConfig.webSocketConstructor = require('ws'); } catch {}

// Prioriser IPv4 (souvent nécessaire en hébergement mutualisé)
try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}

// Prépare la chaîne de connexion (sans -pooler. pour Neon serverless)
const raw = process.env.DATABASE_URL || '';
if (!raw) throw new Error('DATABASE_URL manquante. Définis-la dans .env.');
const connectionString = raw.replace(/-pooler\./, '.');

// Pool compatible pg
const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_MAX || 5),
  idleTimeoutMillis: Number(process.env.PG_IDLE || 30_000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT || 8_000),
});

// Logs utiles si Neon remonte une erreur
if (typeof pool.on === 'function') {
  pool.on('error', (err) => console.error('[pg] Pool error:', err));
}

module.exports = pool;
