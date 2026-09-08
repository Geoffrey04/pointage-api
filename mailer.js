const nodemailer = require('nodemailer')

// Transport réutilisé entre les envois : une connexion SMTP était ouverte à
// chaque dossier reçu.
let transport = null
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  }
  return transport
}

// Même assainissement que pour le téléchargement du PDF côté admin : les noms
// viennent d'un formulaire public et ne doivent pas façonner un nom de fichier.
const safeName = (v) => String(v || '').replace(/[^\wÀ-ÿ\- ]/g, '').trim() || 'inconnu'

async function sendDossierEmail(type, nomEleve, prenomEleve, pdfPath) {
  const transport = getTransport()
  const label = type === 'inscription' ? 'Inscription' : 'Réinscription'

  await transport.sendMail({
    from: `"Ecole de Musique Marpent" <${process.env.SMTP_USER}>`,
    to: process.env.MAIL_DEST,
    subject: `[${label}] ${prenomEleve} ${nomEleve}`,
    text:
      `Un nouveau dossier de ${label.toLowerCase()} a été soumis.\n\n` +
      `Élève : ${prenomEleve} ${nomEleve}\n` +
      `Veuillez trouver le dossier complet en pièce jointe.`,
    attachments: [
      {
        filename: `dossier-${type}-${safeName(prenomEleve)}-${safeName(nomEleve)}.pdf`,
        path: pdfPath,
      },
    ],
  })
}

module.exports = { sendDossierEmail }