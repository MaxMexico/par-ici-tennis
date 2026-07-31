export const notify = async (file, filename, message, config) => {
  try {
    const headers = {
      'Title': 'Paris Tennis',
      'Message': message,
      'Icon': 'https://em-content.zobj.net/source/apple/419/tennis_1f3be.png',
      'Tags': 'calendar',
    }
    if (filename) headers['Filename'] = filename
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
