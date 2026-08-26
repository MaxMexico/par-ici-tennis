import test from 'node:test'
import assert from 'node:assert/strict'
import { headerSafe } from '../lib/ntfy.js'

// Régression observée en production : l'échec de réservation n'a jamais été notifié,
// car le message d'erreur de Playwright est multi-lignes et `Headers.append` rejette
// tout saut de ligne. L'alerte tombait donc en panne exactement quand elle servait.
const PLAYWRIGHT_ERROR = 'page.waitForSelector: Timeout 15000ms exceeded.\nCall log:\n  - waiting for locator(\'.confirmReservation\') to be visible\n'

test('un message multi-lignes est refusé tel quel par Headers', () => {
  assert.throws(() => new Headers({ Message: PLAYWRIGHT_ERROR }))
})

test('headerSafe rend le message acceptable en en-tête', () => {
  const safe = headerSafe(PLAYWRIGHT_ERROR)
  assert.doesNotThrow(() => new Headers({ Message: safe }))
  assert.ok(!/[\r\n\t]/.test(safe), 'aucun caractère de contrôle ne doit subsister')
  assert.match(safe, /Timeout 15000ms exceeded/, 'le fond du message doit être conservé')
})

test('headerSafe borne la longueur et tolère les valeurs vides', () => {
  assert.equal(headerSafe(null), '')
  assert.equal(headerSafe(undefined), '')
  assert.ok(headerSafe('x'.repeat(5000)).length <= 900)
})

// Les en-têtes HTTP sont lus en latin-1 : de l'UTF-8 brut s'affiche « RÃ©servation »
// sur le téléphone. Constaté en conditions réelles sur les notifications reçues.
test('headerSafe translittère les accents en ASCII lisible', () => {
  assert.equal(headerSafe('Réservation faite : Niox à 20h'), 'Reservation faite : Niox a 20h')
  assert.equal(headerSafe('Aucun créneau disponible'), 'Aucun creneau disponible')
  assert.equal(headerSafe('Court N°4'), 'Court No4')
  assert.equal(headerSafe('Échec — cœur, æther, l\u2019été'), 'Echec - coeur, aether, l\'ete')
})

test('headerSafe ne laisse passer que de l\'ASCII imprimable', () => {
  const safe = headerSafe('emoji 🎾 et accents éàü')
  assert.match(safe, /^[\x20-\x7E]*$/, `non-ASCII résiduel : ${JSON.stringify(safe)}`)
})
