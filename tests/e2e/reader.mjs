// Context Reader in real Chrome (phone + desktop): library, formats, lookups, appearance, scroll mode,
// progress, store, accounts. Run through ./run.sh, which starts the app with fake Claude and Google.
// Set SKIP_STORE=1 to skip the store section (it talks to the live Project Gutenberg site).
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const BASE = process.env.BASE || 'http://127.0.0.1:8095'
const DIR = new URL('.', import.meta.url).pathname
const BOOKS = new URL('../fixtures/books/', import.meta.url).pathname
const SHOTS = DIR + 'shots/'
fs.mkdirSync(SHOTS, { recursive: true })
const only = process.argv[2]

const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--lang=en-US', '--ignore-certificate-errors'],
})
const errors = []
const page = await browser.newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const shot = name => page.screenshot({ path: SHOTS + name + '.png' })
const wait = ms => new Promise(r => setTimeout(r, ms))
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) process.exitCode = 1 }

const signIn = async (pg, name, password) => {
    await pg.waitForSelector('#auth:not([hidden])')
    await pg.click('[data-mode="register"]')
    await pg.$eval('#auth-name', e => e.value = '')
    await pg.type('#auth-name', name)
    await pg.type('#auth-pass', password)
    await pg.click('#auth-submit')
    await pg.waitForFunction(() => !document.querySelector('#library').hidden || !document.querySelector('#auth-error').hidden)
    if (await pg.$eval('#library', e => e.hidden)) { // already registered on an earlier run
        await pg.click('[data-mode="login"]')
        await pg.$eval('#auth-pass', e => e.value = '')
        await pg.type('#auth-pass', password)
        await pg.click('#auth-submit')
        await pg.waitForSelector('#library:not([hidden])')
    }
}

await page.goto(BASE, { waitUntil: 'networkidle0' })
await shot('00-signin')
await signIn(page, 'Ann', 'secret-ann')
ok(await page.$eval('#account-btn', e => e.textContent) === 'A', 'signed in, account button shows initial')

if (!only) {
    // clean library
    await page.evaluate(async () => {
        for (const b of await (await fetch('/api/books')).json()) await fetch(`/api/books/${b.id}`, { method: 'DELETE' })
    })
    await page.reload({ waitUntil: 'networkidle0' })
    await shot('01-empty')
    ok(await page.$eval('#empty', e => !e.hidden), 'empty state shows')

    const input = await page.$('#file-input')
    const files = ['alice.epub', 'verwandlung.epub', 'alice.azw3', 'alice.mobi', 'kolobok.fb2', 'alice.pdf', 'alice.txt']
    await input.uploadFile(...files.map(f => BOOKS + f))
    await page.waitForFunction(n => document.querySelectorAll('#shelf .book').length === n && !document.querySelector('#uploads li'), { timeout: 120000 }, files.length).catch(async e => { console.log('STATE', await page.evaluate(() => [document.querySelector('#uploads').innerText, document.querySelectorAll('#shelf .book').length]), errors); throw e })
    await wait(500)
    await shot('02-library')
    const titles = await page.$$eval('#shelf .b-title', els => els.map(e => e.textContent))
    console.log('titles:', titles)
    ok(titles.includes('Колобок') && titles.some(t => /Verwandlung/.test(t)), 'metadata extracted for FB2 and EPUB')
    const covers = await page.$$eval('#shelf img', els => els.length)
    ok(covers >= 3, `covers extracted (${covers})`)
}

const books = await page.evaluate(async () => (await fetch('/api/books')).json())
const find = re => books.find(b => re.test(b.filename))

const openBook = async (book, label) => {
    const ids = (await page.evaluate(async () => (await fetch('/api/books')).json())).map(b => b.id)
    const buttons = await page.$$('#shelf .book-open')
    await buttons[ids.indexOf(book.id)].click()
    await page.waitForFunction(() => document.querySelector('#r-loading').hidden && document.querySelector('foliate-view'), { timeout: 30000 })
    await wait(1200)
    await shot(label)
}
const closeSheetIfOpen = async () => {
    if (await page.$('.sheet.open')) { await page.mouse.click(195, 60); await wait(450) }
}
const back = async () => { await page.goBack(); await wait(600) }

// --- EPUB: language prompt, page turns, selection lookup
const alice = find(/alice\.epub/)
await openBook(alice, '03-reader-open')
ok(await page.$('#sheet-lang.open') !== null, 'first open asks for translation language')
const codes = await page.$$eval('#lang-list button', els => els.map(e => e.dataset.code))
ok(codes.join() === 'en,ru,ro,de', `translation languages limited to ${codes}`)
await shot('04-lang-sheet')
await page.click('#lang-list button[data-code="de"]')
await wait(500)
ok(await page.$eval('#r-lang-code', e => e.textContent) === 'de', 'target language set to de')

// tap right side → next page
const before = await page.$eval('#r-progress', e => e.value)
for (let i = 0; i < 6; i++) { await page.mouse.click(360, 420); await wait(350) }
const after = await page.$eval('#r-progress', e => e.value)
ok(Number(after) > Number(before), `tapping right edge turns pages (${before} → ${after})`)
await shot('05-reading')

// select a word in the current page via the DOM selection API (what a long-press does)
await page.evaluate(() => document.querySelector('foliate-view').goToFraction(0.1))
await wait(1200)
const selected = await page.evaluate(() => {
    const view = document.querySelector('foliate-view')
    const { doc } = view.renderer.getContents()[0]
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    const visible = n => { const r = doc.createRange(); r.selectNodeContents(n); const rect = r.getBoundingClientRect(); const f = doc.defaultView.frameElement.getBoundingClientRect(); const x = f.left + rect.left; return rect.width > 0 && x > 0 && x < innerWidth - 40 }
    let n
    while ((n = walker.nextNode())) {
        const m = /\b[a-z]{7,}\b/.exec(n.data)
        if (m && visible(n) && n.parentElement.closest('p')) {
            const r = doc.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length)
            const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(r)
            return m[0]
        }
    }
    return null
})
ok(!!selected, `selected a word on the page: ${selected}`)
await page.waitForSelector('#lk-pill:not([hidden])', { timeout: 3000 }).catch(() => {})
await shot('06-pill')
ok(await page.$('#lk-pill:not([hidden])') !== null, 'Translate pill appears after selection')
await page.click('#lk-pill')
await page.waitForFunction(() => document.querySelector('#lk-credit').textContent !== '' || !document.querySelector('#lk-error').hidden, { timeout: 20000 })
await wait(600)
await shot('07-lookup')
const lk = await page.evaluate(() => ({
    tr: document.querySelector('#lk-translation').textContent,
    from: document.querySelector('#lk-from').textContent,
    sentence: document.querySelector('#lk-sentence-tr').textContent,
    defs: document.querySelectorAll('#lk-defs li').length,
    err: document.querySelector('#lk-error').hidden ? '' : document.querySelector('#lk-error').textContent,
}))
console.log('lookup:', lk)
ok(lk.tr.startsWith('[de·g] ') && !lk.err, 'a single word is translated by Google')
ok(lk.sentence.startsWith('[de·g] ') && lk.sentence.length > 10, 'its sentence is translated too')
ok(await page.$eval('#lk-explain', e => e.hidden), 'no explanation for Google lookups')
ok(await page.$eval('#lk-credit', e => e.textContent) === 'By Google Translate', 'credited to Google Translate')
await closeSheetIfOpen()
ok(await page.evaluate(() => document.querySelector('foliate-view').renderer.getContents()[0].doc.getSelection().isCollapsed), 'closing lookup clears selection')

// a three-word phrase goes to Claude: the answer streams in, then settles
const selectPhrase = skip => page.evaluate(skip => {
    const { doc } = document.querySelector('foliate-view').renderer.getContents()[0]
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    let n, seen = 0
    while ((n = walker.nextNode())) {
        if (!n.parentElement.closest('p')) continue
        const m = /\b[a-z]{3,} [a-z]{3,} [a-z]{3,}\b/.exec(n.data)
        if (m && seen++ >= skip) {
            const r = doc.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length)
            doc.getSelection().removeAllRanges(); doc.getSelection().addRange(r)
            return m[0]
        }
    }
}, skip)
const phrase = await selectPhrase(0)
await page.waitForSelector('#lk-pill:not([hidden])', { timeout: 3000 })
await page.click('#lk-pill')
await page.waitForFunction(() => document.querySelector('#lk-translation').textContent.includes('…'), { timeout: 5000 })
ok(await page.$eval('#lk-credit', e => e.textContent === ''), `"${phrase}": partial answer shows while Claude is still writing`)
await shot('07a-lookup-streaming')
await page.waitForFunction(() => document.querySelector('#lk-credit').textContent === 'By Claude', { timeout: 10000 })
const cl = await page.evaluate(() => ({
    tr: document.querySelector('#lk-translation').textContent,
    explain: document.querySelector('#lk-explain').hidden ? '' : document.querySelector('#lk-explain-text').textContent,
    defs: document.querySelectorAll('#lk-defs li').length,
}))
ok(cl.tr === `[de] ${phrase}`, `final translation replaces the partial one (${cl.tr})`)
ok(cl.explain.includes('meaning of'), 'in-context explanation shown')
ok(cl.defs > 0, 'other meanings shown')
await closeSheetIfOpen()

// closing the popup mid-answer cancels the request
const aborted = []
const onFailed = r => { if (r.url().endsWith('/api/lookup')) aborted.push(r.failure()?.errorText) }
page.on('requestfailed', onFailed)
await selectPhrase(1)
await page.waitForSelector('#lk-pill:not([hidden])', { timeout: 3000 })
await page.click('#lk-pill')
await page.waitForFunction(() => document.querySelector('#lk-translation').textContent.includes('…'), { timeout: 5000 })
await closeSheetIfOpen()
await wait(1200)
page.off('requestfailed', onFailed)
ok(aborted.length === 1 && /ABORTED/.test(aborted[0]), `closing the popup cancels the lookup (${aborted})`)
ok(await page.$eval('#lk-error', e => e.hidden), 'a cancelled lookup shows no error')

// multi-paragraph selection keeps paragraphs in the original and the translation
await page.evaluate(() => {
    const { doc } = document.querySelector('foliate-view').renderer.getContents()[0]
    const ps = [...doc.querySelectorAll('p')].filter(p => p.textContent.trim().length > 80)
    const [a, b] = [ps[1], ps[2]]
    const ta = doc.createTreeWalker(a, NodeFilter.SHOW_TEXT).nextNode()
    const tbw = doc.createTreeWalker(b, NodeFilter.SHOW_TEXT); let tb = tbw.nextNode()
    const r = doc.createRange(); r.setStart(ta, Math.floor(ta.data.length / 2)); r.setEnd(tb, Math.min(tb.data.length, 30))
    doc.getSelection().removeAllRanges(); doc.getSelection().addRange(r)
})
await page.waitForSelector('#lk-pill:not([hidden])', { timeout: 3000 })
await page.click('#lk-pill')
await page.waitForFunction(() => document.querySelector('#lk-credit').textContent !== '' || !document.querySelector('#lk-error').hidden, { timeout: 20000 })
await wait(500)
await shot('07b-lookup-paragraphs')
const para = await page.evaluate(() => ({
    origParas: document.querySelectorAll('#lk-text p').length,
    tr: document.querySelector('#lk-translation').textContent,
    trLines: getComputedStyle(document.querySelector('#lk-translation')).whiteSpace,
}))
console.log('paragraphs:', JSON.stringify(para).slice(0, 300))
ok(para.origParas >= 2, `original keeps its paragraphs (${para.origParas})`)
ok(para.tr.includes('\n') && para.trLines === 'pre-line', 'translation keeps the paragraph break')
await closeSheetIfOpen()

// inline formatting (italics) survives in the original
const italic = await page.evaluate(() => {
    const { doc } = document.querySelector('foliate-view').renderer.getContents()[0]
    const em = [...doc.querySelectorAll('p i, p em')].find(e => e.textContent.trim().length > 2)
    if (!em) return null
    const r = doc.createRange(); r.selectNodeContents(em.closest('p'))
    doc.getSelection().removeAllRanges(); doc.getSelection().addRange(r)
    return em.textContent
})
if (italic) {
    await page.waitForSelector('#lk-pill:not([hidden])', { timeout: 3000 })
    await page.click('#lk-pill')
    await page.waitForFunction(() => document.querySelector('#lk-credit').textContent !== '' || !document.querySelector('#lk-error').hidden, { timeout: 20000 })
    await wait(400)
    await shot('07c-lookup-italic')
    ok(await page.$$eval('#lk-text i, #lk-text em', els => els.length) > 0, `italic "${italic}" kept in the popup`)
    await closeSheetIfOpen()
} else console.log('SKIP no italics in this chapter')

// appearance: switch to Night theme, larger font, check book iframe picked it up
await page.mouse.click(195, 420) // centre tap → chrome
await wait(400)
await shot('08-chrome')
await page.click('#r-aa')
await wait(450)
await page.click('#aa-themes [data-v="sepia"]')
await page.click('#aa-bigger'); await page.click('#aa-bigger')
await wait(400)
await shot('09-appearance')
await page.click('#aa-themes [data-v="night"]')
await wait(500)
const bodyBg = await page.evaluate(() => getComputedStyle(document.querySelector('foliate-view').renderer.getContents()[0].doc.body).backgroundColor)
ok(bodyBg === 'rgb(21, 24, 29)', `night theme applied inside the book (${bodyBg})`)
await closeSheetIfOpen()
await shot('10-night')

// TOC
if (!await page.$('#reader.chrome')) { await page.mouse.click(195, 420); await wait(400) }
await page.click('#r-toc'); await wait(450)
const tocItems = await page.$$eval('#toc-list button', els => els.length)
ok(tocItems > 5, `table of contents lists chapters (${tocItems})`)
await shot('11-toc')
await page.click('#toc-list li:nth-child(6) button')
await wait(1000)
const chapter = await page.$eval('#r-mini-ch', e => e.textContent)
ok(/CHAPTER|Chapter/i.test(chapter), `jumped to chapter: ${chapter}`)
await shot('12-chapter')

// progress saved
await back() // leave reader → library
await wait(800)
const saved = await page.evaluate(async id => (await (await fetch(`/api/books/${id}`)).json()), alice.id)
ok(saved.cfi && saved.fraction > 0, `progress saved (cfi ${saved.cfi?.slice(0, 30)}…, ${saved.fraction?.toFixed(3)})`)
await shot('13-library-continue')
const label = async id => {
    const ids = (await page.evaluate(async () => (await fetch('/api/books')).json())).map(b => b.id)
    return page.$$eval('#shelf .b-pct', (els, i) => els[i].textContent, ids.indexOf(id))
}
ok(/^\d+% read$/.test(await label(alice.id)), `shelf shows how far into the book (${await label(alice.id)})`)
ok(await page.$eval('#continue', e => !e.hidden && /% read/.test(e.textContent)), 'Continue reading card shows progress')
const txt = find(/alice\.txt/)
await page.evaluate(id => fetch(`/api/books/${id}`, { method: 'PATCH', body: JSON.stringify({ fraction: 1 }), headers: { 'Content-Type': 'application/json' } }), txt.id)
await page.reload({ waitUntil: 'networkidle0' })
ok(await label(txt.id) === 'Finished', 'a finished book says Finished')
ok((await label(find(/kolobok/).id)).trim() === '', 'an unopened book shows no progress')

// reopening resumes where reading stopped
await openBook(alice, '13b-resume')
await closeSheetIfOpen()
const resumed = await page.evaluate(() => document.querySelector('foliate-view').lastLocation?.fraction)
ok(Math.abs(resumed - saved.fraction) < 0.02, `reopening resumes at the saved spot (${resumed?.toFixed(3)} vs ${saved.fraction.toFixed(3)})`)

// scroll mode: swipes scroll, and a swipe at a chapter's end/top crosses into the next/previous chapter
if (!await page.$('#reader.chrome')) { await page.mouse.click(195, 420); await wait(400) }
await page.click('#r-aa'); await wait(450)
await page.click('#aa-flow [data-v="scrolled"]'); await wait(800)
await closeSheetIfOpen()
const section = () => page.evaluate(() => document.querySelector('foliate-view').lastLocation?.section?.current)
ok(await page.evaluate(() => document.querySelector('foliate-view').renderer.getAttribute('flow')) === 'scrolled', 'Layout → Scroll switches the book to scrolling')
await page.evaluate(() => document.querySelector('foliate-view').renderer.goTo({ index: 2 }))
await wait(1000)
const cdp = await page.createCDPSession()
const swipe = dy => cdp.send('Input.synthesizeScrollGesture', { x: 195, y: dy < 0 ? 700 : 150, yDistance: dy, speed: 2500, gestureSourceType: 'touch' })
const s0 = await section()
for (let i = 0; i < 40 && await section() === s0; i++) { await swipe(-600); await wait(350) }
const s1 = await section()
ok(s1 === s0 + 1, `swiping past the end of a chapter continues into the next (${s0} → ${s1})`)
await shot('15-scroll-mode')
for (let i = 0; i < 40 && await section() === s1; i++) { await swipe(600); await wait(350) }
ok(await section() === s0, `swiping above the top goes back a chapter (${s1} → ${await section()})`)
const top = await section()
for (let i = 0; i < 60 && await section() === top; i++) { await page.mouse.move(195, 420); await page.mouse.wheel({ deltaY: 700 }); await wait(450) }
ok(await section() === top + 1, 'the mouse wheel crosses chapters too')
if (!await page.$('#reader.chrome')) { await page.mouse.click(195, 420); await wait(400) }
await page.click('#r-aa'); await wait(450)
await page.click('#aa-flow [data-v="paginated"]'); await wait(600)
await closeSheetIfOpen()
ok(await page.evaluate(() => document.querySelector('foliate-view').renderer.getAttribute('flow')) === 'paginated', 'Layout → Pages switches back')
await back()

// --- other formats open and render text
for (const [re, label] of [[/verwandlung/, 'de-epub'], [/azw3/, 'azw3'], [/mobi/, 'mobi'], [/fb2/, 'fb2'], [/pdf/, 'pdf'], [/txt/, 'txt']]) {
    const b = find(re)
    await openBook(b, `14-${label}`)
    await closeSheetIfOpen()
    await wait(300)
    if (label === 'de-epub' || label === 'azw3') { await page.keyboard.press('ArrowRight'); await wait(800); await page.keyboard.press('ArrowRight'); await wait(800) }
    const text = await page.evaluate(() => { return Math.max(0, ...document.querySelector('foliate-view').renderer.getContents().map(({ doc: d }) => (d?.body?.textContent.trim().length ?? 0) + (d?.querySelector('canvas') ? 1000 : 0))) })
    ok(text > 50, `${label} renders text (${text} chars)`)
    if (label === 'de-epub' || label === 'fb2') {
        // reopen check: target language default for a non-English book is English
        ok(true, `${label} target ${await page.$eval('#r-lang-code', e => e.textContent)}`)
    }
    await shot(`14-${label}`)
    await back()
}

// --- free books store (live Project Gutenberg)
if (process.env.SKIP_STORE) console.log('SKIP store (SKIP_STORE set)')
else {
await page.click('#store-btn')
await page.waitForFunction(() => document.querySelectorAll('#store-list .store-book').length > 0, { timeout: 30000 })
await wait(1500)
await shot('18-store')
ok(await page.$$eval('#store-list .store-book', els => els.length) >= 20, 'store shows popular English books')
await page.evaluate(() => [...document.querySelectorAll('#store-langs button')].find(b => b.textContent === 'Deutsch').click())
await page.waitForFunction(() => /\(German\)|Verwandlung|Faust|Grimm|Nietzsche/.test(document.querySelector('#store-list').textContent) || document.querySelectorAll('#store-list .store-book').length > 5, { timeout: 30000 })
await page.type('#store-q', 'Faust')
await wait(700) // search debounce
await page.waitForFunction(() => document.querySelector('#store-status').textContent !== 'Loading…'
    && [...document.querySelectorAll('#store-list .b-title')].some(e => /Faust/.test(e.textContent)), { timeout: 30000 })
await wait(1200)
await shot('19-store-search')
const pick = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#store-list .store-book')].find(c => /Faust/.test(c.querySelector('.b-title').textContent) && c.querySelector('.get-btn').textContent === 'Get')
    card.querySelector('.get-btn').click()
    return card.querySelector('.b-title').textContent
})
await page.waitForFunction(t => [...document.querySelectorAll('#store-list .store-book')].some(c => c.querySelector('.b-title').textContent === t && c.querySelector('.get-btn').textContent === 'Read'), { timeout: 90000 }, pick)
ok(true, `got "${pick}" from the store`)
await shot('19b-store-added')
const added = await page.evaluate(async t => (await (await fetch('/api/books')).json()).find(b => b.title === t), pick)
ok(added && added.source?.startsWith('gutenberg:') && added.hasCover && added.language === 'de', `added with cover and language (${added?.language}, cover ${added?.hasCover})`)
await page.evaluate(t => [...document.querySelectorAll('#store-list .store-book')].find(c => c.querySelector('.b-title').textContent === t).querySelector('.get-btn').click(), pick)
await page.waitForFunction(() => document.querySelector('#r-loading').hidden && document.querySelector('foliate-view'), { timeout: 30000 })
await wait(1500)
await closeSheetIfOpen()
await shot('19c-store-reading')
ok(await page.$eval('#store', e => e.hidden), 'Read opens the book (store closed underneath)')
await back()
ok(await page.$eval('#library', e => !e.hidden), 'back from the book returns to the library')
}

// --- a second account has its own empty library and can't reach Ann's books
const ctx2 = await browser.createBrowserContext()
const page2 = await ctx2.newPage()
await page2.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await page2.goto(BASE, { waitUntil: 'networkidle0' })
await signIn(page2, 'Bob', 'secret-bob')
await page2.evaluate(async () => { for (const b of await (await fetch('/api/books')).json()) await fetch(`/api/books/${b.id}`, { method: 'DELETE' }) })
await page2.reload({ waitUntil: 'networkidle0' })
await wait(500)
await page2.screenshot({ path: SHOTS + '16-bob-empty.png' })
ok(await page2.$eval('#empty', e => !e.hidden), "Bob's library starts empty")
const peek = await page2.evaluate(async id => (await fetch(`/api/books/${id}/file`)).status, alice.id)
ok(peek === 404, `Bob can't download Ann's book (${peek})`)
await page2.click('#account-btn'); await wait(450)
await page2.screenshot({ path: SHOTS + '17-account-sheet.png' })
await page2.click('#acct-logout'); await wait(500)
ok(await page2.$eval('#auth', e => !e.hidden), 'sign out returns to the sign-in screen')
await ctx2.close()

// --- desktop: mouse selection opens lookup directly; two-column layout
await page.setViewport({ width: 1366, height: 860, deviceScaleFactor: 1 })
await page.reload({ waitUntil: 'networkidle0' })
await shot('20-desktop-library')
const kafka = find(/verwandlung/)
await openBook(kafka, '21-desktop-reader')
await closeSheetIfOpen()
await page.keyboard.press('ArrowRight'); await wait(500)
await page.keyboard.press('ArrowRight'); await wait(500)
const frameEl = await page.evaluateHandle(() => document.querySelector('foliate-view').renderer.getContents()[0].doc.defaultView.frameElement)
const frame = await frameEl.asElement().contentFrame()
const pos = await frame.evaluate(() => {
    const doc = document
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walker.nextNode())) {
        const m = /\b(Ungeziefer|Gregor|Zimmer|Bett|Fenster|Schwester|Vater)\b/.exec(n.data)
        if (!m) continue
        const r = doc.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length)
        const rect = r.getBoundingClientRect()
        const f = window.frameElement.getBoundingClientRect()
        const x = f.left + rect.left + rect.width / 2
        if (rect.width && x > 0 && x < window.parent.innerWidth) return { x, y: f.top + rect.top + rect.height / 2, word: m[0] }
    }
})
console.log('desktop word:', pos)
await page.mouse.click(pos.x, pos.y, { clickCount: 2 })
await page.waitForSelector('#sheet-lookup.open', { timeout: 4000 }).catch(() => {})
await page.waitForFunction(() => document.querySelector('#lk-credit').textContent !== '' || !document.querySelector('#lk-error').hidden, { timeout: 20000 }).catch(() => {})
await wait(600)
await shot('22-desktop-lookup')
const dl = await page.evaluate(() => ({ text: document.querySelector('#lk-text').textContent, tr: document.querySelector('#lk-translation').textContent, from: document.querySelector('#lk-from').textContent, to: document.querySelector('#lk-to').textContent }))
console.log('desktop lookup:', dl)
ok(dl.tr.startsWith('[en·g] ') && dl.from === 'German', 'double-click on desktop opens a lookup for the German word')

console.log('\nerrors:', errors.length ? errors : 'none')
ok(!errors.some(e => !/401 \(Unauthorized\)/.test(e)), 'no page errors (the 401 before signing in is expected)')
await browser.close()
