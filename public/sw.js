// Offline support: app shell network-first (a deploy shows on the next load), vendor/fonts and book files cache-first
// (book ids never change), library list network-first. Lookups always go to the network.
const SHELL = 'shell-v4'
const STATIC = 'static-v2'
const BOOKS = 'books'
const CORE = ['/', '/app.js', '/app.css', '/text-book.js', '/manifest.webmanifest', '/fonts/fonts.css', '/icons/icon.svg', '/vendor/foliate/view.js']

self.addEventListener('install', e => {
    e.waitUntil(caches.open(SHELL).then(c => c.addAll(CORE)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', e => {
    const keep = [SHELL, STATIC, BOOKS]
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => !keep.includes(k)).map(k => caches.delete(k))))
        .then(() => self.clients.claim()))
})

const cacheFirst = async (req, name) => {
    const hit = await caches.match(req)
    if (hit) return hit
    const res = await fetch(req)
    if (res.ok) (await caches.open(name)).put(req, res.clone())
    return res
}
const networkFirst = async (req, name) => {
    try {
        const res = await fetch(req)
        if (res.ok) (await caches.open(name)).put(req, res.clone())
        return res
    } catch (e) {
        const hit = await caches.match(req)
        if (hit) return hit
        throw e
    }
}

self.addEventListener('fetch', e => {
    const req = e.request
    const url = new URL(req.url)
    if (req.method !== 'GET' || url.origin !== location.origin) return
    const p = url.pathname
    if (/^\/api\/books\/[a-f0-9]{16}\/file$/.test(p)) e.respondWith(cacheFirst(req, BOOKS))
    else if (/^\/api\/books\/[a-f0-9]{16}\/cover$/.test(p) || p === '/api/books' || p === '/api/config' || p === '/api/auth/me') e.respondWith(networkFirst(req, STATIC))
    else if (p.startsWith('/api/')) return
    else if (p.startsWith('/vendor/') || p.startsWith('/fonts/')) e.respondWith(cacheFirst(req, STATIC))
    else if (req.mode === 'navigate') e.respondWith(networkFirst(new Request('/'), SHELL))
    else e.respondWith(networkFirst(req, SHELL))
})
