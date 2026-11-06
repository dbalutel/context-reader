import { makeBook } from './vendor/foliate/view.js'
import { makeTextBook } from './text-book.js'

const $ = s => document.querySelector(s)
const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue
        if (k === 'class') el.className = v
        else if (k === 'style') el.style.cssText = v
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
        else el.setAttribute(k, v === true ? '' : v)
    }
    el.append(...kids.flat().filter(k => k != null && k !== false))
    return el
}
const icon = name => {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('class', 'ic')
    svg.setAttribute('aria-hidden', 'true')
    const use = document.createElementNS(ns, 'use')
    use.setAttribute('href', `#i-${name}`)
    svg.append(use)
    return svg
}
const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)) } catch {} },
}

// ---------- languages ----------

const LANGS = ('af sq am ar hy az eu be bn bs bg ca zh-CN zh-TW hr cs da nl en eo et fi fr gl ka de el gu ht he hi hu is id ga it ja '
    + 'kn kk km ko ky lo la lv lt lb mk ms ml mt mr mn my ne no fa pl pt pa ro ru sr si sk sl es sw sv tl tg ta tt te th tr tk uk ur uz vi cy yi zu').split(' ')
const uiLocale = navigator.language || 'en'
const nameIn = locale => { try { return new Intl.DisplayNames([locale], { type: 'language' }) } catch { return null } }
const uiNames = nameIn(uiLocale)
const langName = code => (code && code !== 'auto' && uiNames?.of(code)) || code
const nativeName = code => { try { return nameIn(code)?.of(code) ?? '' } catch { return '' } }
const LANG3 = { eng: 'en', rus: 'ru', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it', por: 'pt', jpn: 'ja', zho: 'zh-CN', chi: 'zh-CN', pol: 'pl', ukr: 'uk', nld: 'nl', dut: 'nl', swe: 'sv', tur: 'tr', kor: 'ko', ara: 'ar', ces: 'cs', cze: 'cs', heb: 'he' }
const normLang = raw => {
    if (!raw) return ''
    let code = String(Array.isArray(raw) ? raw[0] : raw).trim().replace('_', '-')
    const base = code.split('-')[0].toLowerCase()
    if (LANG3[base]) return LANG3[base]
    if (base === 'zh') return /tw|hk|hant/i.test(code) ? 'zh-TW' : 'zh-CN'
    if (base === 'iw') return 'he'
    return LANGS.includes(base) ? base : ''
}
const TARGETS = ['en', 'ru', 'ro', 'de'] // same list as TARGET_LANGS in server.py
let me = null // signed-in user
const userKey = key => me ? `${key}:${me.id}` : key
const defaultTarget = bookLang => {
    const base = (bookLang || '').split('-')[0]
    return [store.get(userKey('lastTarget')), normLang(uiLocale), ...TARGETS].find(c => TARGETS.includes(c) && c !== base)
}

// ---------- settings & themes ----------

const THEMES = {
    paper: { name: 'Paper', bg: '#FBFBF8', fg: '#23252A', link: '#2B5DB8' },
    sepia: { name: 'Sepia', bg: '#F2E7CF', fg: '#4B3B28', link: '#8A4B12' },
    mist: { name: 'Mist', bg: '#E4EAF0', fg: '#1F2A36', link: '#2753A8' },
    sage: { name: 'Sage', bg: '#DCE5D6', fg: '#24312A', link: '#2C6648' },
    dusk: { name: 'Dusk', bg: '#2A2E39', fg: '#D7DAE1', link: '#A3BBFF' },
    night: { name: 'Night', bg: '#15181D', fg: '#BEC4CC', link: '#8FB0F0' },
    black: { name: 'Black', bg: '#000000', fg: '#A8ADB4', link: '#8FB0F0' },
    custom: { name: 'Custom' },
}
const FONTS = {
    literata: '"Literata", Georgia, serif',
    source: '"Source Serif 4", Georgia, serif',
    atkinson: '"Atkinson Hyperlegible Next", system-ui, sans-serif',
    publisher: null,
}
const DEFAULTS = {
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'paper',
    customBg: '#FFF8E7', customFg: '#2B2B2B',
    font: 'literata', fontSize: 19, lineHeight: 1.55, margin: 6,
    flow: 'paginated', justify: true, hyphenate: true, animated: true,
}
const settings = { ...DEFAULTS }
const loadSettings = () => Object.assign(settings, DEFAULTS, store.get(userKey('settings'), store.get('settings', {})))
const saveSettings = () => store.set(userKey('settings'), settings)

const luminance = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map(c => c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    return .2126 * r + .7152 * g + .0722 * b
}
const themeColors = () => {
    const t = settings.theme === 'custom'
        ? { bg: settings.customBg, fg: settings.customFg, link: settings.customFg }
        : THEMES[settings.theme] ?? THEMES.paper
    return { ...t, dark: luminance(t.bg) < .3 }
}

const bookCSS = () => {
    const t = themeColors()
    const font = FONTS[settings.font]
    return `
@import url("${location.origin}/fonts/fonts.css");
@namespace epub "http://www.idpf.org/2007/ops";
html { color-scheme: ${t.dark ? 'dark' : 'light'}; font-size: ${settings.fontSize}px !important; -webkit-text-size-adjust: none; touch-action: manipulation; }
html, body { background: ${t.bg} !important; color: ${t.fg} !important; }
body { font-size: 1rem !important; }
body *:not(a):not(img):not(svg):not(image):not(video) { color: inherit !important; background-color: transparent !important; }
${font ? `body, body p, body div, body span, body li, body blockquote, body dd, body dt, body td, body h1, body h2, body h3, body h4, body h5, body h6 { font-family: ${font} !important; }` : ''}
a:link, a:visited { color: ${t.link} !important; }
p, li, blockquote, dd {
    line-height: ${settings.lineHeight} !important;
    text-align: ${settings.justify ? 'justify' : 'start'};
    -webkit-hyphens: ${settings.hyphenate ? 'auto' : 'manual'}; hyphens: ${settings.hyphenate ? 'auto' : 'manual'};
    hanging-punctuation: allow-end last; widows: 2; orphans: 2;
}
[align="left"] { text-align: left; } [align="right"] { text-align: right; }
[align="center"] { text-align: center; } [align="justify"] { text-align: justify; }
::selection { background: ${t.dark ? 'rgba(232,200,56,.42)' : 'rgba(246,216,74,.7)'}; }
pre { white-space: pre-wrap !important; }
${t.dark ? 'img { filter: brightness(.88); }' : ''}
aside[epub|type~="endnote"], aside[epub|type~="footnote"], aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }`
}

const applyThemeVars = () => {
    const t = themeColors()
    const root = document.documentElement.style
    root.setProperty('--r-bg', t.bg)
    root.setProperty('--r-fg', t.fg)
    $('meta[name="theme-color"]').content = document.body.classList.contains('reading') ? t.bg : getComputedStyle(document.body).getPropertyValue('--bg').trim()
}

// ---------- api ----------

const api = async (path, opts = {}) => {
    const res = await request(path, opts)
    return res.status === 204 ? null : res.json()
}
const request = async (path, opts = {}) => {
    const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers } })
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
        showAuth()
        throw new Error('Sign in to continue.')
    }
    if (!res.ok) {
        let msg
        try { msg = (await res.json()).error } catch {}
        throw new Error(msg || (res.status >= 500 ? 'The server is not responding. Check your connection.' : `Request failed (${res.status})`))
    }
    return res
}
const patchBook = (id, data) => api(`/api/books/${id}`, { method: 'PATCH', body: JSON.stringify(data), keepalive: true })

// ---------- layers (sheets + reader) wired to the back button ----------

const layers = []
const pushLayer = close => { layers.push(close); history.pushState({ depth: layers.length }, '') }
addEventListener('popstate', () => layers.pop()?.())
const back = () => layers.length ? history.back() : null

const scrim = $('#scrim')
let sheet = null // { el, onClose, opener }
const showSheetEl = el => { el.hidden = false; scrim.hidden = false; requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open'))) }
const hideSheetEl = el => {
    el.classList.remove('open', 'dragging')
    el.style.transform = ''
    const done = () => { if (!el.classList.contains('open')) el.hidden = true }
    el.addEventListener('transitionend', done, { once: true })
    setTimeout(done, 400)
}
const openSheet = (el, onClose) => {
    const opener = document.activeElement
    if (sheet) {
        if (sheet.el !== el) hideSheetEl(sheet.el)
        sheet.onClose?.()
        sheet = { el, onClose, opener: sheet.opener }
        showSheetEl(el)
        return
    }
    sheet = { el, onClose, opener }
    showSheetEl(el)
    setTimeout(() => el.querySelector('.sheet-body button, .sheet-body input:not([type=range])')?.focus({ preventScroll: true }), 320)
    pushLayer(() => {
        const s = sheet
        if (!s) return
        sheet = null
        scrim.hidden = true
        hideSheetEl(s.el)
        s.onClose?.()
        s.opener?.focus?.({ preventScroll: true })
    })
}
const closeSheet = () => { if (sheet) back() }
scrim.addEventListener('click', closeSheet)

// drag a sheet down by its grip to dismiss
for (const el of document.querySelectorAll('.sheet')) {
    const grip = el.querySelector('.grip')
    let start = null
    grip.addEventListener('pointerdown', e => { start = e.clientY; grip.setPointerCapture(e.pointerId); el.classList.add('dragging') })
    grip.addEventListener('pointermove', e => { if (start != null) el.style.transform = `translateY(${Math.max(0, e.clientY - start)}px)` })
    const end = e => {
        if (start == null) return
        const dy = e.clientY - start
        start = null
        el.classList.remove('dragging')
        el.style.transform = ''
        if (dy > 70) closeSheet()
    }
    grip.addEventListener('pointerup', end)
    grip.addEventListener('pointercancel', end)
}

let toastTimer
const toast = msg => {
    const el = $('#toast')
    el.textContent = msg
    el.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.hidden = true, 3200)
}

// ---------- library ----------

let books = []
const byId = id => books.find(b => b.id === id)
const HUES = ['#3E5C76', '#6B4E71', '#4F6D5A', '#8C5E3C', '#5A5F73', '#2F4858', '#7A4A4A', '#4A6670', '#5C5470']
const hash = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)

const genCover = book => h('div', { class: 'gen-cover', style: `--hue:${HUES[hash(String(book.id)) % HUES.length]}` },
    h('strong', {}, book.title || 'Untitled'), h('span', {}, book.author || ''))
const coverEl = book => h('div', { class: 'cover' },
    book.hasCover ? h('img', { src: `/api/books/${book.id}/cover`, alt: '', loading: 'lazy', decoding: 'async' }) : genCover(book))
const meter = fraction => h('div', { class: 'meter', role: 'presentation' }, h('span', { style: `width:${Math.round((fraction || 0) * 100)}%` }))
const pct = f => `${Math.round((f || 0) * 100)}%`

const renderLibrary = () => {
    const shelf = $('#shelf')
    shelf.replaceChildren(...books.map(book => h('li', { class: 'book' },
        h('button', { class: 'book-open', type: 'button', onclick: () => openBook(book.id), 'aria-label': `${book.title}${book.author ? `, ${book.author}` : ''}, ${pct(book.fraction)} read` },
            coverEl(book),
            h('p', { class: 'b-title' }, book.title || 'Untitled'),
            h('p', { class: 'b-author' }, book.author || ' '),
            meter(book.fraction),
            h('p', { class: 'b-pct' }, !book.fraction ? '\u00a0' : book.fraction >= 0.995 ? 'Finished' : `${pct(book.fraction)} read`)),
        h('button', { class: 'icon-btn book-more', type: 'button', 'aria-label': `Options for ${book.title}`, onclick: () => openBookOptions(book.id) },
            icon('more')))))

    const recent = books.find(b => b.lastOpened)
    const cont = $('#continue')
    cont.hidden = !recent
    if (recent) cont.replaceChildren(h('button', { class: 'continue-card', type: 'button', onclick: () => openBook(recent.id) },
        coverEl(recent),
        h('div', {},
            h('p', { class: 'c-label' }, 'Continue reading'),
            h('h2', {}, recent.title || 'Untitled'),
            h('p', { class: 'c-author' }, recent.author || ''),
            meter(recent.fraction),
            h('p', { class: 'c-meta' }, `${pct(recent.fraction)} read${recent.targetLang ? ` · Translating into ${langName(recent.targetLang)}` : ''}`))))

    $('#shelf-wrap').hidden = !books.length
    $('#shelf-count').textContent = books.length ? `(${books.length})` : ''
    $('#empty').hidden = books.length > 0 || $('#uploads').children.length > 0
}

const loadLibrary = async () => {
    try { books = await api('/api/books') }
    catch (e) { toast(e.message) }
    renderLibrary()
}

// ---------- uploads ----------

const SUPPORTED = /\.(epub|mobi|azw3?|kf8|prc|fb2|fbz|fb2\.zip|cbz|pdf|txt|html?)$/i
const isText = name => /\.(txt|html?)$/i.test(name)
const formatName = x => !x ? '' : typeof x === 'string' ? x : x[Object.keys(x)[0]] ?? ''
const formatContributors = a => (Array.isArray(a) ? a : [a]).map(c => typeof c === 'string' ? c : formatName(c?.name)).filter(Boolean).join(', ')

const parseBook = file => isText(file.name) ? makeTextBook(file) : makeBook(file)

const shrinkCover = async blob => {
    const bmp = await createImageBitmap(blob)
    const scale = Math.min(1, 720 / bmp.height)
    const canvas = h('canvas', { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) })
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height)
    return new Promise(r => canvas.toBlob(r, 'image/jpeg', .85))
}

const MAX_BOOK = 100 * 1000 * 1000 // same limit as the server
const xhrUpload = (file, onProgress) => new Promise((resolve, reject) => {
    if (file.size > MAX_BOOK) return reject(new Error('Books must be smaller than 100 MB.'))
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/books')
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name))
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
        let data
        try { data = JSON.parse(xhr.responseText) } catch {}
        xhr.status < 300 ? resolve(data) : reject(new Error(data?.error || `Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'))
    xhr.send(file)
})

const addFiles = async files => {
    const list = $('#uploads')
    $('#empty').hidden = true
    for (const file of files) {
        const bar = h('span', { style: 'width:0%' })
        const label = h('span', {}, `Adding “${file.name}”…`)
        const row = h('li', {}, label, h('div', { class: 'meter' }, bar))
        list.append(row)
        try {
            if (!SUPPORTED.test(file.name)) throw new Error(`“${file.name}” isn't a supported format. Use EPUB, MOBI, AZW3, FB2, PDF, CBZ or TXT.`)
            let book
            try { book = await parseBook(file) }
            catch { throw new Error(`“${file.name}” couldn't be opened. The file may be damaged or DRM-protected.`) }
            const meta = await xhrUpload(file, p => bar.style.width = `${Math.round(p * 100)}%`)
            const title = formatName(book.metadata?.title).trim() || meta.title
            await patchBook(meta.id, { title, author: formatContributors(book.metadata?.author), language: normLang(book.metadata?.language) })
            try {
                const cover = await book.getCover?.()
                if (cover) await fetch(`/api/books/${meta.id}/cover`, { method: 'PUT', body: await shrinkCover(cover) })
            } catch {} // a missing cover is fine: the shelf draws one
            row.remove()
            toast(`Added “${title}”`)
        } catch (e) {
            row.className = 'err'
            label.textContent = e.message
            bar.parentElement.remove()
            setTimeout(() => row.remove(), 9000)
        }
        await loadLibrary()
    }
}

const fileInput = $('#file-input')
for (const btn of [$('#add-btn'), $('#empty-add')]) btn.addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = '' })

let dragDepth = 0
addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files') && !$('#library').hidden) { dragDepth++; $('#drop-overlay').hidden = false } })
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true } })
addEventListener('dragover', e => e.preventDefault())
addEventListener('drop', e => {
    e.preventDefault()
    dragDepth = 0
    $('#drop-overlay').hidden = true
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length && !$('#library').hidden) addFiles(files)
})

// ---------- book options ----------

const openBookOptions = id => {
    const book = byId(id)
    if (!book) return
    $('#bk-cover').replaceChildren(coverEl(book))
    $('#bk-title').textContent = book.title || 'Untitled'
    $('#bk-author').textContent = book.author || ''
    $('#bk-lang-name').textContent = book.targetLang ? langName(book.targetLang) : 'Not set'
    const remove = $('#bk-remove')
    remove.textContent = 'Remove from library'
    remove.dataset.armed = ''
    $('#bk-read').onclick = () => { closeSheet(); setTimeout(() => openBook(id), 50) }
    $('#bk-lang').onclick = () => openLangSheet(book)
    remove.onclick = async () => {
        if (!remove.dataset.armed) {
            remove.dataset.armed = '1'
            remove.textContent = 'Tap again to remove this book'
            return
        }
        try {
            await api(`/api/books/${id}`, { method: 'DELETE' })
            caches?.open('books').then(c => c.delete(`/api/books/${id}/file`)).catch(() => {})
            closeSheet()
            toast(`Removed “${book.title}”`)
            loadLibrary()
        } catch (e) { toast(e.message) }
    }
    openSheet($('#sheet-book'))
}

// ---------- language sheet ----------

const openLangSheet = (book, { first = false } = {}) => {
    $('#lang-title').textContent = first ? 'Translate this book into' : 'Translation language'
    $('#lang-book').textContent = book.title
    const source = $('#lang-source')
    const detected = book.language
    source.replaceChildren(
        h('option', { value: '' }, detected ? `${langName(detected)} (from the book)` : 'Detect automatically'),
        ...LANGS.map(c => h('option', { value: c, selected: book.sourceLang === c }, langName(c))))
    source.onchange = () => {
        book.sourceLang = source.value || null
        patchBook(book.id, { sourceLang: book.sourceLang }).catch(e => toast(e.message))
    }
    const list = $('#lang-list')
    const current = book.targetLang
    list.replaceChildren(...TARGETS.map(code => {
        const native = nativeName(code)
        const btn = h('button', { type: 'button', role: 'option', 'aria-selected': String(code === current), 'data-code': code },
            h('span', { class: 'l-name' }, langName(code)),
            native && native !== langName(code) ? h('span', { class: 'l-native' }, native) : null,
            icon('check'))
        btn.onclick = async () => {
            book.targetLang = code
            store.set(userKey('lastTarget'), code)
            for (const b of list.querySelectorAll('[aria-selected=true]')) b.setAttribute('aria-selected', 'false')
            btn.setAttribute('aria-selected', 'true')
            updateLangChip()
            closeSheet()
            try { await patchBook(book.id, { targetLang: code }) } catch (e) { toast(e.message) }
            renderLibrary()
        }
        return h('li', {}, btn)
    }))
    openSheet($('#sheet-lang'))
}

// ---------- reader ----------

const reader = $('#reader')
let view = null
let current = null // book meta being read
let loc = {}

const setChrome = on => reader.classList.toggle('chrome', on)
const updateLangChip = () => { $('#r-lang-code').textContent = current?.targetLang ?? '—' }

const applyReaderSettings = () => {
    applyThemeVars()
    if (!view?.renderer) return
    const r = view.renderer
    r.setAttribute('flow', settings.flow)
    r.setAttribute('gap', `${settings.margin}%`)
    r.setAttribute('margin', '44px')
    r.setAttribute('max-inline-size', '680px')
    r.setAttribute('max-column-count', '2')
    settings.animated ? r.setAttribute('animated', '') : r.removeAttribute('animated')
    r.setStyles?.(bookCSS())
    reader.classList.toggle('scrolled', settings.flow === 'scrolled')
    reader.classList.toggle('pdf-dark', /\.pdf$/i.test(current?.file ?? '') && themeColors().dark)
}

const openBook = async id => {
    const meta = byId(id)
    if (!meta || view) return
    current = meta
    document.body.classList.add('reading')
    $('#library').hidden = true
    reader.hidden = false
    $('#r-loading').hidden = false
    $('#r-book-title').textContent = meta.title
    $('#r-chapter').textContent = ''
    $('#r-mini-ch').textContent = ''
    $('#r-mini-pct').textContent = ''
    updateLangChip()
    setChrome(true)
    applyThemeVars()
    pushLayer(closeReader)
    try {
        const res = await fetch(`/api/books/${id}/file`)
        if (!res.ok) throw new Error(res.status === 404 ? 'This book is no longer on the server.' : 'The book could not be downloaded.')
        const file = new File([await res.blob()], meta.filename.toLowerCase())
        const book = await parseBook(file)
        if (current !== meta) return
        view = document.createElement('foliate-view')
        $('#view-host').replaceChildren(view)
        view.addEventListener('load', onSectionLoad)
        view.addEventListener('relocate', onRelocate)
        view.addEventListener('click', e => onTap(e.clientX))
        await view.open(book)
        applyReaderSettings()
        await view.init({ lastLocation: meta.cfi || null, showTextStart: !meta.cfi })
        $('#r-loading').hidden = true
        setTimeout(() => { if (!sheet) setChrome(false) }, 1800)
        if (!TARGETS.includes(meta.targetLang)) {
            // save a sensible default right away, then let the reader confirm or change it
            meta.targetLang = defaultTarget(meta.sourceLang || meta.language)
            updateLangChip()
            patchBook(meta.id, { targetLang: meta.targetLang }).catch(() => {})
            openLangSheet(meta, { first: true })
        }
    } catch (e) {
        console.error(e)
        toast(e.message?.startsWith('This') || e.message?.startsWith('The') ? e.message : 'This book could not be opened.')
        back()
    }
}

const closeReader = () => {
    flushProgress()
    hidePill()
    view?.close?.()
    view?.remove()
    view = null
    current = null
    loc = {}
    reader.hidden = true
    $('#library').hidden = false
    document.body.classList.remove('reading')
    applyThemeVars()
    loadLibrary()
}

let saveTimer
const flushProgress = () => {
    clearTimeout(saveTimer)
    if (!current || loc.cfi == null) return
    const data = { cfi: loc.cfi, fraction: loc.fraction, lastOpened: Date.now() }
    Object.assign(current, data)
    patchBook(current.id, data).catch(() => {})
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushProgress())

let sliding = false
const onRelocate = ({ detail }) => {
    const { fraction, cfi, tocItem, time } = detail
    loc = { fraction, cfi, tocHref: tocItem?.href }
    const chapter = tocItem?.label?.trim() ?? ''
    $('#r-chapter').textContent = chapter
    $('#r-mini-ch').textContent = chapter
    $('#r-pct').textContent = $('#r-mini-pct').textContent = pct(fraction)
    const mins = Math.round(time?.section ?? 0)
    $('#r-time').textContent = mins > 0 ? `${mins} min left in chapter` : chapter ? 'Last page of chapter' : ''
    if (!sliding) $('#r-progress').value = fraction
    hidePill()
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flushProgress, 1200)
}

const turn = dir => {
    if (!view) return
    setChrome(false)
    dir < 0 ? view.goLeft() : view.goRight()
}
const onTap = clientX => {
    if (!view || sheet) return
    const w = innerWidth
    if (settings.flow === 'paginated' && clientX < w * .28) turn(-1)
    else if (settings.flow === 'paginated' && clientX > w * .72) turn(1)
    else setChrome(!reader.classList.contains('chrome'))
}

// Scroll mode: foliate scrolls within one chapter. A swipe or wheel gesture that *starts* at the
// chapter's end (or top) continues into the next (or previous) chapter.
const atEdge = dir => {
    const r = view?.renderer
    return !!r && (dir > 0 ? r.viewSize - r.end <= 2 : r.start <= 0)
}
let edgeLock = 0
const crossChapter = dir => {
    if (!view || sheet || Date.now() - edgeLock < 800) return
    edgeLock = Date.now()
    setChrome(false)
    dir > 0 ? view.renderer.next() : view.renderer.prev()
}
let lastWheel = 0
const onScrollWheel = e => {
    const gap = e.timeStamp - lastWheel
    lastWheel = e.timeStamp
    const dir = Math.sign(e.deltaY)
    if (dir && gap > 300 && atEdge(dir)) crossChapter(dir) // a fresh gesture, not momentum running into the edge
}
let touch = null
const onTouchStart = e => {
    touch = settings.flow === 'scrolled' && e.touches.length === 1
        ? { y: e.touches[0].clientY, end: atEdge(1), top: atEdge(-1) } : null
}
const onTouchEnd = e => {
    if (!touch || e.target.ownerDocument?.getSelection?.()?.isCollapsed === false) return
    const dy = touch.y - e.changedTouches[0].clientY
    if (dy > 60 && touch.end) crossChapter(1)
    else if (dy < -60 && touch.top) crossChapter(-1)
    touch = null
}

let wheelLock = 0
const onWheel = e => {
    if (settings.flow === 'scrolled') return onScrollWheel(e)
    if (settings.flow !== 'paginated' || Math.abs(e.deltaY) < Math.abs(e.deltaX) * .8 && Math.abs(e.deltaX) < 20) return
    const now = Date.now()
    if (now - wheelLock < 350) return
    wheelLock = now
    turn((e.deltaY || e.deltaX) > 0 ? 1 : -1)
}
reader.addEventListener('wheel', onWheel, { passive: true })
reader.addEventListener('touchstart', onTouchStart, { passive: true })
reader.addEventListener('touchend', onTouchEnd, { passive: true })

const onKey = e => {
    if (!view || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'Escape') { sheet ? closeSheet() : back(); return }
    if (sheet || e.target.closest?.('input, select, textarea')) return
    if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); turn(-1) }
    else if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); turn(e.key === ' ' && e.shiftKey ? -1 : 1) }
}
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sheet) return closeSheet()
    onKey(e)
})

// ---------- selection → lookup ----------

let selTimer
let pending = null // { text, context, doc }

const onSectionLoad = ({ detail: { doc } }) => {
    const win = doc.defaultView
    doc.addEventListener('keydown', onKey)
    doc.addEventListener('wheel', onWheel, { passive: true })
    doc.addEventListener('touchstart', onTouchStart, { passive: true })
    doc.addEventListener('touchend', onTouchEnd, { passive: true })
    // foliate's swipe handler would page while dragging selection handles on touch screens
    win.addEventListener('touchmove', e => { if (!doc.getSelection()?.isCollapsed) e.stopPropagation() }, { capture: true, passive: true })
    doc.addEventListener('click', e => {
        if (e.target.closest?.('a[href]')) return
        if (!doc.getSelection()?.isCollapsed) return
        const frame = win.frameElement?.getBoundingClientRect()
        const scale = frame && win.innerWidth ? frame.width / win.innerWidth : 1
        onTap((frame?.left ?? 0) + e.clientX * scale)
    })
    doc.addEventListener('selectionchange', () => {
        clearTimeout(selTimer)
        selTimer = setTimeout(() => checkSelection(doc, false), 380)
    })
    doc.addEventListener('pointerup', e => {
        if (e.pointerType === 'mouse') setTimeout(() => checkSelection(doc, true), 10)
    })
}

const BLOCK = 'p, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6, td, th, pre, figcaption, div, section, .textLayer'
const sentenceAround = (range, lang) => {
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
    const block = node?.closest?.(BLOCK) ?? node?.ownerDocument.body
    if (!block) return ''
    const pre = range.cloneRange()
    pre.selectNodeContents(block)
    pre.setEnd(range.startContainer, range.startOffset)
    // line breaks inside a paragraph are hard sentence breaks for Intl.Segmenter; same-length swap keeps offsets
    const text = block.textContent.replace(/\s/g, ' ')
    const start = pre.toString().length
    const end = start + range.toString().length
    let seg = null
    try { seg = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' }) } catch {}
    if (!seg) return text.slice(Math.max(0, start - 200), end + 200)
    let out = ''
    for (const s of seg.segment(text)) {
        const sEnd = s.index + s.segment.length
        if (sEnd > start && s.index < end) out += s.segment
    }
    return out.replace(/\s+/g, ' ').trim().slice(0, 1200)
}

// Collapse spaces inside lines, keep line and paragraph breaks.
const normalizeText = s => s.replace(/\r/g, '').split('\n').map(l => l.replace(/[^\S\n]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()

// Rebuild the selection as safe paragraphs that keep line breaks, italics and bold.
// Walks the live book DOM so CSS-made blocks (e.g. address lines styled as display:block) count too.
const KEEP = { i: 'i', em: 'em', b: 'b', strong: 'strong', u: 'u', sub: 'sub', sup: 'sup', s: 's', code: 'code', small: 'small', cite: 'cite' }
const SKIP = new Set(['img', 'svg', 'script', 'style', 'video', 'audio', 'iframe', 'object', 'rt', 'rp', 'noscript'])
const selectionBlocks = range => {
    const win = range.startContainer.ownerDocument.defaultView
    const blocks = [h('p')]
    const add = (node, target) => (target ?? blocks.at(-1)).append(node)
    const walk = (node, target) => {
        for (const child of node.childNodes) {
            if (!range.intersectsNode(child)) continue
            if (child.nodeType === 3) {
                const from = child === range.startContainer ? range.startOffset : 0
                const to = child === range.endContainer ? range.endOffset : child.data.length
                // <pre> and other preformatted text keep their line breaks
                const pre = /^(pre|break-spaces)/.test(win.getComputedStyle(child.parentElement).whiteSpace)
                add(child.data.slice(from, to).replace(pre ? /[^\S\n]+/g : /\s+/g, ' '), target)
                continue
            }
            if (child.nodeType !== 1) continue
            const tag = child.localName.toLowerCase()
            if (SKIP.has(tag)) continue
            if (tag === 'br') { add(h('br'), target); continue }
            const style = win.getComputedStyle(child)
            if (style.display === 'none') continue
            const parentStyle = win.getComputedStyle(child.parentElement)
            const fmt = KEEP[tag]
                ?? (style.fontStyle === 'italic' && parentStyle.fontStyle !== 'italic' ? 'i'
                : +style.fontWeight >= 600 && +parentStyle.fontWeight < 600 ? 'b' : null)
            if (!target && !/^(inline|contents|ruby)/.test(style.display)) {
                blocks.push(h('p'))
                walk(child, null)
                blocks.push(h('p'))
            } else if (fmt) {
                const el = h(fmt)
                walk(child, el)
                add(el, target)
            } else walk(child, target)
        }
    }
    // start from the nearest block, so formatting that wraps the whole selection is kept
    let start = range.commonAncestorContainer
    if (start.nodeType !== 1) start = start.parentElement
    while (start.parentElement && /^inline/.test(win.getComputedStyle(start).display)) start = start.parentElement
    walk(start, null)
    const kept = blocks.filter(p => p.textContent.trim())
    for (const p of kept) { // drop the blank first/last lines a <pre> block carries
        if (p.firstChild?.nodeType === 3) p.firstChild.data = p.firstChild.data.trimStart()
        if (p.lastChild?.nodeType === 3) p.lastChild.data = p.lastChild.data.trimEnd()
    }
    return kept
}

// Text of the popup's paragraphs: blank line between paragraphs, newline for <br>.
const blocksText = blocks => blocks.map(p => {
    const copy = p.cloneNode(true)
    for (const br of copy.querySelectorAll('br')) br.replaceWith('\n')
    return normalizeText(copy.textContent)
}).join('\n\n')

const MAX_SELECTION = 1000 // characters, about a long paragraph; the server enforces the same limit
const checkSelection = (doc, fromMouse) => {
    const sel = doc.getSelection()
    const text = sel ? normalizeText(sel.toString()) : ''
    if (!sel || sel.isCollapsed || !text) { if (!sheet) hidePill(); return }
    if (sheet) return
    const range = sel.getRangeAt(0)
    const pdf = !!range.startContainer.parentElement?.closest('.textLayer') // PDF text is positioned spans: use the plain text
    const blocks = pdf || text.length > MAX_SELECTION ? null : selectionBlocks(range)
    pending = {
        // translate exactly what the popup shows, so both sides break in the same places
        text: blocks?.length ? blocksText(blocks) : text,
        blocks,
        context: blocks?.length > 1 || text.includes('\n') ? '' : sentenceAround(range, current?.sourceLang || current?.language),
        doc,
    }
    if (fromMouse) openLookup()
    else $('#lk-pill').hidden = false
}
const hidePill = () => { $('#lk-pill').hidden = true }
$('#lk-pill').addEventListener('click', () => openLookup())

let lookupSeq = 0
let lastLookup = null
const cache = new Map()

// The lookup as the server streams it: onPartial(result so far) per line, then the final result.
const streamLookup = async (body, onPartial, signal) => {
    const res = await request('/api/lookup', { method: 'POST', body: JSON.stringify({ ...body, stream: true }), signal })
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += value
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
            const msg = JSON.parse(buf.slice(0, i))
            buf = buf.slice(i + 1)
            if (msg.error) throw new Error(msg.error)
            if (msg.result) return msg.result
            onPartial(msg.partial)
        }
    }
    throw new Error('The translation was cut off. Try again.')
}
let lookupAbort = null

const markIn = (container, sentence, text) => {
    const i = sentence.indexOf(text)
    container.replaceChildren(...(i < 0 ? [sentence] : [sentence.slice(0, i), h('mark', {}, text), sentence.slice(i + text.length)]))
}

const openLookup = async () => {
    if (!pending || !current) return
    hidePill()
    const { text, context } = pending
    if (text.length > MAX_SELECTION) return toast('Too much text to translate at once. Select up to 1,000 characters, about a paragraph.')
    lastLookup = pending
    const seq = ++lookupSeq
    const target = TARGETS.includes(current.targetLang) ? current.targetLang : defaultTarget(current.sourceLang || current.language)
    const source = current.sourceLang || current.language || 'auto'
    const long = text.length > 140 || text.includes('\n')
    const blocks = pending.blocks?.length ? pending.blocks : text.split(/\n{2,}/).map(t => h('p', {}, t))
    $('#lk-text').replaceChildren(...blocks.map(p => h('p', {}, h('mark', {}, ...p.cloneNode(true).childNodes))))
    $('#lk-text').classList.toggle('long', long)
    $('#lk-from').textContent = source === 'auto' ? 'Detecting…' : langName(source)
    $('#lk-to').textContent = langName(target)
    const tr = $('#lk-translation')
    tr.textContent = ' '
    tr.className = `lk-translation loading${long ? ' long' : ''}`
    $('#lk-error').hidden = true
    $('#lk-defs').hidden = true
    $('#lk-credit').textContent = ''
    const hasSentence = context && context !== text
    $('#lk-sentence').hidden = !hasSentence
    if (hasSentence) {
        markIn($('#lk-sentence-orig'), context, text)
        $('#lk-sentence-tr').textContent = ' '
        $('#lk-sentence-tr').className = 'lk-ctx-tr loading'
    }
    $('#lk-explain').hidden = false
    $('#lk-explain-text').textContent = '\u00a0'
    $('#lk-explain-text').className = 'lk-explain loading'
    lookupAbort?.abort()
    const abort = lookupAbort = new AbortController()
    openSheet($('#sheet-lookup'), () => { abort.abort(); view?.deselect(); pending = null })

    const body = { text, context: hasSentence ? context : '', source, target, title: current.title, author: current.author }
    const key = JSON.stringify([text, context, source, target])
    // partial results fill in each field as soon as it has text; the final one settles everything
    const show = (res, final) => {
        if (seq !== lookupSeq) return
        if (res.translation || final) {
            tr.className = `lk-translation${long ? ' long' : ''}`
            tr.textContent = res.translation
        }
        if (hasSentence && (res.contextTranslation || final)) {
            $('#lk-sentence-tr').className = 'lk-ctx-tr'
            $('#lk-sentence-tr').textContent = res.contextTranslation ?? ''
        }
        if (res.explanation || final) {
            $('#lk-explain').hidden = !res.explanation
            $('#lk-explain-text').className = 'lk-explain'
            $('#lk-explain-text').textContent = res.explanation ?? ''
        }
        if (!final) return
        $('#lk-from').textContent = langName(res.detected) || 'Unknown language'
        lastLookup.lang = res.detected
        const defs = (res.definitions ?? []).filter(g => g.defs.length)
        $('#lk-defs').hidden = !defs.length
        $('#lk-defs-list').replaceChildren(...defs.map(g => h('div', { class: 'def-group' },
            h('span', { class: 'def-pos' }, g.pos),
            h('ol', {}, g.defs.map(d => h('li', {}, d))))))
        $('#lk-credit').textContent = `By ${res.provider}`
    }
    try {
        const res = cache.get(key) ?? await streamLookup(body, r => show(r, false), abort.signal)
        cache.set(key, res)
        show(res, true)
    } catch (e) {
        if (seq !== lookupSeq || abort.signal.aborted) return
        tr.className = 'lk-translation'
        tr.textContent = ''
        $('#lk-sentence').hidden = true
        $('#lk-explain').hidden = true
        const err = $('#lk-error')
        err.hidden = false
        err.textContent = navigator.onLine ? e.message : "You're offline. Translations need an internet connection."
    }
}

$('#lk-speak').addEventListener('click', () => {
    const text = lastLookup?.text
    if (!text || !('speechSynthesis' in window)) return toast("Your browser can't read text aloud.")
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    const lang = lastLookup?.lang || current?.sourceLang || current?.language
    if (lang && lang !== 'auto') u.lang = lang
    speechSynthesis.speak(u)
})
$('#lk-copy').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText($('#lk-translation').textContent)
        toast('Translation copied')
    } catch { toast("Couldn't copy. Select the text and copy it instead.") }
})
$('#lk-langs').addEventListener('click', () => current && openLangSheet(current))

// ---------- reader chrome ----------

$('#r-back').addEventListener('click', back)
$('#r-lang').addEventListener('click', () => current && openLangSheet(current))
$('#r-aa').addEventListener('click', () => { renderAppearance(); openSheet($('#sheet-aa')) })
$('#r-toc').addEventListener('click', () => {
    const toc = view?.book?.toc ?? []
    const list = $('#toc-list')
    const items = []
    const walk = (nodes, depth) => { for (const n of nodes ?? []) { items.push([n, depth]); walk(n.subitems, depth + 1) } }
    walk(toc, 0)
    list.replaceChildren(...(items.length ? items.map(([n, depth]) => h('li', {},
        h('button', { type: 'button', style: `--depth:${Math.min(depth, 4)}`, 'aria-current': String(n.href === loc.tocHref),
            onclick: () => { closeSheet(); view.goTo(n.href).catch(() => toast("Couldn't open that chapter.")) } },
            n.label?.trim() || 'Untitled'))) : [h('li', { class: 'sheet-sub' }, 'This book has no table of contents.')]))
    openSheet($('#sheet-toc'))
    setTimeout(() => list.querySelector('[aria-current=true]')?.scrollIntoView({ block: 'center' }), 340)
})
const progress = $('#r-progress')
progress.addEventListener('input', () => {
    sliding = true
    $('#r-pct').textContent = pct(progress.valueAsNumber)
})
progress.addEventListener('change', async () => {
    try { await view?.goToFraction(progress.valueAsNumber) } finally { sliding = false }
})

// ---------- appearance ----------

const setChecked = (group, value) => {
    for (const b of group.querySelectorAll('[data-v]')) b.setAttribute('aria-checked', String(b.dataset.v === String(value)))
}
const change = (key, value) => {
    settings[key] = value
    saveSettings()
    applyReaderSettings()
    renderAppearance()
}

const renderAppearance = () => {
    const themes = $('#aa-themes')
    if (!themes.children.length) {
        themes.append(...Object.entries(THEMES).map(([key, t]) => h('button', {
            type: 'button', class: 'theme-swatch', role: 'radio', 'data-v': key, onclick: () => change('theme', key),
        }, h('i', { style: key === 'custom'
            ? 'background:conic-gradient(#F2E7CF 0 25%,#2A2E39 0 50%,#DCE5D6 0 75%,#FBFBF8 0);color:#23252A'
            : `background:${t.bg};color:${t.fg}` }, 'Aa'), t.name)))
        for (const [id, key] of [['#aa-font', 'font'], ['#aa-flow', 'flow']])
            for (const b of $(id).querySelectorAll('[data-v]')) {
                b.setAttribute('role', 'radio')
                b.addEventListener('click', () => change(key, b.dataset.v))
            }
        $('#aa-smaller').onclick = () => change('fontSize', Math.max(12, settings.fontSize - 1))
        $('#aa-bigger').onclick = () => change('fontSize', Math.min(36, settings.fontSize + 1))
        $('#aa-lh').oninput = e => change('lineHeight', e.target.valueAsNumber)
        $('#aa-margin').oninput = e => change('margin', e.target.valueAsNumber)
        $('#aa-justify').onchange = e => change('justify', e.target.checked)
        $('#aa-hyphen').onchange = e => change('hyphenate', e.target.checked)
        $('#aa-anim').onchange = e => change('animated', e.target.checked)
        $('#aa-bg').oninput = e => change('customBg', e.target.value)
        $('#aa-fg').oninput = e => change('customFg', e.target.value)
    }
    setChecked(themes, settings.theme)
    setChecked($('#aa-font'), settings.font)
    setChecked($('#aa-flow'), settings.flow)
    $('#aa-custom').hidden = settings.theme !== 'custom'
    $('#aa-bg').value = settings.customBg
    $('#aa-fg').value = settings.customFg
    $('#aa-size').textContent = settings.fontSize
    $('#aa-lh').value = settings.lineHeight
    $('#aa-margin').value = settings.margin
    $('#aa-justify').checked = settings.justify
    $('#aa-hyphen').checked = settings.hyphenate
    $('#aa-anim').checked = settings.animated
}

// ---------- free books (Project Gutenberg) ----------

const STORE_LANGS = [['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['it', 'Italiano'],
    ['ru', 'Русский'], ['ro', 'Română'], ['', 'All languages']]
const storeEl = $('#store')
const storeList = $('#store-list')
const storeState = { q: '', lang: 'en', page: 1, seq: 0, loaded: false, anyLang: false }

const readOwned = source => {
    const id = books.find(x => x.source === source)?.id
    if (!id) return
    back() // close the store first, so Back from the book returns to the library
    setTimeout(() => openBook(id), 60)
}

const storeCard = b => {
    const btn = h('button', { class: `get-btn${b.owned ? ' owned' : ''}`, type: 'button' }, b.owned ? 'Read' : 'Get')
    const wiki = b.source.startsWith('wikisource:')
    const cover = h('div', { class: 'cover' })
    if (wiki) cover.append(genCover(b)) // Wikisource has no covers
    else {
        const img = h('img', { src: `/api/store/${b.id}/cover`, alt: '', loading: 'lazy', decoding: 'async' })
        img.addEventListener('error', () => cover.replaceChildren(genCover(b)), { once: true })
        cover.append(img)
    }
    btn.addEventListener('click', async () => {
        if (b.owned) return readOwned(b.source)
        btn.disabled = true
        btn.textContent = 'Adding…'
        try {
            const meta = await api(wiki ? '/api/store/wikisource' : `/api/store/${b.id}`, { method: 'POST',
                body: JSON.stringify({ title: b.title, author: b.author, language: b.language, lang: b.language, page: b.id }) })
            books = [meta, ...books.filter(x => x.id !== meta.id)]
            b.owned = true
            btn.textContent = 'Read'
            btn.classList.add('owned')
            toast(`Added “${meta.title}” to your library`)
        } catch (e) {
            btn.textContent = 'Get'
            toast(e.message)
        } finally { btn.disabled = false }
    })
    return h('li', { class: 'book store-book' }, cover,
        h('p', { class: 'b-title' }, b.title), h('p', { class: 'b-author' }, b.author || '\u00a0'),
        storeState.anyLang && b.language ? h('p', { class: 'b-lang' }, langName(b.language) || b.language) : null,
        wiki ? h('p', { class: 'b-lang' }, 'Wikisource') : null, btn)
}

const searchStore = async reset => {
    const status = $('#store-status')
    const more = $('#store-more')
    if (reset) { storeState.page = 1; storeState.anyLang = false; storeList.replaceChildren() }
    const seq = ++storeState.seq
    status.textContent = reset ? 'Loading…' : ''
    more.hidden = true
    const load = () => api(`/api/store?${new URLSearchParams({ q: storeState.q, lang: storeState.anyLang ? '' : storeState.lang, page: storeState.page })}`)
    try {
        let res = await load()
        // titles differ between languages (Don Quijote, Don Quixote): if nothing matches here, look in all of them
        if (reset && storeState.q && !res.books.length && seq === storeState.seq) {
            storeState.anyLang = true
            res = await load()
        }
        if (seq !== storeState.seq) return
        storeList.append(...res.books.map(storeCard))
        storeState.loaded = true
        more.hidden = !res.more
        const name = STORE_LANGS.find(([c]) => c === storeState.lang)?.[1]
        status.textContent = !storeList.children.length
            ? (storeState.q ? `No books found for “${storeState.q}”.` : 'No books in this language yet.')
            : storeState.anyLang && storeState.page === 1 ? `Nothing in ${name} for “${storeState.q}”. Showing all languages.`
            : !res.more && storeState.page === 1 && !storeState.q && res.books.length < 25
                ? `Project Gutenberg has only a few books in ${name}.${['ru', 'ro'].includes(storeState.lang) ? ' Search by title or author to find more on Wikisource.' : ''}` : ''
    } catch (e) {
        if (seq === storeState.seq) status.textContent = e.message
    }
}

const renderStoreLangs = () => $('#store-langs').replaceChildren(...STORE_LANGS.map(([code, label]) =>
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(code === storeState.lang), onclick: () => {
        storeState.lang = code
        store.set(userKey('storeLang'), code)
        renderStoreLangs()
        searchStore(true)
    } }, label)))

const openStore = () => {
    storeState.lang = store.get(userKey('storeLang'), 'en')
    renderStoreLangs()
    $('#library').hidden = true
    storeEl.hidden = false
    scrollTo(0, 0)
    pushLayer(() => {
        storeEl.hidden = true
        $('#library').hidden = false
        renderLibrary()
    })
    if (!storeState.loaded) searchStore(true)
}

let storeTimer
$('#store-q').addEventListener('input', e => {
    clearTimeout(storeTimer)
    storeTimer = setTimeout(() => { storeState.q = e.target.value.trim(); searchStore(true) }, 450)
})
$('#store-more').addEventListener('click', () => { storeState.page++; searchStore(false) })
$('#store-back').addEventListener('click', back)
for (const id of ['#store-btn', '#empty-store']) $(id).addEventListener('click', openStore)

// ---------- install to home screen ----------

const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
let installPrompt = null // Chrome/Edge/Android hand us this when the app can be installed

const canInstall = () => !standalone() && (installPrompt || isIOS)
const updateInstallUI = () => {
    $('#install-banner').hidden = !canInstall() || store.get('installDismissed', false)
    $('#acct-install').hidden = !canInstall()
}
const install = async () => {
    if (installPrompt) {
        installPrompt.prompt()
        const { outcome } = await installPrompt.userChoice
        if (outcome === 'accepted') installPrompt = null
        updateInstallUI()
    } else if (isIOS) openSheet($('#sheet-ios'))
}
addEventListener('beforeinstallprompt', e => {
    e.preventDefault() // show our own button instead of the browser's mini bar
    installPrompt = e
    updateInstallUI()
})
addEventListener('appinstalled', () => {
    installPrompt = null
    updateInstallUI()
    toast('Installed. Open Context Reader from your home screen.')
})
$('#install-btn').addEventListener('click', install)
$('#install-dismiss').addEventListener('click', () => { store.set('installDismissed', true); updateInstallUI() })
$('#acct-install').addEventListener('click', () => { closeSheet(); setTimeout(install, 350) })
$('#ios-done').addEventListener('click', closeSheet)
updateInstallUI()

// ---------- accounts ----------

const authEl = $('#auth')
let authMode = 'login'
const setAuthMode = mode => {
    authMode = mode
    for (const b of authEl.querySelectorAll('[data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === mode))
    $('#auth-submit').textContent = mode === 'login' ? 'Sign in' : 'Create account'
    $('#auth-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password'
    $('#auth-hint').hidden = mode === 'login'
    $('#auth-error').hidden = true
}
for (const b of authEl.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setAuthMode(b.dataset.mode))

// ---------- passkeys ----------

const b64u = {
    enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    dec: s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
}
// what the server's WebAuthn library reads: binary fields as base64url
const credentialJSON = cred => {
    const r = cred.response
    return {
        id: cred.id, rawId: b64u.enc(cred.rawId), type: cred.type,
        authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
        clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
        response: r.attestationObject
            ? { clientDataJSON: b64u.enc(r.clientDataJSON), attestationObject: b64u.enc(r.attestationObject), transports: r.getTransports?.() ?? [] }
            : { clientDataJSON: b64u.enc(r.clientDataJSON), authenticatorData: b64u.enc(r.authenticatorData),
                signature: b64u.enc(r.signature), userHandle: r.userHandle ? b64u.enc(r.userHandle) : undefined },
    }
}
const deviceName = () => {
    const ua = navigator.userAgent
    return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
        : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Passkey'
}
// cancelling the system prompt is not an error worth showing
const passkeyError = e => ['NotAllowedError', 'AbortError'].includes(e.name) ? null
    : e.name === 'InvalidStateError' ? 'This device already has a passkey for your account.' : e.message
let config = {}
const passkeysOK = () => !!(config.passkeys && window.PublicKeyCredential && isSecureContext)

$('#auth-passkey').addEventListener('click', async () => {
    const btn = $('#auth-passkey')
    btn.disabled = true
    $('#auth-error').hidden = true
    try {
        const o = await api('/api/auth/passkey-login-options', { method: 'POST' })
        const cred = await navigator.credentials.get({ publicKey: { ...o, challenge: b64u.dec(o.challenge), allowCredentials: [] } })
        const { user } = await api('/api/auth/passkey-login', { method: 'POST', body: JSON.stringify({ credential: credentialJSON(cred) }) })
        enterApp(user)
    } catch (err) {
        const msg = passkeyError(err)
        if (msg) { $('#auth-error').textContent = msg; $('#auth-error').hidden = false }
    } finally { btn.disabled = false }
})

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const renderPasskeys = () => {
    $('#acct-passkeys').hidden = !passkeysOK()
    $('#pk-list').replaceChildren(...(me?.passkeys ?? []).map(pk => h('li', {},
        h('span', {}, pk.name, h('small', {}, `Added ${dateFmt.format(pk.created)}`)),
        h('button', { type: 'button', 'aria-label': `Remove passkey ${pk.name}`, onclick: async () => {
            try {
                me = (await api('/api/auth/passkey-remove', { method: 'POST', body: JSON.stringify({ id: pk.id }) })).user
                renderPasskeys()
                toast('Passkey removed. Also delete it from your password manager.')
            } catch (err) { toast(err.message) }
        } }, 'Remove'))))
}
$('#pk-add').addEventListener('click', async () => {
    try {
        const o = await api('/api/auth/passkey-options', { method: 'POST' })
        const cred = await navigator.credentials.create({ publicKey: {
            ...o, challenge: b64u.dec(o.challenge), user: { ...o.user, id: b64u.dec(o.user.id) },
            excludeCredentials: (o.excludeCredentials ?? []).map(c => ({ ...c, id: b64u.dec(c.id) })),
        } })
        me = (await api('/api/auth/passkey-add', { method: 'POST', body: JSON.stringify({ credential: credentialJSON(cred), name: deviceName() }) })).user
        renderPasskeys()
        toast('Passkey added. Use it next time you sign in.')
    } catch (err) {
        const msg = passkeyError(err)
        if (msg) toast(msg)
    }
})

$('#auth-form').addEventListener('submit', async e => {
    e.preventDefault()
    const btn = $('#auth-submit')
    btn.disabled = true
    try {
        const { user } = await api(`/api/auth/${authMode}`, { method: 'POST',
            body: JSON.stringify({ name: $('#auth-name').value.trim(), password: $('#auth-pass').value }) })
        $('#auth-pass').value = ''
        enterApp(user)
    } catch (err) {
        $('#auth-error').textContent = err.message
        $('#auth-error').hidden = false
    } finally { btn.disabled = false }
})

function showAuth() {
    if (sheet) { hideSheetEl(sheet.el); sheet = null; scrim.hidden = true }
    layers.length = 0
    if (view) { view.close?.(); view.remove(); view = null }
    current = null
    reader.hidden = true
    document.body.classList.remove('reading')
    me = null
    books = []
    storeEl.hidden = true
    storeState.loaded = false
    $('#library').hidden = true
    authEl.hidden = false
    applyThemeVars()
    setTimeout(() => $('#auth-name').focus({ preventScroll: true }), 50)
}

const enterApp = user => {
    me = user
    loadSettings()
    $('#account-btn').textContent = [...user.name][0] ?? '?'
    $('#account-btn').setAttribute('aria-label', `Account: ${user.name}`)
    authEl.hidden = true
    $('#library').hidden = false
    applyThemeVars()
    loadLibrary()
}

$('#account-btn').addEventListener('click', () => {
    $('#acct-name').textContent = me?.name ?? ''
    $('#acct-avatar').textContent = [...(me?.name ?? '?')][0]
    renderPasskeys()
    openSheet($('#sheet-account'))
})
$('#acct-logout').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }) } catch {}
    // cached library lists and book files belong to this account
    try { for (const k of await caches.keys()) if (!k.startsWith('shell')) await caches.delete(k) } catch {}
    showAuth()
})

// ---------- start ----------

applyThemeVars()
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyThemeVars)
// sign-in options depend on the server: closed sign-ups hide "Create account"
api('/api/config').then(c => {
    config = c
    if (!c.signups) { $('.auth-seg').hidden = true; setAuthMode('login') }
    $('#auth-passkey').hidden = !passkeysOK()
}, () => {})
api('/api/auth/me').then(({ user }) => enterApp(user), () => showAuth())
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {})
