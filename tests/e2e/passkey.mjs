// Passkeys in real Chrome with its virtual authenticator: add one, sign out, sign back in with it, remove it.
// Passkeys need a domain, not an IP, so this spec talks to localhost.
import puppeteer from 'puppeteer-core'

const BASE = (process.env.BASE || 'http://127.0.0.1:8095').replace('127.0.0.1', 'localhost')
const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--lang=en-US'],
})
const errors = []
const page = await browser.newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1 }
const wait = ms => new Promise(r => setTimeout(r, ms))

// a phone-style platform authenticator that always passes Face ID
const cdp = await page.createCDPSession()
await cdp.send('WebAuthn.enable')
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true } })
const stored = async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials

await page.goto(BASE, { waitUntil: 'networkidle0' })
await page.waitForSelector('#auth:not([hidden])')
await wait(500) // the Account sheet slides away first
ok(await page.$eval('#auth-passkey', e => !e.hidden), 'sign-in screen offers a passkey')

// password account, then add a passkey from the Account sheet
await page.click('[data-mode="register"]')
await page.type('#auth-name', 'Kim')
await page.type('#auth-pass', 'secret-kim')
await page.click('#auth-submit')
await page.waitForSelector('#library:not([hidden])')
await page.click('#account-btn')
await page.waitForSelector('#sheet-account.open')
ok(await page.$eval('#acct-passkeys', e => !e.hidden), 'Account shows the passkeys section')
await wait(400)
await page.screenshot({ path: new URL('shots/30-passkeys.png', import.meta.url).pathname })
await page.click('#pk-add')
await page.waitForFunction(() => document.querySelectorAll('#pk-list li').length === 1, { timeout: 5000 })
ok((await stored()).length === 1, 'the device now holds a passkey')
ok(await page.$eval('#pk-list li', e => /Added/.test(e.textContent)), `passkey listed: ${await page.$eval('#pk-list li', e => e.textContent)}`)
await page.click('#pk-add')
await wait(800)
ok(await page.$eval('#toast', e => !e.hidden && /already has a passkey/.test(e.textContent)), 'adding the same device twice says so')
ok(await page.$$eval('#pk-list li', els => els.length) === 1, 'and keeps one entry')

// sign out, back in with the passkey: no name or password typed
await page.click('#acct-logout')
await page.waitForSelector('#auth:not([hidden])')
await wait(500) // the Account sheet slides away first
await page.$eval('#auth-name', e => e.value = '')
await page.click('#auth-passkey')
await page.waitForSelector('#library:not([hidden])', { timeout: 5000 }).catch(() => {})
ok(await page.$eval('#library', e => !e.hidden), 'passkey signs in')
ok(await page.$eval('#account-btn', e => e.textContent) === 'K', 'as the right account')

// remove it: the passkey no longer signs in
await page.click('#account-btn')
await page.waitForSelector('#sheet-account.open')
await wait(400)
await page.click('#pk-list li button')
await page.waitForFunction(() => !document.querySelectorAll('#pk-list li').length, { timeout: 5000 })
ok(true, 'passkey removed from the account')
await page.click('#acct-logout')
await page.waitForSelector('#auth:not([hidden])')
await wait(500) // the Account sheet slides away first
await page.click('#auth-passkey')
await page.waitForFunction(() => !document.querySelector('#auth-error').hidden, { timeout: 5000 })
ok(/isn't set up here/.test(await page.$eval('#auth-error', e => e.textContent)), 'a removed passkey is refused with a hint')

console.log('\nerrors:', errors.length ? errors : 'none')
ok(!errors.some(e => !/status of 401/.test(e)), 'no page errors besides the expected 401s')
await browser.close()
