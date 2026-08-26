// Deux contraintes distinctes sur les en-têtes HTTP :
//
// 1. Aucun saut de ligne ni retour chariot. Les erreurs Playwright en contiennent
//    systématiquement (« Call log: … »), ce qui faisait échouer l'envoi au moment
//    précis où l'alerte est utile.
// 2. Les en-têtes sont interprétés en latin-1, pas en UTF-8 : « Réservation » envoyé
//    en UTF-8 s'affiche « RÃ©servation » sur le téléphone. Les accents sont donc
//    translittérés en ASCII, ce qui reste lisible dans tous les cas — y compris quand
//    le corps de la requête est occupé par une pièce jointe.
export const headerSafe = (value) => String(value ?? '')
  .replace(/[\r\n\t]+/g, ' | ')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/œ/g, 'oe').replace(/Œ/g, 'OE')
  .replace(/æ/g, 'ae').replace(/Æ/g, 'AE')
  .replace(/[’‘]/g, '\'').replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/°/g, 'o')
  .replace(/[^\x20-\x7E]/g, '')
  .replace(/ {2,}/g, ' ')
  .trim()
  .slice(0, 900)

export const notify = async (file, filename, message, config) => {
  try {
    const headers = {
      'Title': 'Paris Tennis',
      'Message': headerSafe(message),
      'Icon': 'https://em-content.zobj.net/source/apple/419/tennis_1f3be.png',
      'Tags': 'calendar',
    }
    if (filename) headers['Filename'] = headerSafe(filename)
    // Un topic ntfy public est lisible par quiconque le devine. Un token permet de
    // passer sur un topic protégé sans changer le reste du code.
    const token = process.env.NTFY_TOKEN || config.token
    if (token) headers['Authorization'] = `Bearer ${token}`

    const response = await fetch(`https://${config.domain || 'ntfy.sh'}/${config.topic}`, {
      method: 'PUT',
      headers,
      body: file || undefined,
    })

    // Sans ce contrôle, un 403/404 passait pour un envoi réussi.
    if (!response.ok) {
      console.error(`Notification ntfy refusée : HTTP ${response.status} ${response.statusText}`)
      return false
    }

    console.log('Notification sent via ntfy')
    return true
  } catch (err) {
    console.error('Error while sending notification using ntfy:', err.message)
    return false
  }
}
