/**
 * Inventaire des PDF de dossiers présents sur le disque.
 * Usage : node list-orphan-pdfs.js
 *
 * CE SCRIPT NE SUPPRIME RIEN. Il se contente de comparer le contenu de
 * uploads/dossiers avec la colonne dossiers.pdf_filename et d'afficher le
 * résultat. Les fichiers "orphelins" (sans ligne en base) proviennent en
 * général d'échecs de génération ou de dossiers supprimés — mais vérifiez
 * toujours la liste avant d'envisager quoi que ce soit : ces PDF sont des
 * pièces signées par un responsable légal.
 */

const fs = require('fs')
const path = require('path')
const pool = require('./db')

const UPLOADS = path.join(__dirname, 'uploads', 'dossiers')

function human(bytes) {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

async function run() {
  if (!fs.existsSync(UPLOADS)) {
    console.log(`Dossier introuvable : ${UPLOADS}`)
    process.exit(0)
  }

  const files = fs.readdirSync(UPLOADS).filter((f) => f.toLowerCase().endsWith('.pdf'))

  const { rows } = await pool.query(
    'SELECT id, pdf_filename, nom_eleve, prenom_eleve, status FROM dossiers WHERE pdf_filename IS NOT NULL',
  )
  const referenced = new Map(rows.map((r) => [r.pdf_filename, r]))

  const orphans = files.filter((f) => !referenced.has(f))
  const missing = rows.filter((r) => !files.includes(r.pdf_filename))

  let orphanBytes = 0
  for (const f of orphans) {
    orphanBytes += fs.statSync(path.join(UPLOADS, f)).size
  }

  console.log('')
  console.log(`Fichiers PDF sur le disque   : ${files.length}`)
  console.log(`Référencés en base           : ${referenced.size}`)
  console.log(`Orphelins (sans ligne en BDD): ${orphans.length}  (${human(orphanBytes)})`)
  console.log('')

  if (orphans.length) {
    console.log('--- Orphelins ---')
    for (const f of orphans) {
      const { size, mtime } = fs.statSync(path.join(UPLOADS, f))
      console.log(`  ${f}  ${human(size).padStart(9)}  ${mtime.toISOString().slice(0, 10)}`)
    }
    console.log('')
    console.log('Aucune suppression n\'a été effectuée. Examinez cette liste avant toute action.')
    console.log('')
  }

  if (missing.length) {
    console.log('--- Dossiers en base dont le PDF est ABSENT du disque ---')
    console.log('(à traiter en priorité : la pièce signée manque)')
    for (const r of missing) {
      console.log(`  dossier #${r.id}  ${r.prenom_eleve} ${r.nom_eleve}  [${r.status}]  -> ${r.pdf_filename}`)
    }
    console.log('')
  }

  process.exit(0)
}

run().catch((e) => {
  console.error('Erreur :', e.message)
  process.exit(1)
})
