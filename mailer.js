const nodemailer = require('nodemailer')

function createTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })
}

async function sendDossierEmail(type, nomEleve, prenomEleve, pdfPath) {
  const transport = createTransport()
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
        filename: `dossier-${type}-${prenomEleve}-${nomEleve}.pdf`,
        path: pdfPath,
      },
    ],
  })
}

module.exports = { sendDossierEmail }