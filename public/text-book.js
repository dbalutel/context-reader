// Plain-text and HTML books, exposed through foliate-js's "book" interface.

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export const decodeText = buffer => {
    const b = new Uint8Array(buffer)
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b)
    if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b)
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b) } catch {}
    // shortcut: legacy 8-bit text is guessed as Cyrillic (cp1251) or Western (cp1252) by byte range; add a charset picker if other encodings show up
    let high = 0
    for (let i = 0; i < Math.min(b.length, 65536); i++) if (b[i] >= 0xC0) high++
    return new TextDecoder(high > Math.min(b.length, 65536) * 0.15 ? 'windows-1251' : 'windows-1252').decode(b)
}

const HEADING = /^(?:(?:chapter|part|book|prologue|epilogue|preface|introduction|глава|часть|пролог|эпилог|предисловие|розділ|kapitel|teil|chapitre|partie|capítulo|capitolo|parte|rozdział|hoofdstuk|kapitola)(?=[\s.:]|$).{0,80}|[IVXLC]{1,7}\.?|\d{1,3}\.?|\*\s*\*\s*\*)$/i

// Split plain text into chapters of paragraphs.
export const splitText = text => {
    text = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '')
    const lines = text.split('\n')
    const blank = lines.filter(l => !l.trim()).length
    // Books with a blank line between paragraphs vs. one paragraph per line
    const paras = (blank > lines.length / 20 ? text.split(/\n\s*\n/) : lines)
        .map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
    const chapters = []
    let cur = { title: '', paras: [] }
    const flush = () => { if (cur.paras.length || cur.title) chapters.push(cur) }
    for (const p of paras) {
        const heading = p.length < 90 && HEADING.test(p)
        if (heading && !/^\*/.test(p)) { flush(); cur = { title: p, paras: [] } }
        else {
            cur.paras.push(p)
            // keep sections small enough to paginate quickly when the book has no headings
            if (cur.paras.length >= 400) { flush(); cur = { title: '', paras: [] } }
        }
    }
    flush()
    return chapters
}

const LANG_NAMES = { english: 'en', german: 'de', french: 'fr', spanish: 'es', italian: 'it', russian: 'ru', portuguese: 'pt', dutch: 'nl' }
const normLang = name => name ? LANG_NAMES[name.trim().toLowerCase()] : undefined

const page = (title, body, lang) => `<!DOCTYPE html><html${lang ? ` lang="${esc(lang)}"` : ''}><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>h2{text-align:center;margin:2em 0 1.2em;font-weight:600} p{margin:0;text-indent:1.5em} h2+p,p.first{text-indent:0}</style></head><body>${body}</body></html>`

export const makeTextBook = async file => {
    const raw = decodeText(await file.arrayBuffer())
    const isHTML = /\.html?$/i.test(file.name)
    let title = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ')
    let author = '', language
    let chapters // [{ title, body }]

    if (isHTML) {
        const doc = new DOMParser().parseFromString(raw, 'text/html')
        doc.querySelectorAll('script, iframe, object, embed, link, meta[http-equiv]').forEach(e => e.remove())
        title = doc.title.trim() || title
        author = doc.querySelector('meta[name="author"]')?.content ?? ''
        language = doc.documentElement.lang || undefined
        chapters = []
        let cur = { title: '', parts: [] }
        for (const el of doc.body.children) {
            if (/^H[12]$/.test(el.tagName) && cur.parts.length) { chapters.push(cur); cur = { title: '', parts: [] } }
            if (/^H[12]$/.test(el.tagName) && !cur.title) cur.title = el.textContent.trim()
            cur.parts.push(el.outerHTML)
        }
        chapters.push(cur)
        chapters = chapters.map(c => ({ title: c.title, body: c.parts.join('\n') }))
    } else {
        // Project Gutenberg plain-text header
        const head = raw.slice(0, 4000)
        title = /^Title:\s*(.+)$/m.exec(head)?.[1].trim() ?? title
        author = /^Author:\s*(.+)$/m.exec(head)?.[1].trim() ?? ''
        language = normLang(/^Language:\s*(.+)$/m.exec(head)?.[1])
        chapters = splitText(raw).map(c => ({
            title: c.title,
            body: (c.title ? `<h2>${esc(c.title)}</h2>` : '') + c.paras.map(p => `<p>${esc(p)}</p>`).join('\n'),
        }))
        if (!chapters.length) chapters = [{ title: '', body: '<p></p>' }]
    }

    const sections = chapters.map((c, i) => {
        const html = page(c.title || title, c.body, language)
        const blob = new Blob([html], { type: 'text/html' })
        let url
        return {
            id: i, linear: 'yes', size: blob.size,
            load: () => (url = URL.createObjectURL(blob)),
            unload: () => url && URL.revokeObjectURL(url),
            createDocument: () => new DOMParser().parseFromString(html, 'text/html'),
        }
    })

    return {
        sections, dir: 'ltr', rendition: {},
        metadata: { title, author, language },
        toc: chapters.map((c, i) => c.title ? { label: c.title, href: String(i) } : null).filter(Boolean),
        resolveHref: href => ({ index: Math.max(0, Math.min(sections.length - 1, Number(href) || 0)), anchor: () => 0 }),
        splitTOCHref: href => [Number(href), null],
        getTOCFragment: doc => doc.body,
        isExternal: href => /^\w+:/i.test(href),
        getCover: () => null,
    }
}
