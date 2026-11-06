# Context Reader

A self-hosted e-book reader that feels like a phone app. Select any word or passage while reading and a sheet slides up with its translation, the whole sentence translated, and dictionary entries, in the language you chose for that book.

**Live:** https://reader.balu.party, on a VPS behind Cloudflare. Accounts are by invitation (see Accounts).

## What it does

- **Formats:** EPUB, MOBI, AZW3/KF8, FB2 (and .fb2.zip), CBZ, PDF, TXT, HTML. Rendering is [foliate-js](https://github.com/johnfactotum/foliate-js), the engine behind the Foliate reader.
- **Accounts:** everyone signs in with a name and password and gets a private library. Books, reading positions and translation languages belong to the account, and appearance settings are remembered per account on each device. Accounts are created by the server's owner (`add-user`); after the first password sign-in, each device can add a **passkey** (Face ID, fingerprint or device PIN) and sign in with it from then on.
- **Free books:** a store screen (the shelf icon in the library, or "Browse free books" when it's empty) lists Project Gutenberg's public-domain books, most popular first. Search by title or author, filter by language, and tap **Get**: the server downloads the EPUB with its cover straight into your library. Gutenberg is rich in English, German and French but has only a few Russian and Romanian books.
- **Library on the server:** uploads go to the server, so the same books and reading position show up on every device you sign in on. Each book reopens where you stopped; the library shows a Continue reading card and how far you are into every book. Covers, titles and authors come from the file.
- **Translation per book:** into English, Russian, Romanian or German. The first time you open a book it asks which; change it any time with the language chip in the top bar. The book's own language is detected (or set it in the same sheet).
- **Lookup:** long-press to select on a phone, then tap **Translate**. On a desktop, double-click or drag-select and the sheet opens directly. You get:
  - the selection as it appears in the book, keeping paragraphs, line breaks, italics and bold
  - the translation, broken into the same paragraphs and lines, translated for the sense used in that sentence
  - **"In this context":** what it means here (idioms, wordplay, archaic words, references)
  - the sentence it sits in, with its translation
  - for single words: the dictionary form, part of speech and other common meanings

  Longer selections come from one Claude Sonnet call (roughly half a cent), streamed so the translation appears as it's written (first words in about 1.5 s). One- or two-word selections use Google Translate instead (under a second, translation and sentence only, no explanation), falling back to Claude if Google fails. Closing the sheet cancels the request. Results are cached on the server.
  - listen (text-to-speech) and copy
- **Reading comfort:** 7 themes plus custom page and text colors, 3 reading fonts or the book's own, text size, line spacing, margins, justification, hyphenation, paged or scrolling layout (Aa → Layout; in Scroll, keep swiping at the end of a chapter to continue into the next), animated page turns. Two columns on wide screens. Settings are per device.
- **Feels native:** installable to the home screen (PWA): the library shows an **Install** banner (Android/Chrome/Edge open the install dialog; iPhone/iPad get Add to Home Screen steps), also in the account sheet. Installed, it opens full screen without browser bars, works offline for books you've opened, tap the edges or swipe to turn pages, tap the middle to show the controls, and the back button/gesture closes sheets and the book.

## API key (required for lookups)

Lookups use Claude (`claude-sonnet-5-5` by default, with Anthropic's server-side fallback if it declines a passage). A Max plan includes $100 of API credits a month: on claude.ai go to Settings → Billing → API credits, link a Console organization, then create a key at platform.claude.com. Put it on the server (it asks for the key without showing it):

```bash
ssh -t vps 'read -rsp "Anthropic API key: " k && echo && printf "ANTHROPIC_API_KEY=%s\n" "$k" | sudo tee /etc/context-reader.env >/dev/null \
  && sudo chmod 600 /etc/context-reader.env && sudo systemctl restart context-reader && echo saved'
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
tests/               unit + browser tests (see Tests)
```

## Tests

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # once: same packages as the server
.venv/bin/python -m unittest discover tests     # server: library, accounts, store, lookups (Claude streaming,
                                                # Google for 1-2 words, cancel on close), sign-up rules, throttling,
                                                # passkeys (real signatures from a software authenticator), all offline
node --test tests/*.test.mjs                    # TXT/HTML book adapter
tests/e2e/run.sh                                # headless Chrome: every format, lookups (streaming, cancel,
                                                # Google vs Claude), appearance, scroll mode, progress, store,
                                                # accounts, home-screen install, passkeys (Chrome's virtual
                                                # authenticator). Needs Google Chrome.
```

The browser tests start the real server with fake Claude and Google (`tests/e2e/fake_server.py`) on a
throwaway data folder; only the store section goes online (to Project Gutenberg; `SKIP_STORE=1` skips it).
Sample books in `tests/fixtures/books/` are Project Gutenberg public-domain editions plus a short folk tale.
`deploy/deploy.sh` runs the unit tests before every deploy.

API: `POST /api/auth/register|login|logout`, `POST /api/auth/passkey-options|passkey-add|passkey-remove|passkey-login-options|passkey-login`, `GET /api/auth/me`, `GET/POST /api/books`, `GET/PATCH/DELETE /api/books/:id`, `GET /api/books/:id/file`, `GET/PUT /api/books/:id/cover`, `POST /api/lookup`, `GET /api/store?q=&lang=&page=`, `POST /api/store/:gutenbergId`, `GET /api/store/:gutenbergId/cover`, `GET /api/config`.

## Accounts

Passwords are hashed with scrypt; sessions are a long-lived HttpOnly cookie (one year). Data: `users.json` and `sessions.json` next to `library.json` in the data folder. Books uploaded before accounts existed belong to the first account created.

- **Sign-ups:** `READER_SIGNUPS=closed` (set in `deploy/context-reader.service`) turns off "Create account" in the app. Without it, anyone who can reach the server can register.
- **Create an account** (asks for the password twice):
  ```bash
  ssh -t vps 'sudo -u reader env READER_DATA=/var/lib/context-reader /srv/context-reader/.venv/bin/python /srv/context-reader/server.py add-user NAME'
  ```
- **Reset a forgotten password** (also signs that account out everywhere): the same command with `set-password NAME`.
- **Passkeys** use the `webauthn` package. They're tied to the address they were made on (a passkey made on one address doesn't work on another), always ask for Face ID, fingerprint or PIN, and each challenge works once and expires after 5 minutes. Remove one under Account; also delete it from the password manager.
- **Throttling:** 10 failed sign-ins (password or passkey) from one IP in 15 minutes block that IP for the rest of the window. Behind Caddy the client IP comes from the last `X-Forwarded-For` entry.

## Deploying

Updates: `./deploy/deploy.sh vps` runs the tests, rsyncs to the server, installs `requirements.txt` and restarts the service. Data is never touched by deploys.

How the VPS (Ubuntu 24.04, `ssh vps`) is set up:

- **Access:** SSH keys only, as the admin user `dbalutel` (passwordless sudo); root login and passwords are off (`/etc/ssh/sshd_config.d/00-hardening.conf`). fail2ban bans an IP for an hour after 5 failed SSH logins. Security updates install automatically.
- **Firewall (ufw):** SSH from anywhere; ports 80/443 only from Cloudflare (`deploy/cloudflare-only.sh`, re-run it if Cloudflare's ranges change). Everything else is closed.
- **App:** code in `/srv/context-reader` (owned by the admin user, `~/context-reader` links to it), data in `/var/lib/context-reader` (only the `reader` system user can read it). `deploy/context-reader.service` runs it as `reader` on 127.0.0.1:8095 with systemd sandboxing and sign-ups closed. The API key is in `/etc/context-reader.env` (root only).
- **Caddy** (official apt repo): `deploy/Caddyfile` → `/etc/caddy/Caddyfile`. It gets and renews a Let's Encrypt certificate for `reader.balu.party` itself over port 80, through Cloudflare, and passes the visitor's real IP (Cloudflare's `CF-Connecting-IP`) to the app as `X-Real-IP`.
- **Cloudflare:** `reader` A and AAAA records, proxied (DDoS protection, hides the server's IP); SSL/TLS mode **Full (strict)**, so Cloudflare checks the server's certificate. The free plan caps uploads at 100 MB, so the app does too.

First-time setup on a fresh server, in short: create the `reader` user and the two folders, rsync the code, `python3 -m venv /srv/context-reader/.venv && /srv/context-reader/.venv/bin/pip install -r /srv/context-reader/requirements.txt`, copy the service file and Caddyfile into place, add the DNS records, then the API key and accounts.

## Known limits

- Lookups need the internet and API credits. When the month's credits run out, lookups say so until they refresh.
- DRM-protected Kindle/Adobe files can't be opened.
- PDFs are shown as pages: themes invert colors in dark mode but don't reflow text.
- There is no in-app way to delete an account or change a password yet (use `set-password` above).
- Passkey sign-in needs HTTPS (or `localhost`), so it isn't offered on plain-HTTP addresses.
