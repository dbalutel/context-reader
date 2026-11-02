# Context Reader

A self-hosted e-book reader that feels like a phone app. Select any word or passage while reading and a sheet slides up with its translation, the whole sentence translated, and dictionary entries, in the language you chose for that book.

**Live:** https://reader.balu.party (public certificate, no CA to install) or https://reader.pi.local (local CA). Both are served by the Pi and reachable on the LAN only.

## What it does

- **Formats:** EPUB, MOBI, AZW3/KF8, FB2 (and .fb2.zip), CBZ, PDF, TXT, HTML. Rendering is [foliate-js](https://github.com/johnfactotum/foliate-js), the engine behind the Foliate reader.
- **Accounts:** everyone signs in with a name and password and gets a private library. Books, reading positions and translation languages belong to the account, and appearance settings are remembered per account on each device. Anyone on the LAN can create an account from the sign-in screen.
- **Free books:** a store screen (the shelf icon in the library, or "Browse free books" when it's empty) lists Project Gutenberg's public-domain books, most popular first. Search by title or author, filter by language, and tap **Get**: the Pi downloads the EPUB with its cover straight into your library. Gutenberg is rich in English, German and French but has only a few Russian and Romanian books.
- **Library on the server:** uploads go to the Pi, so the same books and reading position show up on every device you sign in on. Each book reopens where you stopped; the library shows a Continue reading card and how far you are into every book. Covers, titles and authors come from the file.
- **Translation per book:** into English, Russian, Romanian or German. The first time you open a book it asks which; change it any time with the language chip in the top bar. The book's own language is detected (or set it in the same sheet).
- **Lookup:** long-press to select on a phone, then tap **Translate**. On a desktop, double-click or drag-select and the sheet opens directly. You get:
  - the selection as it appears in the book, keeping paragraphs, line breaks, italics and bold
  - the translation, broken into the same paragraphs and lines, translated for the sense used in that sentence
  - **"In this context":** what it means here (idioms, wordplay, archaic words, references)
  - the sentence it sits in, with its translation
  - for single words: the dictionary form, part of speech and other common meanings

  Longer selections come from one Claude Sonnet call (roughly half a cent), streamed so the translation appears as it's written (first words in about 1.5 s). One- or two-word selections use Google Translate instead (under a second, translation and sentence only, no explanation), falling back to Claude if Google fails. Closing the sheet cancels the request. Results are cached on the server.
  - listen (text-to-speech) and copy
- **Reading comfort:** 7 themes plus custom page and text colors, 3 reading fonts or the book's own, text size, line spacing, margins, justification, hyphenation, paged or scrolling layout, animated page turns. Two columns on wide screens. Settings are per device.
- **Feels native:** installable to the home screen (PWA): the library shows an **Install** banner (Android/Chrome/Edge open the install dialog; iPhone/iPad get Add to Home Screen steps), also in the account sheet. Installed, it opens full screen without browser bars, works offline for books you've opened, tap the edges or swipe to turn pages, tap the middle to show the controls, and the back button/gesture closes sheets and the book.

## API key (required for lookups)

Lookups use Claude (`claude-sonnet-5-5` by default, with Anthropic's server-side fallback if it declines a passage). A Max plan includes $100 of API credits a month: on claude.ai go to Settings → Billing → API credits, link a Console organization, then create a key at platform.claude.com. Put it on the Pi:

```bash
ssh pihole 'echo "ANTHROPIC_API_KEY=sk-ant-..." | sudo tee /etc/context-reader.env >/dev/null \
  && sudo chmod 600 /etc/context-reader.env && sudo systemctl restart context-reader'
```

Add `READER_MODEL=claude-haiku-5-5` (about 20× cheaper) or another model to the same file to change it. Without a key the reader still works, but selecting text shows a message instead of a translation.

## Layout

```
server.py            stdlib HTTP server: static files, library API, lookup proxy
public/              the app (no build step, plain ES modules)
  app.js             library, uploads, reader, selection → lookup, settings
  text-book.js       TXT/HTML adapter for foliate-js
  sw.js              offline cache
  vendor/foliate/    foliate-js (see VERSION for the commit and the one local patch)
  fonts/             Literata, Source Serif 4, Atkinson Hyperlegible Next (self-hosted, SIL OFL 1.1: OFL-*.txt)
deploy/              systemd unit, Caddy site block, deploy script
tests/               python3 -m unittest discover tests ; node --test tests/*.test.mjs
```

API: `POST /api/auth/register|login|logout`, `GET /api/auth/me`, `GET/POST /api/books`, `GET/PATCH/DELETE /api/books/:id`, `GET /api/books/:id/file`, `GET/PUT /api/books/:id/cover`, `POST /api/lookup`, `GET /api/store?q=&lang=&page=`, `POST /api/store/:gutenbergId`, `GET /api/store/:gutenbergId/cover`, `GET /api/config`.

## Accounts

Passwords are hashed with scrypt; sessions are a long-lived HttpOnly cookie (one year). Data: `users.json` and `sessions.json` next to `library.json` in the data folder. Books uploaded before accounts existed belong to the first account created.

Reset a forgotten password (also signs that account out everywhere):

```bash
ssh -t pihole 'cd ~/context-reader && READER_DATA=~/context-reader-data .venv/bin/python server.py set-password NAME'
```

## Deploying

Updates: `deploy/deploy.sh` runs the tests, rsyncs to `pihole:~/context-reader` and restarts the service. Data lives in `~/context-reader-data` and is never touched by deploys.

First-time setup (already done on the Pi):

1. `python3 -m venv ~/context-reader/.venv && ~/context-reader/.venv/bin/pip install anthropic`
2. `sudo cp deploy/context-reader.service /etc/systemd/system/ && sudo systemctl enable --now context-reader` (listens on 127.0.0.1:8095)
3. Append `deploy/Caddyfile.snippet` to `/etc/caddy/Caddyfile`, then `sudo systemctl restart caddy`. A reload doesn't work because the Caddyfile has `admin off`.
4. DNS: `sudo pihole-FTL --config dns.hosts` now includes `192.168.0.209 reader.pi.local`.
5. Public certificate for `reader.balu.party`: Caddy runs an official build with the Cloudflare DNS module (`/usr/local/bin/caddy-cloudflare`, from caddyserver.com's build service) through the systemd override `deploy/caddy-cloudflare.conf`, which also drops `--environ` so the token never reaches the journal. The Cloudflare token lives in `/etc/caddy/cloudflare.env` (root only) and can only edit DNS for balu.party, which hosts nothing else. Pi-hole maps `reader.balu.party` to the Pi. To go back to the stock Caddy: `sudo rm /etc/systemd/system/caddy.service.d/cloudflare.conf`, remove the `*.balu.party` block, `sudo systemctl daemon-reload && sudo systemctl restart caddy`.

## Known limits

- Lookups need the internet and API credits. When the month's credits run out, lookups say so until they refresh.
- DRM-protected Kindle/Adobe files can't be opened.
- PDFs are shown as pages: themes invert colors in dark mode but don't reflow text.
- Sign-up is open to anyone who can reach `reader.pi.local`. Each account only sees its own books.
- There is no in-app way to delete an account or change a password yet (use `set-password` above).
