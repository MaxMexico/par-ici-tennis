import { chromium } from 'playwright'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import { writeFileSync } from 'fs'
import { createEvent } from 'ics'
import { config } from './staticFiles.js'
import { notify } from './lib/ntfy.js'
import { huggingFaceAPI } from './lib/huggingface.js'

dayjs.extend(customParseFormat)
dayjs.extend(utc)
dayjs.extend(timezone)

const bookTennis = async () => {
  const DRY_RUN_MODE = process.argv.includes('--dry-run')
  if (DRY_RUN_MODE) {
    console.log('----- DRY RUN START -----')
    console.log('Script lancé en mode DRY RUN. Afin de tester votre configuration, une recherche va être lancé mais AUCUNE réservation ne sera réalisée')
  }

  console.log(`${dayjs().format()} - Starting searching tennis`)
  const browser = await chromium.launch({
    headless: true,
    slowMo: 0,
    timeout: 90000,
    args: ['--disable-blink-features=AutomationControlled'],
  })

  console.log(`${dayjs().format()} - Browser started`)
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Safari/537.36',
  })
  const page = await context.newPage()
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
  // Bloquer le captcha invisible pour éviter le captcha visuel à la réservation
  await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captcha-invisible/invisible-captcha-infos', (route) => route.abort())
  await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captchas**', (route) => route.abort())
  page.setDefaultTimeout(90000)
  await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1')

  await page.click('#button_suivi_inscription')
  await page.fill('#username', config?.account?.email || process.env.ACCOUNT_EMAIL)
  await page.fill('#password', config?.account?.password || process.env.ACCOUNT_PASSWORD)
  await page.click('#form-login >> button')

  console.log(`${dayjs().format()} - User connected`)

  // wait for login redirection before continue
  await page.waitForSelector('.main-informations')

  try {
    // Attendre 07:59:45 sur le dashboard (stable) avant de naviguer vers la recherche
    const prewaitNow = dayjs().tz('Europe/Paris')
    const prewaitTarget = prewaitNow.hour(7).minute(59).second(45).millisecond(0)
    if (prewaitNow.isBefore(prewaitTarget)) {
      const waitMs = prewaitTarget.diff(prewaitNow)
      console.log(`${dayjs().format()} - Attente jusqu'à 07:59:45 (${(waitMs / 1000).toFixed(1)}s)`)
      await new Promise(resolve => setTimeout(resolve, waitMs))
    }

    const locations = !Array.isArray(config.locations) ? Object.keys(config.locations) : config.locations
    let booked = false
    locationsLoop:
    for (const [i, location] of locations.entries()) {
      const logLocation = process.env.GITHUB_ACTIONS ? `location ${i + 1}` : location
      console.log(`${dayjs().format()} - Search at ${logLocation}`)
      await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!')

      // select tennis location
      await page.locator('.tokens-input-text').pressSequentially(`${location} `)
      await page.waitForSelector(`.tokens-suggestions-list-element >> text="${location}"`)
      await page.click(`.tokens-suggestions-list-element >> text="${location}"`)

      // select date
      await page.click('#when')
      const date = config.date ? dayjs(config.date, 'D/MM/YYYY') : dayjs().add(6, 'days')
      await page.waitForSelector(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
      await page.click(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
      await page.waitForSelector('.date-picker', { state: 'hidden' })

      // Attendre 08:00:00 pile avant de soumettre (les créneaux s'ouvrent à 08:00:00)
      const searchNow = dayjs().tz('Europe/Paris')
      const openTime = searchNow.hour(8).minute(0).second(0).millisecond(0)
      if (searchNow.isBefore(openTime)) {
        const waitMs = openTime.diff(searchNow)
        console.log(`${dayjs().format()} - Attente ouverture des créneaux (${(waitMs / 1000).toFixed(1)}s)`)
        await new Promise(resolve => setTimeout(resolve, waitMs))
      }

      await page.click('#rechercher')

      // wait until the results page is fully loaded before continue
      await page.waitForLoadState('domcontentloaded')

      let selectedHour
      hoursLoop:
      for (const hour of config.hours) {
        const dateDeb = `[datedeb="${date.format('YYYY/MM/DD')} ${hour}:00:00"]`
        if (await page.locator(dateDeb).count()) {
          if (await page.isHidden(dateDeb)) {
            await page.click(`#head${location.replaceAll(' ', '')}${hour}h .panel-title`)
          }

          const courtNumbers = !Array.isArray(config.locations) ? config.locations[location] : []
          const slots = await page.locator(dateDeb).all()
          for (const slot of slots) {
            const bookSlotButton = `[courtid="${await slot.getAttribute('courtid')}"]${dateDeb}`
            if (courtNumbers.length > 0) {
              const courtName = (await page.locator(`.court:left-of(${bookSlotButton})`).innerText()).trim()
              if (!courtNumbers.includes(parseInt(courtName.match(/Court N°(\d+)/)[1]))) {
                continue
              }
            }

            const [priceType, courtType] = (await page.locator(`.row.tennis-court:has(${bookSlotButton})`).locator('.price-description').innerHTML()).split('<br>')
            if (!config.priceType.includes(priceType) || !config.courtType.includes(courtType)) {
              continue
            }
            selectedHour = hour
            await page.click(bookSlotButton)

            break hoursLoop
          }
        }
      }

      if (await page.title() !== 'Paris | TENNIS - Reservation') {
        console.log(`${dayjs().format()} - Aucun créneau retenu pour ${logLocation}`)
        continue
      }

      // Fallback: résoudre le CAPTCHA visuel si les abortions n'ont pas suffi
      if (page.url().includes('captcha')) {
        let captchaSolved = false
        for (let attempt = 1; attempt <= 3; attempt++) {
          await page.waitForLoadState('domcontentloaded')
          const captchaImg = await page.$('img')
          const captchaInput = await page.$('input[type="text"]')
          if (!captchaImg || !captchaInput) break
          try {
            const imgBuffer = await captchaImg.screenshot()
            const solution = await huggingFaceAPI(new Blob([imgBuffer], { type: 'image/png' }))
            console.log(`${dayjs().format()} - CAPTCHA tentative ${attempt}: "${solution}"`)
            await captchaInput.fill(solution)
            await page.click('text=Valider')
            await page.waitForLoadState('domcontentloaded')
            if (!page.url().includes('captcha')) { captchaSolved = true; break }
          } catch (captchaErr) {
            console.log(`${dayjs().format()} - CAPTCHA solver indisponible: ${captchaErr.message}`)
            break
          }
        }
        if (!captchaSolved) {
          console.log(`${dayjs().format()} - CAPTCHA non résolu, créneau ignoré pour ${logLocation}`)
          continue
        }
      }

      await page.waitForSelector('.order-steps-infos h2 >> text="1 / 3 - Validation du court"')

      for (const [i, player] of config.players.entries()) {
        if (i > 0) {
          await page.click('.addPlayer')
        }
        await page.waitForSelector(`[name="player${i + 1}"]`)
        await page.fill(`[name="player${i + 1}"] >> nth=0`, player.lastName)
        await page.fill(`[name="player${i + 1}"] >> nth=1`, player.firstName)
      }

      await page.keyboard.press('Enter')

      await page.waitForSelector('#order_select_payment_form #paymentMode', { state: 'attached' })
      const paymentMode = page.locator('#order_select_payment_form #paymentMode')
      await paymentMode.evaluate(el => {
        el.removeAttribute('readonly')
        el.style.display = 'block'
      })
      await paymentMode.fill('existingTicket')

      if (DRY_RUN_MODE) {
        console.log(`${dayjs().format()} - Fausse réservation faite : ${logLocation}`)
        if (!process.env.GITHUB_ACTIONS) console.log(`pour le ${date.format('YYYY/MM/DD')} à ${selectedHour}h`)
        console.log('----- DRY RUN END -----')
        console.log('Pour réellement réserver un crénau, relancez le script sans le paramètre --dry-run')

        await page.click('#previous')
        await page.click('#btnCancelBooking')

        booked = true
        break locationsLoop
      }

      const submit = page.locator('#order_select_payment_form #envoyer')
      await submit.evaluate(el => el.classList.remove('hide'))
      await submit.click()

      await page.waitForSelector('.confirmReservation', { timeout: 30000 }).catch(async () => {
        const url = page.url()
        const title = await page.title().catch(() => '?')
        console.log(`${dayjs().format()} - Confirmation non trouvée: ${url} | "${title}"`)
        await page.screenshot({ path: 'img/after-submit.png', fullPage: true }).catch(() => {})
      })

      const address = (await page.locator('.address').textContent()).trim().replace(/( ){2,}/g, ' ')
      const dateStr = (await page.locator('.date').textContent()).trim().replace(/( ){2,}/g, ' ')
      const court = (await page.locator('.court').textContent()).trim().replace(/( ){2,}/g, ' ')

      if (!process.env.GITHUB_ACTIONS) {
        console.log(`${dayjs().format()} - Réservation faite : ${address}`)
        console.log(`pour le ${dateStr}`)
        console.log(`sur le ${court}`)
      } else {
        console.log('Réservation faite, regardez vos emails ou rendez-vous sur votre compte tennis.paris.fr pour plus de détails sur votre réservation.')
      }

      const [day, month, year] = [date.date(), date.month() + 1, date.year()]
      const hourMatch = dateStr.match(/(\d{2})h/)
      const hour = hourMatch ? Number(hourMatch[1]) : 12
      const start = [year, month, day, hour, 0]
      const duration = { hours: 1, minutes: 0 }
      const event = {
        start,
        duration,
        title: 'Réservation Tennis',
        description: `Court: ${court}\nAdresse: ${address}`,
        location: address,
        status: 'CONFIRMED',
      }
      createEvent(event, async (error, value) => {
        if (error) {
          console.log('ICS creation error:', error)
          return
        }
        if (!process.env.GITHUB_ACTIONS) {
          writeFileSync('event.ics', value)
        }
        if (config.ntfy?.enable === true || process.env.NTFY_TOPIC) {
          await notify(Buffer.from(value, 'utf8'), 'event.ics',
            `Confirmation pour le ${date.format('DD/MM/YYYY')} - ${hour}h`, {
              domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
              topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
            })
        }
      })
      booked = true
      break
    }

    if (!booked) {
      const dateLabel = config.date ? dayjs(config.date, 'D/MM/YYYY').format('DD/MM/YYYY') : dayjs().add(6, 'days').format('DD/MM/YYYY')
      console.log(`${dayjs().format()} - Aucun créneau trouvé sur aucun des ${locations.length} terrain(s) pour le ${dateLabel}`)
      if (config.ntfy?.enable === true || process.env.NTFY_TOPIC) {
        await notify(null, null, `Aucun créneau disponible le ${dateLabel} sur ${locations.join(', ')}`, {
          domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
          topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
        })
      }
    }
  } catch (e) {
    console.log(e)
    const screenshot = await page.screenshot({ path: 'img/failure.png' })

    if (config.ntfy?.enable === true || process.env.NTFY_TOPIC) {
      await notify(screenshot, 'failure.png', 'Erreur lors de l\'execution du programme.', {
        domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
        topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
      })
    }
  }

  await browser.close()
}

bookTennis()
