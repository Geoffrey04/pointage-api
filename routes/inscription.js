const express = require('express')
const path = require('path')
const fs = require('fs')
const { generateDossierPDF } = require('../pdfGenerator')
const { sendDossierEmail } = require('../mailer')
const pool = require('../db')

const router = express.Router()
const UPLOADS = path.join(__dirname, '..', 'uploads', 'dossiers')
fs.mkdirSync(UPLOADS, { recursive: true })

const INSTRUMENTS_ALLOWED = new Set([
  'Hautbois', 'Flûte traversère', 'Clarinette',
  'Saxophone', 'Trompette', "Cor d'harmonie",
  'Trombone', 'Euphonium/Basse', 'Percussion',
])

const DUREES_ALLOWED = new Set([
  "Moins d'1 an", '1 an', '2 ans', '3 à 5 ans', 'Plus de 5 ans',
])

// Tronque et nettoie une valeur texte
function str(v, max = 200) {
  if (v === null || v === undefined) return ''
  return String(v).trim().slice(0, max)
}

function validEmail(v) {
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,64}$/.test(String(v || ''))
}

function validPhone(v) {
  if (!v || !String(v).trim()) return true
  const d = String(v).replace(/[\s.\-]/g, '').replace(/^\+33/, '0')
  return /^0[1-9]\d{8}$/.test(d)
}

function validDate(v) {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(String(v || ''))
}

// POST /api/public/inscription
router.post('/inscription', async (req, res) => {
  const { type, eleve, parents, parents2, antecedents, instruments, observations, avis,
          autorisationImage, faita, signataire, signature } = req.body

  // --- Validation ---

  if (!['inscription', 'reinscription'].includes(type)) {
    return res.status(400).json({ message: 'Type invalide.' })
  }

  if (!eleve || typeof eleve !== 'object') {
    return res.status(400).json({ message: "Données élève invalides." })
  }
  if (!str(eleve.nom) || !str(eleve.prenom)) {
    return res.status(400).json({ message: "Nom et prénom de l'élève requis." })
  }

  if (!parents || typeof parents !== 'object') {
    return res.status(400).json({ message: 'Données parents invalides.' })
  }
  if (parents.email && !validEmail(parents.email)) {
    return res.status(400).json({ message: 'Email invalide.' })
  }
  if (!validPhone(parents.telephone)) {
    return res.status(400).json({ message: 'Numéro de téléphone invalide.' })
  }
  if (parents2 && !validPhone(parents2.telephone)) {
    return res.status(400).json({ message: 'Numéro de téléphone (2ème adresse) invalide.' })
  }
  if (parents2 && parents2.email && !validEmail(parents2.email)) {
    return res.status(400).json({ message: 'Email (2ème adresse) invalide.' })
  }

  if (type === 'inscription' && instruments !== undefined) {
    if (!Array.isArray(instruments)) {
      return res.status(400).json({ message: 'Format instruments invalide.' })
    }
    for (const instr of instruments) {
      if (!INSTRUMENTS_ALLOWED.has(instr)) {
        return res.status(400).json({ message: 'Instrument non reconnu.' })
      }
    }
  }

  if (!str(signataire)) {
    return res.status(400).json({ message: 'Nom du signataire requis.' })
  }
  if (!str(faita)) {
    return res.status(400).json({ message: 'Ville requise.' })
  }

  if (signature !== null && signature !== undefined) {
    if (typeof signature !== 'string' || !signature.startsWith('data:image/png;base64,')) {
      return res.status(400).json({ message: 'Format de signature invalide.' })
    }
    if (signature.length > 500_000) {
      return res.status(400).json({ message: 'Signature trop grande.' })
    }
  }

  // --- Sanitisation ---

  const safeEleve = {
    nom:           str(eleve.nom, 100),
    prenom:        str(eleve.prenom, 100),
    dateNaissance: validDate(eleve.dateNaissance) ? str(eleve.dateNaissance, 10) : '',
    lieuNaissance: str(eleve.lieuNaissance, 100),
  }

  const safeParents = {
    pere:          str(parents.pere, 150),
    mere:          str(parents.mere, 150),
    adresseNumero: str(parents.adresseNumero, 10),
    adresseRue:    str(parents.adresseRue, 150),
    codePostal:    str(parents.codePostal, 10),
    ville:         str(parents.ville, 100),
    telephone:     str(parents.telephone, 20),
    email:         str(parents.email, 150),
  }

  const safeParents2 = parents2 ? {
    referent:      ['pere', 'mere'].includes(parents2.referent) ? parents2.referent : 'pere',
    adresseNumero: str(parents2.adresseNumero, 10),
    adresseRue:    str(parents2.adresseRue, 150),
    codePostal:    str(parents2.codePostal, 10),
    ville:         str(parents2.ville, 100),
    telephone:     str(parents2.telephone, 20),
    email:         str(parents2.email, 150),
  } : null

  const safeAntecedents = antecedents && typeof antecedents === 'object' ? {
    formationOui:      !!antecedents.formationOui,
    formationDuree:    DUREES_ALLOWED.has(antecedents.formationDuree) ? antecedents.formationDuree : '',
    formationEndroit:  str(antecedents.formationEndroit, 100),
    instrumentOui:     !!antecedents.instrumentOui,
    instrumentNom:     INSTRUMENTS_ALLOWED.has(antecedents.instrumentNom) ? antecedents.instrumentNom : '',
    instrumentDuree:   DUREES_ALLOWED.has(antecedents.instrumentDuree) ? antecedents.instrumentDuree : '',
    instrumentEndroit: str(antecedents.instrumentEndroit, 100),
  } : {}

  const safeObservations = observations && typeof observations === 'object' ? {
    autresActivitesOui:     !!observations.autresActivitesOui,
    autresActivitesDetail:  str(observations.autresActivitesDetail, 200),
    autresActivitesEndroit: str(observations.autresActivitesEndroit, 200),
    complement:             str(observations.complement, 1000),
  } : {}

  const data = {
    eleve:            safeEleve,
    parents:          safeParents,
    parents2:         safeParents2,
    antecedents:      safeAntecedents,
    instruments:      Array.isArray(instruments)
                        ? instruments.filter(i => INSTRUMENTS_ALLOWED.has(i))
                        : [],
    observations:     safeObservations,
    avis:             str(avis, 2000),
    autorisationImage: !!autorisationImage,
    faita:            str(faita, 100),
    signataire:       str(signataire, 150),
    signature:        signature || null,
    dateAcceptation:  new Date().toLocaleDateString('fr-FR'),
  }

  const filename = `dossier-${type}-${Date.now()}.pdf`
  const outputPath = path.join(UPLOADS, filename)

  try {
    await generateDossierPDF(outputPath, type, data)

    const { rows } = await pool.query(
      `INSERT INTO dossiers (type, nom_eleve, prenom_eleve, pdf_filename)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [type, safeEleve.nom, safeEleve.prenom, filename],
    )

    sendDossierEmail(type, safeEleve.nom, safeEleve.prenom, outputPath).catch((e) =>
      console.error('[mailer] échec envoi email dossier :', e.message),
    )

    res.json({ success: true, id: rows[0].id })
  } catch (e) {
    console.error('[inscription] erreur :', e)
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath)
    res.status(500).json({ message: 'Erreur lors de la création du dossier.' })
  }
})

module.exports = router