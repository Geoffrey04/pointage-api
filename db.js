// db.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // URL Neon AVEC -pooler
  ssl: { rejectUnauthorized: false },
});

module.exports = pool;
