# Ассистент — public AI chat (Cloudflare Worker)

One Worker: `POST /api/chat` (Gemini proxy with limits, see the header of `src/worker.js` for the protocol) + static files from `public/`.
Settings: `wrangler.jsonc` (`vars` = daily limits, `ratelimits` = burst). Name/model list/system prompt: top of `src/worker.js`.

## Local dev
```sh
cp .dev.vars.example .dev.vars        # put GEMINI_API_KEY=... inside (git-ignored)
npx wrangler dev                      # http://localhost:8787
npx wrangler dev --var DAILY_IP_LIMIT:2   # override a var for testing
```

## Deploy (first time)
```sh
npx wrangler login
npx wrangler kv namespace create LIMITS     # copy the printed id into wrangler.jsonc → kv_namespaces[0].id
npx wrangler secret put GEMINI_API_KEY      # paste the key when prompted
npx wrangler deploy                         # → https://assistant-chat.<subdomain>.workers.dev
```
Later updates: `npx wrangler deploy`. Logs: `npx wrangler tail`.

## Custom domain
Domain must be on Cloudflare (zone in the same account). Add to `wrangler.jsonc`:
```jsonc
"routes": [{ "pattern": "chat.example.com", "custom_domain": true }]
```
then `npx wrangler deploy` (or Dashboard → Workers → assistant-chat → Settings → Domains & Routes → Add custom domain).

## Notes
- Daily counters live in KV (eventually consistent, may overshoot slightly). Free KV plan = 1000 writes/day; each chat request writes 2 keys, so the default 400/day global cap fits.
- Frontend (`public/`): `index.html` + `style.css` + `app.js`, no inline scripts/styles (CSP has no `unsafe-inline`). Libraries (marked, DOMPurify, highlight.js) and Inter font come from CDNs allowed in the CSP; no Tailwind. Also `favicon.svg`, `manifest.webmanifest`, `robots.txt`.
- Product name: `APP_NAME` at the top of `public/app.js` (header + document.title) and by hand in `index.html` (`<title>`, og/twitter tags), `manifest.webmanifest`, and `APP_NAME` in `src/worker.js` (system prompt).
- Daily limits: `vars` in `wrangler.jsonc`. Model list: `MODELS` in `src/worker.js` and the `MODELS` const in `public/app.js` (keep in sync). Max message length 4000: `MAX_LAST` in worker, `MAX_INPUT_CHARS` in app.js.
- Chat history lives only in the browser (`localStorage` key `chats`); nothing is stored on the server.
