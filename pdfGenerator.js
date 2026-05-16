const PDFDocument = require('pdfkit')
const fs = require('fs')
const path = require('path')

const ASSETS = path.join(__dirname, 'assets', 'dossiers')


// ─── Page 1 : Fiche de renseignements ───────────────────────────

function addFicheInscription(doc, data) {
  doc.addPage()
  const L = 50, W = doc.page.width - 100

  doc.fontSize(16).font('Helvetica-Bold')
     .text('FICHE DE RENSEIGNEMENTS', L, 40, { align: 'center', width: W })
  doc.moveDown(1)

  // Etat civil
  section(doc, L, doc.y, W, "Etat civil de l'eleve")
  let y = doc.y + 8
  field(doc, L + 8, y,         'Nom',               data.eleve.nom)
  field(doc, L + 8 + W / 2, y, 'Prenom',            data.eleve.prenom)
  y += 24
  field(doc, L + 8, y,         'Date de naissance', data.eleve.dateNaissance)
  field(doc, L + 8 + W / 2, y, 'Lieu de naissance', data.eleve.lieuNaissance)
  doc.y = y + 30

  // Coordonnees
  section(doc, L, doc.y, W, 'Coordonnees')
  y = doc.y + 8
  field(doc, L + 8, y,   'Pere / Tuteur legal',   data.parents.pere, W - 16); y += 24
  field(doc, L + 8, y,   'Mere / Tutrice legale', data.parents.mere, W - 16); y += 24
  field(doc, L + 8, y,   'N',   data.parents.adresseNumero, 40)
  field(doc, L + 70, y,  'Rue', data.parents.adresseRue, W - 90); y += 24
  field(doc, L + 8, y,   'Code postal', data.parents.codePostal, 80)
  field(doc, L + 110, y, 'Ville',       data.parents.ville, 120); y += 24
  field(doc, L + 8, y,   'Telephone',   data.parents.telephone, 120)
  field(doc, L + 160, y, 'Email',       data.parents.email, W - 180)
  doc.y = y + 30

  // 2eme adresse
  if (data.parents2 && data.parents2.adresseRue) {
    section(doc, L, doc.y, W, data.parents2.referent === 'mere' ? 'Adresse de la mere / tutrice legale' : 'Adresse du pere / tuteur legal')
    y = doc.y + 8
    field(doc, L + 8, y,   'N',   data.parents2.adresseNumero, 40)
    field(doc, L + 70, y,  'Rue', data.parents2.adresseRue, W - 90); y += 24
    field(doc, L + 8, y,   'Code postal', data.parents2.codePostal, 80)
    field(doc, L + 110, y, 'Ville',       data.parents2.ville, 120); y += 24
    field(doc, L + 8, y,   'Telephone', data.parents2.telephone, 120)
    field(doc, L + 160, y, 'Email',     data.parents2.email, W - 180)
    doc.y = y + 30
  }

  // Antecedents musicaux
  section(doc, L, doc.y, W, 'Antecedents musicaux')
  y = doc.y + 8
  yesNoField(doc, L + 8, y, 'A deja suivi une formation musicale', data.antecedents.formationOui)
  if (data.antecedents.formationOui) {
    field(doc, L + 28, y + 18, 'Duree',   data.antecedents.formationDuree, 80)
    field(doc, L + 140, y + 18, 'Endroit', data.antecedents.formationEndroit, 100)
    y += 42
  } else { y += 22 }
  yesNoField(doc, L + 8, y, 'A deja pratique un instrument', data.antecedents.instrumentOui)
  if (data.antecedents.instrumentOui) {
    field(doc, L + 28, y + 18, 'Instrument', data.antecedents.instrumentNom, 80)
    field(doc, L + 140, y + 18, 'Duree',     data.antecedents.instrumentDuree, 60)
    field(doc, L + 230, y + 18, 'Endroit',   data.antecedents.instrumentEndroit, 80)
    y += 42
  } else { y += 22 }
  doc.y = y + 8

  // Instruments par ordre de preference
  section(doc, L, doc.y, W, 'Instrument(s) souhaite(s)')
  const yInstr = doc.y + 8
  const prefs = data.instruments || []
  prefs.forEach((instr, i) => {
    doc.fontSize(10).font('Helvetica')
       .text(`${i + 1}. ${instr}`, L + 8 + (i % 3) * (W / 3), yInstr + Math.floor(i / 3) * 18,
             { lineBreak: false })
  })
  doc.y = yInstr + (prefs.length ? Math.ceil(prefs.length / 3) * 18 : 18) + 10

  // Observations
  section(doc, L, doc.y, W, 'Observations diverses')
  y = doc.y + 8
  yesNoField(doc, L + 8, y, "Inscrit a d'autres activites", data.observations.autresActivitesOui)
  if (data.observations.autresActivitesOui) {
    const acts = data.observations.autresActivites || []
    acts.forEach((a, i) => {
      field(doc, L + 28,  y + 18 + i * 22, 'Activite', a.activite, 100)
      field(doc, L + 160, y + 18 + i * 22, 'Endroit',  a.endroit,  100)
    })
    y += 18 + (acts.length || 1) * 22 + 4
  } else { y += 22 }
  field(doc, L + 8, y, 'Informations complementaires', data.observations.complement, W - 16)
  doc.y = y + 30

  signatureBlock(doc, L, doc.y, data)
}

function addFicheReinscription(doc, data) {
  doc.addPage()
  const L = 50, W = doc.page.width - 100

  doc.fontSize(16).font('Helvetica-Bold')
     .text('FICHE DE RENSEIGNEMENTS', L, 40, { align: 'center', width: W })
  doc.moveDown(1)

  section(doc, L, doc.y, W, "Etat civil de l'eleve")
  let y = doc.y + 8
  field(doc, L + 8, y,         'Nom',               data.eleve.nom)
  field(doc, L + 8 + W / 2, y, 'Prenom',            data.eleve.prenom)
  y += 24
  field(doc, L + 8, y,         'Date de naissance', data.eleve.dateNaissance)
  field(doc, L + 8 + W / 2, y, 'Lieu de naissance', data.eleve.lieuNaissance)
  doc.y = y + 30

  section(doc, L, doc.y, W, 'Coordonnees')
  y = doc.y + 8
  field(doc, L + 8, y,   'Pere / Tuteur legal',   data.parents.pere, W - 16); y += 24
  field(doc, L + 8, y,   'Mere / Tutrice legale', data.parents.mere, W - 16); y += 24
  field(doc, L + 8, y,   'N',   data.parents.adresseNumero, 40)
  field(doc, L + 70, y,  'Rue', data.parents.adresseRue, W - 90); y += 24
  field(doc, L + 8, y,   'Code postal', data.parents.codePostal, 80)
  field(doc, L + 110, y, 'Ville',       data.parents.ville, 120); y += 24
  field(doc, L + 8, y,   'Telephone',   data.parents.telephone, 120)
  field(doc, L + 160, y, 'Email',       data.parents.email, W - 180)
  doc.y = y + 30

  if (data.parents2 && data.parents2.adresseRue) {
    section(doc, L, doc.y, W, data.parents2.referent === 'mere' ? 'Adresse de la mere / tutrice legale' : 'Adresse du pere / tuteur legal')
    y = doc.y + 8
    field(doc, L + 8, y,   'N',   data.parents2.adresseNumero, 40)
    field(doc, L + 70, y,  'Rue', data.parents2.adresseRue, W - 90); y += 24
    field(doc, L + 8, y,   'Code postal', data.parents2.codePostal, 80)
    field(doc, L + 110, y, 'Ville',       data.parents2.ville, 120); y += 24
    field(doc, L + 8, y,   'Telephone', data.parents2.telephone, 120)
    field(doc, L + 160, y, 'Email',     data.parents2.email, W - 180)
    doc.y = y + 30
  }

  section(doc, L, doc.y, W, 'Votre avis nous interesse !')
  const yAvis = doc.y + 8
  doc.fontSize(10).font('Helvetica-Oblique')
     .text('Commentaires, attentes et nouvelles idees :', L + 8, yAvis)
  doc.fontSize(10).font('Helvetica')
     .text(data.avis || '', L + 8, yAvis + 14, { width: W - 16 })
  doc.y = Math.max(doc.y, yAvis + 80) + 10

  signatureBlock(doc, L, doc.y, data)
}

// ─── Page 2 : Règlement intérieur (image + overlay) ─────────────

function addReglement(doc, data) {
  const file = path.join(ASSETS, 'reglement.png')
  doc.addPage()
  if (fs.existsSync(file)) {
    doc.image(file, 0, 0, { width: doc.page.width, height: doc.page.height })
  } else {
    console.warn('[pdf] reglement.png manquant')
    doc.fontSize(12).fillColor('black').text('[Reglement manquant]', 72, 72)
    return
  }

  // Masque le bas de page original et redessine un bloc signature propre
  const CUT_Y = 718
  doc.save()
  doc.rect(0, CUT_Y, doc.page.width, doc.page.height - CUT_Y).fill('white')
  doc.restore()

  const L = 50, W = doc.page.width - 100
  doc.moveTo(L, CUT_Y + 4).lineTo(L + W, CUT_Y + 4).stroke('#aaa')

  doc.fillColor('black').fontSize(9).font('Helvetica-Bold')
     .text("Nom de l'eleve : ", L, CUT_Y + 10, { continued: true, lineBreak: false })
  doc.font('Helvetica').text(`${data.eleve.prenom} ${data.eleve.nom}`, { lineBreak: false })

  doc.font('Helvetica').text('Fait a : ', L, CUT_Y + 28, { continued: true, lineBreak: false })
  doc.font('Helvetica-Bold').text(data.faita, { lineBreak: false })

  doc.font('Helvetica').text('Date : ', L, CUT_Y + 44, { continued: true, lineBreak: false })
  doc.font('Helvetica-Bold').text(data.dateAcceptation, { lineBreak: false })

  doc.font('Helvetica-Oblique').fontSize(8).fillColor('#333')
     .text('Signature des parents precedee de la mention "lu et approuve"', L + 200, CUT_Y + 28,
           { width: 240, lineBreak: false })
  doc.fontSize(10)
     .text('Lu et approuve', L + 200, CUT_Y + 42, { lineBreak: false })
  doc.fillColor('black')

  embedSignature(doc, data.signature, L + 200, CUT_Y + 58, 180, 55)
}

// ─── Page 3 : Autorisation à l'image (générée avec PDFKit) ─────────

function addAutorisationImage(doc, data) {
  doc.addPage()
  const L = 50, W = doc.page.width - 100

  // Titre
  doc.fontSize(14).font('Helvetica-Bold').fillColor('black')
     .text('AUTORISATION DE PRISES DE VUES', L, 36, { align: 'center', width: W })
     .text('ET DE DIFFUSION D\'IMAGES', L, 56, { align: 'center', width: W })

  doc.moveTo(L, 76).lineTo(L + W, 76).stroke('#888')
  doc.fontSize(10).font('Helvetica-Oblique').fillColor('#444')
     .text('Harmonie Communale de Marpent — Ecole de Musique', L, 82, { align: 'center', width: W })
  doc.moveTo(L, 100).lineTo(L + W, 100).stroke('#ddd')

  // Corps du texte
  doc.fillColor('black').font('Helvetica').fontSize(9.5)
  let y = 112
  const body = [
    'De nombreuses activites conduisent notre etablissement a realiser des photographies ou des ' +
    'videos sur lesquelles apparaissent les eleves (journal, concerts, spectacles, cours, activites ' +
    'et sorties pedagogiques, etc.).',
    "L'ecole de musique peut egalement etre sollicitee par la presse.",
    "Il ne s'agit pas de photographies individuelles d'identite mais de photos de groupe ou bien " +
    "de vues montrant votre enfant en activite.",
    "La loi relative au droit a l'image oblige l'etablissement a demander une autorisation ecrite " +
    "au responsable legal de l'enfant pour la prise de vue et la diffusion de ces prises de vue.",
    "Un refus de votre part aura pour consequence, soit d'eloigner votre enfant lors des prises " +
    "de vue, soit de masquer son visage.",
  ]
  body.forEach((para) => {
    doc.text(para, L, y, { width: W })
    y = doc.y + 7
  })

  // Zone formulaire
  y += 8
  const boxH = 148
  doc.rect(L, y, W, boxH).stroke('#333')

  const bL = L + 12
  const bW = W - 24
  let by = y + 14

  doc.font('Helvetica').fontSize(10)
     .text('Je soussigne(e) : ', bL, by, { continued: true })
     .font('Helvetica-Bold').text(data.signataire, { width: bW, lineBreak: false })
  by += 22

  doc.font('Helvetica')
     .text("Representant legal de l'enfant : ", bL, by, { continued: true })
     .font('Helvetica-Bold').text(`${data.eleve.prenom} ${data.eleve.nom}`, { width: bW, lineBreak: false })
  by += 26

  if (data.autorisationImage) {
    doc.font('Helvetica-Bold').fillColor('#1a7f1a').fontSize(10)
       .text('AUTORISE', bL, by, { continued: true })
    doc.fillColor('black').font('Helvetica')
       .text(' la prise de vues et la diffusion de ces images, dans le but de promouvoir les', { width: bW })
    by = doc.y
    doc.text("activites de l'ecole de musique ou de l'harmonie.", bL, by, { width: bW })
  } else {
    doc.font('Helvetica-Bold').fillColor('#cc0000').fontSize(10)
       .text("N'AUTORISE PAS", bL, by, { continued: true })
    doc.fillColor('black').font('Helvetica')
       .text(" l'utilisation de photographies et/ou videos lors des activites de l'ecole de musique.", { width: bW })
  }

  doc.fillColor('black').fontSize(9).font('Helvetica')
     .text(`Fait a ${data.faita}, le ${data.dateAcceptation}`, bL, y + boxH - 24, { width: bW })

  // Ligne de signature
  const sigY = y + boxH + 18
  doc.fontSize(9).font('Helvetica').fillColor('black')
     .text('Signature du responsable legal :', L, sigY, { lineBreak: false })
  embedSignature(doc, data.signature, L + 168, sigY - 10, 180, 55)
  doc.moveTo(L + 168, sigY + 50).lineTo(L + W, sigY + 50).stroke('#999')
}

// ─── Helpers ────────────────────────────────────────────────────

function section(doc, x, y, w, title) {
  doc.rect(x, y, w, 18).stroke()
  doc.fontSize(9).font('Helvetica-Bold').fillColor('black')
     .text(title, x + 4, y + 4, { width: w - 8, lineBreak: false })
  doc.y = y + 18
}

function field(doc, x, y, label, value, width) {
  doc.fontSize(9).font('Helvetica-Bold').fillColor('black')
     .text(`${label} : `, x, y, { continued: true, lineBreak: false })
  doc.font('Helvetica')
     .text(value || '', { width: width || 120, lineBreak: false })
}

function yesNoField(doc, x, y, label, value) {
  doc.fontSize(9).font('Helvetica').fillColor('black')
     .text(`${label} :  `, x, y, { continued: true, lineBreak: false })
  doc.text(value ? 'Oui' : 'Non', { lineBreak: false })
}

function embedSignature(doc, dataUrl, x, y, w, h) {
  if (!dataUrl) return
  try {
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    const buf = Buffer.from(base64, 'base64')
    doc.image(buf, x, y, { width: w, height: h })
  } catch (e) {
    console.warn('[pdf] embedSignature error:', e.message)
  }
}

function signatureBlock(doc, x, y, data) {
  doc.fontSize(10).font('Helvetica').fillColor('black')
     .text(`Fait a : ${data.faita}`, x, y, { lineBreak: false })
     .text(`Le : ${data.dateAcceptation}`, x, y + 16, { lineBreak: false })
  doc.font('Helvetica-Bold').fontSize(11)
     .text(data.signataire, x + 200, y + 16, { lineBreak: false })
  doc.fillColor('black')
  embedSignature(doc, data.signature, x + 200, y + 44, 180, 55)
}

// ─── Export ──────────────────────────────────────────────────────

function generateDossierPDF(outputPath, type, data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false })
    const stream = fs.createWriteStream(outputPath)
    doc.pipe(stream)

    // Page 1 : Fiche de renseignements
    if (type === 'inscription') addFicheInscription(doc, data)
    else                        addFicheReinscription(doc, data)

    // Page 2 : Reglement interieur
    addReglement(doc, data)

    // Page 3 : Autorisation a l'image
    addAutorisationImage(doc, data)

    doc.end()
    stream.on('finish', resolve)
    stream.on('error', reject)
  })
}

module.exports = { generateDossierPDF }