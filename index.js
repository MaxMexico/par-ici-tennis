import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'fs'
import { createEvent } from 'ics'
import { config } from './staticFiles.js'
import { notify } from './lib/ntfy.js'
import { nowParis, openingInstant, resolveTargetDate, sleep } from './lib/clock.js'

// Budgets de temps : généreux pendant le warm-up (avant l'ouverture), serrés pendant la ruée.
const WARMUP_TIMEOUT = Number(config.warmupTimeoutMs ?? 45000)
const RUSH_TIMEOUT = Number(config.rushTimeoutMs ?? 5000)
// Durée pendant laquelle on continue de balayer les terrains après l'ouverture.
const SWEEP_WINDOW_MS = Number(config.sweepWindowMs ?? 90000)
const OPENING_TIME = config.openingTime ?? '08:00:00'

const DRY_RUN_MODE = process.argv.includes('--dry-run')
// Le captcha invisible se déclenche à la réservation, pas à la recherche. Couper ses
// requêtes sabote donc exactement l'étape qui fait passer au tunnel. `--allow-captcha`
// (ou "blockCaptcha": false) les laisse passer.
const BLOCK_CAPTCHA = process.argv.includes('--allow-captcha')
  ? false
  : (config.blockCaptcha ?? true)
// Répondre « Oui » à la modale « vous avez déjà une réservation en cours » ANNULE la
// réservation existante. Jamais par défaut : c'est une action destructrice.
const REPLACE_EXISTING = config.replaceExistingReservation === true
const IN_CI = Boolean(process.env.GITHUB_ACTIONS)

const log = (message) => console.log(`${nowParis().format('YYYY-MM-DDTHH:mm:ss.SSS')} - ${message}`)
const logError = (message) => console.error(`${nowParis().format('YYYY-MM-DDTHH:mm:ss.SSS')} - ${message}`)

const ntfyEnabled = () => config.ntfy?.enable === true || Boolean(process.env.NTFY_TOPIC)
const ntfyConfig = () => ({
  domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
  topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
})

// Trace post-mortem : sans ça, un échec ne laisse qu'un timeout générique impossible à analyser.
const dumpPage = async (page, label) => {
  try {
    mkdirSync('img', { recursive: true })
    await page.screenshot({ path: `img/${label}.png` })
    writeFileSync(`img/${label}.html`, await page.content())
    log(`Trace écrite : img/${label}.png + img/${label}.html`)
  } catch (err) {
    logError(`Impossible d'écrire la trace ${label} : ${err.message}`)
  }
}

const login = async (page, label) => {
  await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1')
  await page.click('#button_suivi_inscription')
  await page.fill('#username', config?.account?.email || process.env.ACCOUNT_EMAIL)
  await page.fill('#password', config?.account?.password || process.env.ACCOUNT_PASSWORD)
  await page.click('#form-login >> button')

  // Une erreur d'identifiants ne doit pas se traduire par un timeout muet de 45 s.
  const loggedIn = page.waitForSelector('.main-informations', { timeout: WARMUP_TIMEOUT })
  const rejected = page.waitForSelector('.alert-danger, .error-message', { timeout: WARMUP_TIMEOUT })
  const outcome = await Promise.race([
    loggedIn.then(() => 'ok'),
    rejected.then(() => 'rejected'),
  ]).catch(() => 'timeout')

  if (outcome !== 'ok') {
    throw new Error(`Connexion échouée (${outcome}) — vérifiez ACCOUNT_EMAIL / ACCOUNT_PASSWORD`)
  }

  log(`Session ouverte${label ? ` — ${label}` : ''}`)
}

// Prépare une page jusqu'au point où il ne reste plus qu'à cliquer sur #rechercher.
// Tout ce qui est lent doit se produire ICI, avant l'ouverture.
const armSearchPage = async (page, location, date, timeout) => {
  page.setDefaultTimeout(timeout)
  await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!')

  await page.locator('.tokens-input-text').pressSequentially(`${location} `)
  await page.waitForSelector(`.tokens-suggestions-list-element >> text="${location}"`)
  await page.click(`.tokens-suggestions-list-element >> text="${location}"`)

  await page.click('#when')
  await page.waitForSelector(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
  await page.click(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
  await page.waitForSelector('.date-picker', { state: 'hidden' })
}

// La recherche est servie en AJAX : waitForLoadState('domcontentloaded') retourne
// immédiatement et page.$() n'auto-attend pas. Résultat, l'ancien code lisait un DOM
// encore vide et concluait "aucun créneau". On attend ici l'apparition réelle des créneaux.
const runSearch = async (page, timeout) => {
  await page.click('#rechercher')

  try {
    await page.locator('[datedeb]').first().waitFor({ state: 'attached', timeout })
    return 'results'
  } catch {
    return 'empty'
  }
}

const readSlotMetadata = async (page, bookSlotButton) => {
  const courtHandle = await page.$(`.court:left-of(${bookSlotButton})`)
  const priceHandle = await page.$(`.price-description:left-of(${bookSlotButton})`)
  if (!courtHandle || !priceHandle) {
    return null
  }

  const courtName = (await courtHandle.innerText()).trim()
  const [priceType, courtType] = (await priceHandle.innerHTML()).split('<br>')

  return { courtName, priceType, courtType }
}

// Cherche un créneau conforme à la config et le clique. Ne lève jamais : un terrain
// cassé ne doit pas annuler les terrains suivants.
const findAndClickSlot = async (page, location, date) => {
  const courtNumbers = !Array.isArray(config.locations) ? config.locations[location] ?? [] : []

  for (const hour of config.hours) {
    const dateDeb = `[datedeb="${date.format('YYYY/MM/DD')} ${hour}:00:00"]`
    if (!(await page.$(dateDeb))) {
      continue
    }

    const accordion = await page.$(`#collapse${location.replaceAll(' ', '')}${hour}h`)
    if (accordion) {
      await accordion.evaluate((el) => {
        el.classList.add('in')
        el.style.display = 'block'
      })
      await page.waitForTimeout(150)
    }

    for (const slot of await page.$$(dateDeb)) {
      const bookSlotButton = `[courtid="${await slot.getAttribute('courtid')}"]${dateDeb}`
      const metadata = await readSlotMetadata(page, bookSlotButton)
      if (!metadata) {
        log(`Créneau ${hour}h ignoré : métadonnées court/tarif introuvables`)
        continue
      }

      if (courtNumbers.length > 0) {
        const courtMatch = metadata.courtName.match(/Court N°(\d+)/)
        if (!courtMatch || !courtNumbers.includes(parseInt(courtMatch[1]))) {
          continue
        }
      }

      if (!config.priceType.includes(metadata.priceType) || !config.courtType.includes(metadata.courtType)) {
        continue
      }

      log(`Créneau retenu : ${location} ${hour}h — ${metadata.courtName} (${metadata.priceType} / ${metadata.courtType})`)
      await page.$eval(bookSlotButton, el => el.click())

      // Le site intercale une modale quand le compte a déjà une réservation active :
      // « Vous avez déjà une réservation en cours. Souhaitez-vous la remplacer ? ».
      // Tant qu'on n'y répond pas, le tunnel n'apparaît jamais — c'est ce qui bloquait
      // silencieusement toutes les réservations.
      const existingReservationModal = page.locator('.modal.in').filter({ hasText: 'réservation en cours' }).first()
      const step = await Promise.race([
        page.locator('.order-steps-infos').waitFor({ state: 'visible', timeout: 15000 }).then(() => 'tunnel'),
        existingReservationModal.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'modal'),
      ]).catch(() => 'timeout')

      if (step === 'modal') {
        // Un test à blanc ne doit jamais détruire une réservation, même si le
        // remplacement est autorisé en configuration.
        if (!REPLACE_EXISTING || DRY_RUN_MODE) {
          // Répondre « Non » laisse la réservation existante intacte.
          await existingReservationModal.locator('a, button, .btn').filter({ hasText: /^\s*Non\s*$/ }).first()
            .click().catch(() => {})
          return { blocked: 'existing-reservation' }
        }

        log('Réservation existante détectée — remplacement autorisé par la config, réponse « Oui »')
        await existingReservationModal.locator('a, button, .btn').filter({ hasText: /^\s*Oui\s*$/ }).first().click()
        const replaced = await page.locator('.order-steps-infos')
          .waitFor({ state: 'visible', timeout: 15000 })
          .then(() => true)
          .catch(() => false)
        if (!replaced) {
          await dumpPage(page, `replace-failed-${location.replaceAll(' ', '')}-${hour}h`)
          return null
        }
        return { hour }
      }

      if (step !== 'tunnel') {
        // Sans l'URL et le titre, l'échec est indiscernable entre « le clic n'a rien
        // fait », « une modale s'est ouverte » et « le site a renvoyé une erreur ».
        const alerts = await page.locator('.alert, .error, .message, [class*="popin"], .modal:visible')
          .allInnerTexts().catch(() => [])
        log(`Clic sur le créneau ${hour}h sans arrivée sur le tunnel de réservation`)
        log(`  url    : ${page.url()}`)
        log(`  titre  : ${await page.title().catch(() => '?')}`)
        log(`  alertes: ${JSON.stringify(alerts.map(t => t.trim().replace(/\s+/g, ' ').slice(0, 160)).filter(Boolean))}`)
        await dumpPage(page, `slot-click-failed-${location.replaceAll(' ', '')}-${hour}h`)
        return null
      }

      return { hour }
    }
  }

  return null
}

const fillPlayersAndPay = async (page) => {
  for (const [index, player] of config.players.entries()) {
    if (index > 0) {
      await page.click('.addPlayer')
    }
    await page.waitForSelector(`[name="player${index + 1}"]`)
    await page.fill(`[name="player${index + 1}"] >> nth=0`, player.lastName)
    await page.fill(`[name="player${index + 1}"] >> nth=1`, player.firstName)
  }

  await page.keyboard.press('Enter')

  await page.waitForSelector('#order_select_payment_form #paymentMode', { state: 'attached' })
  const paymentMode = await page.$('#order_select_payment_form #paymentMode')

  // Le site pré-remplit lui-même ce champ (observé : value="ticket", readonly). L'ancien
  // code l'écrasait avec 'existingTicket', une valeur que le site ne reconnaît pas : le
  // formulaire restait invalide et le tunnel bloquait à l'étape 2/3. On ne force donc
  // une valeur que si le champ est vide, ou si la config en impose une explicitement.
  const current = (await paymentMode.evaluate(el => el.value)) || ''
  const forced = config.paymentMode
  const wanted = forced || current || 'ticket'

  if (current !== wanted) {
    log(`Mode de paiement : "${current || '(vide)'}" → "${wanted}"`)
    await paymentMode.evaluate((el, value) => {
      el.removeAttribute('readonly')
      el.value = value
      // Sans ces événements, la validation du site ne voit pas le changement.
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }, wanted)
  } else {
    log(`Mode de paiement conservé tel quel : "${current}"`)
  }
}

const buildIcs = (event) => new Promise((resolve, reject) => {
  createEvent(event, (error, value) => (error ? reject(error) : resolve(value)))
})

const confirmBooking = async (page, date, selectedHour, logLocation) => {
  const submit = await page.$('#order_select_payment_form #envoyer')
  await submit.evaluate(el => el.classList.remove('hide'))
  await submit.click()

  // `#confirmReservation` est une <div class="modal fade"> : une modale de confirmation,
  // pas la page finale. L'ancien code attendait `.confirmReservation` comme une CLASSE,
  // qui n'existe nulle part — l'attente ne pouvait donc jamais aboutir.
  const confirmModal = page.locator('#confirmReservation')
  if (await confirmModal.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
    const buttons = await confirmModal.locator('a, button, .btn').allInnerTexts().catch(() => [])
    log(`Modale de confirmation ouverte — boutons : ${JSON.stringify(buttons.map(t => t.trim()).filter(Boolean))}`)
    await confirmModal.locator('a, button, .btn')
      .filter({ hasText: /confirm|valid|oui|r[ée]server/i }).first()
      .click().catch(err => logError(`Clic de confirmation impossible : ${err.message}`))
  }

  // Le succès se mesure à l'avancement du tunnel, pas à un marqueur nommé : les étapes
  // sont libellées « 1 / 3 », « 2 / 3 », « 3 / 3 » par le site lui-même.
  const confirmed = await page.locator('.order-steps-infos').filter({ hasText: '3 / 3' })
    .waitFor({ state: 'visible', timeout: 20000 })
    .then(() => true)
    .catch(() => false)

  if (!confirmed) {
    log('Étape 3/3 non atteinte après envoi — la réservation a peut-être abouti')
    log(`  url    : ${page.url()}`)
    log(`  titre  : ${await page.title().catch(() => '?')}`)
    log(`  étape  : ${(await page.locator('.order-steps-infos').first().innerText().catch(() => '?')).replace(/\s+/g, ' ').slice(0, 80)}`)
    await dumpPage(page, 'confirmation-uncertain')
    return 'uncertain'
  }

  const readText = async (selector) => {
    const handle = await page.$(selector)
    return handle ? (await handle.textContent()).trim().replace(/( ){2,}/g, ' ') : ''
  }

  const address = await readText('.address')
  const dateStr = await readText('.date')
  const court = await readText('.court')

  if (IN_CI) {
    log('Réservation faite, consultez vos emails ou tennis.paris.fr pour le détail.')
  } else {
    log(`Réservation faite : ${address} — ${dateStr} — ${court}`)
  }

  const hourMatch = dateStr.match(/(\d{2})h/)
  const hour = hourMatch ? Number(hourMatch[1]) : Number(selectedHour)

  try {
    const ics = await buildIcs({
      start: [date.year(), date.month() + 1, date.date(), hour, 0],
      duration: { hours: 1, minutes: 0 },
      title: 'Réservation Tennis',
      description: `Court: ${court}\nAdresse: ${address}`,
      location: address,
      status: 'CONFIRMED',
    })

    if (!IN_CI) {
      writeFileSync('event.ics', ics)
    }
    if (ntfyEnabled()) {
      // Attendu explicitement : l'ancien callback async n'était jamais awaité.
      await notify(Buffer.from(ics, 'utf8'), 'event.ics',
        `Confirmation pour le ${date.format('DD/MM/YYYY')} - ${hour}h`, ntfyConfig())
    }
  } catch (err) {
    // La réservation est faite : un échec ICS/notif ne doit pas la faire passer pour un échec.
    logError(`Réservation confirmée mais notification/ICS en échec : ${err.message} (${logLocation})`)
  }

  return 'confirmed'
}

const cancelDryRun = async (page) => {
  await page.click('#previous')
  await page.click('#btnCancelBooking')
}

const bookTennis = async () => {
  if (DRY_RUN_MODE) {
    log('DRY RUN : une recherche sera lancée mais AUCUNE réservation ne sera réalisée')
  }

  // Échouer tout de suite sur une config invalide, plutôt qu'à 08:00:00 sur un sélecteur muet.
  for (const field of ['locations', 'hours', 'priceType', 'courtType', 'players']) {
    if (!config[field]) {
      throw new Error(`config.${field} est absent de config.json`)
    }
  }

  const date = resolveTargetDate(config)
  const locations = !Array.isArray(config.locations) ? Object.keys(config.locations) : config.locations
  if (locations.length === 0) {
    throw new Error('config.locations est vide')
  }

  log(`Cible : ${date.format('DD/MM/YYYY')} — ${locations.length} terrain(s) — ouverture ${OPENING_TIME}`)

  // Un contexte par terrain signifie plusieurs pages chargées en même temps. Sur une
  // petite VM (~1 Go), Chromium sature /dev/shm et meurt sans message exploitable :
  // --disable-dev-shm-usage le fait travailler dans /tmp à la place.
  const browser = await chromium.launch({
    headless: true,
    slowMo: 0,
    timeout: 120000,
    args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
  })

  let exitCode = 0
  let pages = []

  try {
    // --- WARM-UP : un terrain par session isolée, toutes armées en parallèle. ---
    // Une session par terrain, et non un simple onglet : le portail mémorise les
    // terrains saisis côté session, si bien que deux recherches successives dans le
    // même contexte cumulaient leurs jetons. Observé en production : une recherche
    // « Rigoulot » renvoyait 96 créneaux dont les 25 de « Niox », ce qui faussait
    // l'ordre de préférence en attribuant à un terrain les créneaux d'un autre.
    pages = await Promise.all(locations.map(async (location) => {
      const context = await browser.newContext()
      const page = await context.newPage()
      page.setDefaultTimeout(WARMUP_TIMEOUT)
      if (BLOCK_CAPTCHA) {
        await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captcha-invisible/invisible-captcha-infos', route => route.abort())
        await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captchas**', route => route.abort())
      }
      // Tracer les échanges avec le captcha : s'ils apparaissent au moment du clic sur
      // le créneau, c'est qu'il conditionne l'accès au tunnel de réservation.
      page.on('response', (response) => {
        if (response.url().includes('captcha')) {
          log(`captcha ← HTTP ${response.status()} ${response.url().slice(0, 110)}`)
        }
      })
      try {
        await login(page, location)
        await armSearchPage(page, location, date, WARMUP_TIMEOUT)
        log(`Armé : ${location}`)
        return { location, page, armed: true }
      } catch (err) {
        logError(`Warm-up impossible pour ${location} : ${err.message}`)
        return { location, page, armed: false }
      }
    }))

    if (pages.every(entry => !entry.armed)) {
      throw new Error('Aucun terrain n\'a pu être armé pendant le warm-up')
    }

    // --- BARRIÈRE : on attend l'ouverture juste avant de tirer, pas 15 s plus tôt. ---
    const opening = openingInstant(OPENING_TIME)
    const waitMs = opening.diff(nowParis())
    if (DRY_RUN_MODE && waitMs > 0) {
      // Un test à blanc ne doit jamais bloquer jusqu'à 08:00.
      log(`DRY RUN : barrière d'ouverture ignorée (T-${(waitMs / 1000).toFixed(1)}s)`)
    } else if (waitMs > 0) {
      log(`Warm-up terminé, armé pour ${opening.format('HH:mm:ss')} (T-${(waitMs / 1000).toFixed(1)}s)`)
      await sleep(waitMs)
    } else {
      log(`Ouverture déjà passée de ${(-waitMs / 1000).toFixed(1)}s — recherche immédiate`)
    }

    // --- RUÉE : balayages successifs jusqu'à épuisement de la fenêtre. ---
    const deadline = Date.now() + SWEEP_WINDOW_MS
    let booked = false
    let bookingOutcome = 'confirmed'
    let blockedByExistingReservation = false
    let sweep = 0

    while (!booked && !blockedByExistingReservation && Date.now() < deadline) {
      sweep += 1

      // Tous les terrains sont interrogés simultanément ; les résultats sont ensuite
      // dépouillés dans l'ordre de préférence de la config.
      const searches = await Promise.all(pages.map(async (entry) => {
        try {
          // Passe 1 : les pages sont déjà armées, on tire dans la milliseconde qui suit
          // la levée de la barrière. Passes suivantes : il faut réarmer.
          if (!entry.armed || sweep > 1) {
            await armSearchPage(entry.page, entry.location, date, RUSH_TIMEOUT * 3)
            entry.armed = true
          }
          entry.page.setDefaultTimeout(RUSH_TIMEOUT * 3)
          return { ...entry, outcome: await runSearch(entry.page, RUSH_TIMEOUT) }
        } catch (err) {
          logError(`Recherche ${entry.location} en échec (passe ${sweep}) : ${err.message}`)
          entry.armed = false
          return { ...entry, outcome: 'error' }
        }
      }))

      for (const [index, entry] of searches.entries()) {
        const logLocation = IN_CI ? `location ${index + 1}` : entry.location
        if (entry.outcome !== 'results') {
          log(`Passe ${sweep} — ${logLocation} : ${entry.outcome === 'empty' ? 'aucun créneau affiché' : 'erreur'}`)
          continue
        }

        let result = null
        try {
          result = await findAndClickSlot(entry.page, entry.location, date)
        } catch (err) {
          logError(`Passe ${sweep} — ${logLocation} : ${err.message}`)
          continue
        }

        if (result?.blocked === 'existing-reservation') {
          // Inutile de balayer les autres terrains ni de relancer : le blocage est sur
          // le compte, pas sur la disponibilité.
          blockedByExistingReservation = true
          break
        }

        if (!result) {
          log(`Passe ${sweep} — ${logLocation} : aucun créneau conforme à la config`)
          continue
        }

        const selectedHour = result.hour
        const page = entry.page
        await page.waitForSelector('.order-steps-infos h2 >> text="1 / 3 - Validation du court"')
        await fillPlayersAndPay(page)

        if (DRY_RUN_MODE) {
          log(`Fausse réservation : ${logLocation} le ${date.format('DD/MM/YYYY')} à ${selectedHour}h`)
          await cancelDryRun(page)
          if (ntfyEnabled()) {
            await notify(null, null, `DRY RUN : créneau disponible le ${date.format('DD/MM/YYYY')} à ${selectedHour}h`, ntfyConfig())
          }
        } else {
          bookingOutcome = await confirmBooking(page, date, selectedHour, logLocation)
        }

        // Même incertain, on s'arrête : relancer risquerait une seconde réservation.
        booked = true
        break
      }

      if (!booked && !blockedByExistingReservation && Date.now() < deadline) {
        await sleep(400)
      }
    }

    if (booked && bookingOutcome === 'uncertain') {
      exitCode = 4
      const message = `Réservation envoyée pour le ${date.format('DD/MM/YYYY')} mais confirmation non détectée. `
        + 'Vérifiez sur tennis.paris.fr avant de relancer : elle a peut-être abouti.'
      logError(message)
      if (ntfyEnabled()) {
        await notify(null, null, message, ntfyConfig())
      }
    }

    if (blockedByExistingReservation) {
      // Répondre « Oui » annulerait la réservation existante : jamais sans consigne
      // explicite. Le compte est bloqué, pas les créneaux.
      exitCode = 3
      const message = 'Réservation impossible : le compte a déjà une réservation en cours. '
        + 'Annulez-la sur tennis.paris.fr, ou activez "replaceExistingReservation": true '
        + 'dans config.json pour autoriser son remplacement automatique.'
      logError(message)
      if (ntfyEnabled()) {
        await notify(null, null, message, ntfyConfig())
      }
    } else if (!booked) {
      exitCode = 2
      const label = date.format('DD/MM/YYYY')
      log(`Aucun créneau trouvé après ${sweep} passe(s) sur ${locations.length} terrain(s) pour le ${label}`)
      // Une trace par terrain : sans elle, impossible de distinguer « rien de libre »
      // d'un DOM qui a changé, ni de savoir lequel des terrains a décroché.
      for (const entry of pages.filter(e => e.armed)) {
        await dumpPage(entry.page, `no-slot-found-${entry.location.replaceAll(' ', '').replaceAll('-', '')}`)
      }
      if (ntfyEnabled()) {
        await notify(null, null, `Aucun créneau disponible le ${label} sur ${locations.join(', ')}`, ntfyConfig())
      }
    }
  } catch (err) {
    exitCode = 1
    logError(`ÉCHEC : ${err.message}`)
    logError(err.stack)
    const survivor = pages.find(entry => entry.page)
    if (survivor) await dumpPage(survivor.page, 'failure')

    if (ntfyEnabled()) {
      let screenshot = null
      try {
        if (survivor) screenshot = await survivor.page.screenshot()
      } catch { /* page morte */ }
      await notify(screenshot, screenshot ? 'failure.png' : null,
        `Erreur lors de l'exécution : ${err.message}`, ntfyConfig())
    }
  } finally {
    await browser.close().catch(() => {})
  }

  return exitCode
}

// Aucun échec ne doit sortir en code 0 : un run vert sans réservation est le pire scénario.
bookTennis()
  .then((code) => { process.exitCode = code })
  .catch(async (err) => {
    process.exitCode = 1
    logError(`ÉCHEC FATAL : ${err.stack || err.message}`)
    if (ntfyEnabled()) {
      await notify(null, null, `Échec fatal du bot tennis : ${err.message}`, ntfyConfig())
    }
  })
