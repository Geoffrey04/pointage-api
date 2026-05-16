require('dotenv').config()
const pool = require('../db')

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dossiers (
      id            SERIAL PRIMARY KEY,
      type          VARCHAR(20) NOT NULL CHECK (type IN ('inscription', 'reinscription')),
      nom_eleve     VARCHAR(100) NOT NULL,
      prenom_eleve  VARCHAR(100) NOT NULL,
      submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      pdf_filename  VARCHAR(255) NOT NULL
    )
  `)
  console.log('Table dossiers créée (ou déjà existante).')
  await pool.end()
}

migrate().catch((e) => { console.error(e); process.exit(1) })