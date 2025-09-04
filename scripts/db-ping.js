// scripts/db-ping.js
require('dotenv').config();
const pool = require('../db');

(async () => {
  try {
    const { rows } = await pool.query(`select current_user, now(), version()`);
    console.log('DB OK:', rows[0]);
  } catch (e) {
    console.error('DB ERROR:', e.message);
  } finally {
    await pool.end();
  }
})();
