// Home-screen install: Chrome/Android prompt, iPhone steps, already-installed. Run through ./run.sh.
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
const BASE = (process.env.BASE || 'http://127.0.0.1:8095') + '/'
const SHOTS = new URL('./shots/', import.meta.url).pathname
fs.mkdirSync(SHOTS, { recursive: true })
const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1 }
const errs = []
const signIn = async p => {
    p.on('pageerror', e => errs.push(e.message))
    // headless Chrome would fire its own install event; only our synthetic one below should count
    await p.evaluateOnNewDocument(() => addEventListener('beforeinstallprompt', e => { if (!e.prompt?.toString().includes('__prompted')) e.stopImmediatePropagation() }, { capture: true }))
    await p.goto(BASE, { waitUntil: 'networkidle0' })
    await p.evaluate(async () => {
        const body = JSON.stringify({ name: 'Cara', password: 'secret-cara' })
        const r = await fetch('/api/auth/register', { method: 'POST', body })
        if (r.status === 409) await fetch('/api/auth/login', { method: 'POST', body })
        localStorage.clear()
    })
    await p.reload({ waitUntil: 'networkidle0' })
    await p.waitForSelector('#library:not([hidden])')
}

// 1. Chrome / Android
let p = await b.newPage()
await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await signIn(p)
const cdp = await p.createCDPSession()
ok((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors.length === 0, 'Chrome: no installability errors')
const manifest = await (await fetch(BASE + 'manifest.webmanifest')).json()
ok(manifest.display === 'standalone' && manifest.id === '/' && manifest.screenshots.length === 2, 'manifest: standalone, id, screenshots')
ok(await p.$eval('#install-banner', e => e.hidden), 'Chrome: no banner until the browser offers install')
await p.evaluate(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true })
    e.prompt = () => { window.__prompted = true }
    e.userChoice = Promise.resolve({ outcome: 'accepted' })
    dispatchEvent(e)
})
await new Promise(r => setTimeout(r, 200))
await p.screenshot({ path: SHOTS + '50-install-banner.png' })
ok(!(await p.$eval('#install-banner', e => e.hidden)), 'Chrome: banner appears when installable')
await p.click('#install-btn')
await new Promise(r => setTimeout(r, 200))
ok(await p.evaluate(() => window.__prompted === true), 'Chrome: Install opens the native install dialog')
ok(await p.$eval('#install-banner', e => e.hidden), 'Chrome: banner hides after accepting')
await p.close()

// 2. iPhone Safari
p = await b.newPage()
await p.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')
await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await signIn(p)
ok(!(await p.$eval('#install-banner', e => e.hidden)), 'iPhone: banner shown')
await p.click('#install-btn')
await new Promise(r => setTimeout(r, 500))
await p.screenshot({ path: SHOTS + '51-ios-steps.png' })
ok(await p.$('#sheet-ios.open') !== null, 'iPhone: Install shows Add to Home Screen steps')
await p.click('#ios-done'); await new Promise(r => setTimeout(r, 450))
await p.click('#install-dismiss')
await p.reload({ waitUntil: 'networkidle0' })
ok(await p.$eval('#install-banner', e => e.hidden), 'iPhone: dismissed banner stays hidden')
await p.click('#account-btn'); await new Promise(r => setTimeout(r, 450))
ok(!(await p.$eval('#acct-install', e => e.hidden)), 'iPhone: install still offered in the account sheet')
await p.close()

// 3. Already installed (iOS home-screen app)
p = await b.newPage()
await p.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148')
await p.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'standalone', { get: () => true }))
await signIn(p)
ok(await p.$eval('#install-banner', e => e.hidden) && await p.$eval('#acct-install', e => e.hidden), 'installed app: no install prompts')
// 4. Offline: once the service worker has cached the app, it still opens without a network
p = await b.newPage()
await signIn(p)
await p.evaluate(() => navigator.serviceWorker.ready)
await p.reload({ waitUntil: 'networkidle0' }) // now the page is controlled by the worker
ok(await p.evaluate(() => !!navigator.serviceWorker.controller), 'service worker controls the page')
await p.setOfflineMode(true)
await p.reload({ waitUntil: 'domcontentloaded' })
await p.waitForSelector('#library:not([hidden])', { timeout: 5000 }).catch(() => {})
ok(await p.$eval('#library', e => !e.hidden), 'offline: the app still opens to the library')
await p.setOfflineMode(false)

console.log('page errors:', errs.length ? errs : 'none')
ok(!errs.length, 'no page errors')
await b.close()
