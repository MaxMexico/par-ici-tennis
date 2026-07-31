import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'fs'
import { chromium } from 'playwright'

// Le binaire par défaut de Playwright n'est pas toujours présent (CI minimale, image custom).
const LOCAL_CHROMIUM = '/opt/pw-browsers/chromium'
const launchOptions = existsSync(LOCAL_CHROMIUM) ? { executablePath: LOCAL_CHROMIUM } : {}

const openBrowser = async () => {
  try {
    return await chromium.launch({ headless: true, ...launchOptions })
  } catch {
    return null
  }
}

// Reproduit la transition du site : un clic sur le créneau amène le tunnel de réservation
// après un délai réseau. C'est exactement le scénario où l'ancien code décrochait.
const SLOT_PAGE = `
  <title>Paris | TENNIS - Recherche</title>
  <a id="slot" href="#">Réserver</a>
  <script>
    document.getElementById('slot').addEventListener('click', () => {
      setTimeout(() => {
        document.title = 'Paris | TENNIS - Reservation'
        document.body.innerHTML = '<div class="order-steps-infos"><h2>1 / 3 - Validation du court</h2></div>'
      }, 400)
    })
  </script>
`

test('régression 2837c59 : waitForURL("**") n\'attend pas la transition et fait perdre le créneau', async (t) => {
  const browser = await openBrowser()
  if (!browser) return t.skip('aucun binaire Chromium disponible')

  try {
    const page = await browser.newPage()
    await page.setContent(SLOT_PAGE)
    await page.click('#slot')

    const start = Date.now()
    await page.waitForURL('**', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    const elapsed = Date.now() - start

    // L'ancien code enchaînait sur un contrôle de titre. Il lisait donc l'ancienne page
    // et exécutait `continue` : le créneau cliqué était abandonné.
    assert.ok(elapsed < 200, `waitForURL('**') a attendu ${elapsed}ms — il devrait être un no-op`)
    assert.notEqual(await page.title(), 'Paris | TENNIS - Reservation')
  } finally {
    await browser.close()
  }
})

test('correctif : attendre .order-steps-infos amène bien au tunnel de réservation', async (t) => {
  const browser = await openBrowser()
  if (!browser) return t.skip('aucun binaire Chromium disponible')

  try {
    const page = await browser.newPage()
    await page.setContent(SLOT_PAGE)
    await page.click('#slot')

    const reached = await page.locator('.order-steps-infos')
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false)

    assert.ok(reached, 'le tunnel de réservation aurait dû être atteint')
    assert.equal(await page.title(), 'Paris | TENNIS - Reservation')
  } finally {
    await browser.close()
  }
})

test('les résultats AJAX ne sont pas visibles via page.$ juste après domcontentloaded', async (t) => {
  const browser = await openBrowser()
  if (!browser) return t.skip('aucun binaire Chromium disponible')

  try {
    const page = await browser.newPage()
    await page.setContent(`
      <div id="results"></div>
      <script>
        setTimeout(() => {
          document.getElementById('results').innerHTML =
            '<a datedeb="2026/08/06 14:00:00" courtid="1">14h</a>'
        }, 300)
      </script>
    `)
    await page.waitForLoadState('domcontentloaded')

    // Cause du faux "aucun créneau" : page.$ n'auto-attend pas.
    assert.equal(await page.$('[datedeb]'), null)

    // Le correctif attend l'apparition réelle du créneau.
    await page.locator('[datedeb]').first().waitFor({ state: 'attached', timeout: 5000 })
    assert.notEqual(await page.$('[datedeb]'), null)
  } finally {
    await browser.close()
  }
})
