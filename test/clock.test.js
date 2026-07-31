import test from 'node:test'
import assert from 'node:assert/strict'
import { openingInstant, resolveTargetDate } from '../lib/clock.js'

test('resolveTargetDate accepte le format documenté dans le README (D/M/YYYY)', () => {
  // Régression : le code ne parsait que 'D/MM/YYYY', donc "9/1/2026" donnait Invalid Date,
  // un sélecteur [dateiso="Invalid Date"] introuvable, et un run entièrement perdu.
  assert.equal(resolveTargetDate({ date: '9/1/2026' }).format('DD/MM/YYYY'), '09/01/2026')
  assert.equal(resolveTargetDate({ date: '09/01/2026' }).format('DD/MM/YYYY'), '09/01/2026')
  assert.equal(resolveTargetDate({ date: '31/12/2026' }).format('DD/MM/YYYY'), '31/12/2026')
})

test('resolveTargetDate rejette une date invalide au lieu de la propager', () => {
  assert.throws(() => resolveTargetDate({ date: 'demain' }), /config.date invalide/)
  assert.throws(() => resolveTargetDate({ date: '32/13/2026' }), /config.date invalide/)
})

test('resolveTargetDate vise J+6 en heure de Paris sans config.date', () => {
  const target = resolveTargetDate({})
  const days = target.startOf('day').diff(resolveTargetDate({ date: target.format('DD/MM/YYYY') }).startOf('day'), 'day')
  assert.equal(days, 0)
})

test('openingInstant rend un instant à la seconde demandée', () => {
  const opening = openingInstant('08:00:00')
  assert.equal(opening.format('HH:mm:ss'), '08:00:00')
  assert.equal(opening.millisecond(), 0)

  const custom = openingInstant('07:30:15')
  assert.equal(custom.format('HH:mm:ss'), '07:30:15')
})

test('openingInstant rejette un format d\'heure invalide', () => {
  assert.throws(() => openingInstant('8h'), /openingTime invalide/)
})

test('openingInstant est exprimé en Europe/Paris quelle que soit la TZ du serveur', () => {
  // La VM peut être en UTC : l'offset doit rester celui de Paris (+01:00 ou +02:00).
  const offset = openingInstant('08:00:00').format('Z')
  assert.ok(['+01:00', '+02:00'].includes(offset), `offset inattendu : ${offset}`)
})
