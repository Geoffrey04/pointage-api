// db.js — Neon serverless via HTTPS/443 pour mutualisé
const { Pool, neonConfig } = require('@neondatabase/serverless');
const WebSocket = require('ws');

// Indique au driver quelle implémentation WebSocket utiliser en Node
neonConfig.webSocketConstructor = WebSocket;
neonConfig.useSecureWebSocket = true;   // wss://
neonConfig.pipelineTLS = true;          // perf/stabilité en Node
// neonConfig.fetchConnectionCache = true; // plus nécessaire, désormais implicite

module.exports = new Pool({
  // ⚠️ DATABASE_URL doit pointer sur l’hôte Neon **sans `-pooler`**
  // ex: postgres://user:pass@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require
  connectionString: process.env.DATABASE_URL,
});
