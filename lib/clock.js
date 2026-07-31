import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'

dayjs.extend(customParseFormat)
dayjs.extend(utc)
dayjs.extend(timezone)

export const TZ = 'Europe/Paris'

// Toute la logique métier raisonne en heure de Paris, jamais en heure locale de la machine.
export const nowParis = () => dayjs().tz(TZ)

const DATE_FORMATS = ['D/M/YYYY', 'DD/MM/YYYY', 'D/MM/YYYY', 'DD/M/YYYY']

// Le README documente D/M/YYYY mais le code ne parsait que D/MM/YYYY :
// "9/1/2026" donnait Invalid Date, donc un sélecteur introuvable et un run perdu.
export const resolveTargetDate = (config) => {
  if (!config.date) {
    return nowParis().add(6, 'days')
  }

  const parsed = dayjs(config.date, DATE_FORMATS, true)
  if (!parsed.isValid()) {
    throw new Error(`config.date invalide : "${config.date}" (format attendu J/M/AAAA, ex. 9/1/2026)`)
  }

  return parsed
}

// Instant d'ouverture des réservations, exprimé en heure de Paris (DST géré par dayjs/tz).
export const openingInstant = (openingTime = '08:00:00') => {
  const [hour, minute, second] = openingTime.split(':').map(Number)
  if ([hour, minute, second].some(part => !Number.isInteger(part))) {
    throw new Error(`openingTime invalide : "${openingTime}" (format attendu HH:MM:SS)`)
  }

  return nowParis().hour(hour).minute(minute).second(second).millisecond(0)
}

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

export { dayjs }
