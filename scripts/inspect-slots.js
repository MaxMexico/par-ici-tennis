// Liste TOUS les créneaux affichés par le site, sans appliquer aucun filtre de config.
// Sert à répondre à une seule question : pourquoi aucun créneau n'est-il retenu ?
// Ne réserve rien, ne clique aucun créneau.
/* global document */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'fs'
import { config } from '../staticFiles.js'
import { nowParis, resolveTargetDate } from '../lib/clock.js'

const log = (message) => console.log(`${nowParis().format('HH:mm:ss.SSS')} - ${message}`)

// Remonte l'arbre depuis chaque créneau pour retrouver son court et son tarif, sans
// dépendre des sélecteurs de position (:left-of) qui cassent au moindre changement de CSS.
const extractSlots = (page) => page.evaluate(() => {
  return [...document.querySelectorAll('[datedeb]')].map((el) => {
    let node = el
    let court = null
    let price = null
    for (let depth = 0; depth < 10 && node; depth += 1) {
      if (!court && node.querySelector) court = node.querySelector('.court')
      if (!price && node.querySelector) price = node.querySelector('.price-description')
      if (court && price) break
      node = node.parentElement
    }
    return {
      datedeb: el.getAttribute('datedeb'),
      courtid: el.getAttribute('courtid'),
      court: court ? court.textContent.trim().replace(/\s+/g, ' ') : null,
      priceHtml: price ? price.innerHTML.trim() : null,
    }
  })
})

const run = async () => {
  const date = resolveTargetDate(config)
  const locations = !Array.isArray(config.locations) ? Object.keys(config.locations) : config.locations
  log(`Inspection pour le ${date.format('DD/MM/YYYY')} sur : ${locations.join(', ')}`)
  log(`Config actuelle — heures: ${JSON.stringify(config.hours)} | priceType: ${JSON.stringify(config.priceType)} | courtType: ${JSON.stringify(config.courtType)}`)

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.setDefaultTimeout(45000)
  await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captcha**', route => route.abort())

  try {
    await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1')
    await page.click('#button_suivi_inscription')
    await page.fill('#username', config?.account?.email || process.env.ACCOUNT_EMAIL)
    await page.fill('#password', config?.account?.password || process.env.ACCOUNT_PASSWORD)
    await page.click('#form-login >> button')
    await page.waitForSelector('.main-informations')
    log('Connecté')

    mkdirSync('img', { recursive: true })
    const allPrices = new Set()
    const allCourtTypes = new Set()

    for (const location of locations) {
      await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!')
      await page.locator('.tokens-input-text').pressSequentially(`${location} `)
      await page.waitForSelector(`.tokens-suggestions-list-element >> text="${location}"`)
      await page.click(`.tokens-suggestions-list-element >> text="${location}"`)
      await page.click('#when')
      await page.waitForSelector(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
      await page.click(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
      await page.waitForSelector('.date-picker', { state: 'hidden' })
      await page.click('#rechercher')
      await page.locator('[datedeb]').first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {})

      const slots = await extractSlots(page)
      const slug = location.replaceAll(' ', '').replaceAll('-', '')
      writeFileSync(`img/inspect-${slug}.html`, await page.content())

      console.log(`\n===== ${location} — ${slots.length} créneau(x) dans le DOM =====`)
      if (slots.length === 0) {
        console.log('  Aucun élément [datedeb] : soit aucune disponibilité, soit le sélecteur a changé.')
        console.log(`  DOM complet enregistré dans img/inspect-${slug}.html`)
        continue
      }

      console.log('  heure | court                     | tarif             | type')
      console.log('  ------+---------------------------+-------------------+----------')
      for (const slot of slots) {
        const hour = (slot.datedeb || '').split(' ')[1]?.slice(0, 2) ?? '??'
        const [priceType, courtType] = (slot.priceHtml || '').split('<br>')
        if (priceType) allPrices.add(priceType)
        if (courtType) allCourtTypes.add(courtType)
        const wantedHour = config.hours.includes(hour)
        const wantedPrice = config.priceType.includes(priceType)
        const wantedCourt = config.courtType.includes(courtType)
        const verdict = wantedHour && wantedPrice && wantedCourt
          ? '✅ RETENU'
          : `❌ rejeté (${[!wantedHour && 'heure', !wantedPrice && 'tarif', !wantedCourt && 'type'].filter(Boolean).join('+')})`
        console.log(`  ${String(hour).padEnd(5)} | ${String(slot.court ?? '?').padEnd(25).slice(0, 25)} | ${String(priceType ?? '?').padEnd(17).slice(0, 17)} | ${String(courtType ?? '?').padEnd(9).slice(0, 9)} ${verdict}`)
      }
    }

    console.log('\n===== LIBELLÉS EXACTS RENVOYÉS PAR LE SITE =====')
    console.log('priceType observés :', JSON.stringify([...allPrices]))
    console.log('courtType observés :', JSON.stringify([...allCourtTypes]))
    console.log('priceType en config:', JSON.stringify(config.priceType))
    console.log('courtType en config:', JSON.stringify(config.courtType))
    const priceMismatch = [...allPrices].length > 0 && ![...allPrices].some(p => config.priceType.includes(p))
    if (priceMismatch) {
      console.log('\n⚠️  AUCUN tarif observé ne figure dans config.priceType — c\'est la cause du rejet.')
    }
  } catch (err) {
    console.error('ÉCHEC :', err.message)
    process.exitCode = 1
  } finally {
    await browser.close().catch(() => {})
  }
}

run()
