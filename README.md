# Ktuvit subtitles addon for Stremio

Unofficial addon that serves Hebrew subtitles from ktuvit.me to Stremio.
No dependencies — just Node 18.14 or newer.

## 1. Run

Ktuvit only lets logged-in users see and download subtitles, so the addon needs an account.

```bash
KTUVIT_EMAIL="you@example.com" KTUVIT_PASSWORD="your-password" node index.js
```

The addon hashes the password the same way the site's login form does.
Alternatives: `KTUVIT_HASHED_PASSWORD` (the `Password` value from the site's Login
request) or `KTUVIT_LOGIN_COOKIE` (value of the `Login` cookie, `u=...&g=...`).

## 2. Install in Stremio

Same computer: paste `http://127.0.0.1:7000/manifest.json` into the addon search box.

## 3. Phone / TV (needs HTTPS)

Stremio only accepts HTTPS addons unless they are on 127.0.0.1. Two ways:

**A. Quick tunnel from your own computer (no account, computer must stay on)**

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:7000
```

It prints an `https://....trycloudflare.com` address. Install
`https://....trycloudflare.com/manifest.json` in Stremio. The address changes every
time you restart the tunnel.

**B. Always-on public hosting (Render free plan)**

1. Put these files in a GitHub repository.
2. On render.com: New → Blueprint → pick the repo (`render.yaml` is included).
3. Fill in `KTUVIT_EMAIL` and `KTUVIT_PASSWORD` when Render asks. They are stored on
   Render only — never commit them to the repository.
4. Share `https://<your-app>.onrender.com/` — it shows an install page.

Everyone who installs the addon downloads through that one ktuvit account. The addon
caches results and limits each visitor to 5 subtitle downloads a minute
(`RATE_LIMIT_PER_MIN`) to protect it. The free plan sleeps when idle, so the first
request after a pause can be slow.

For a private instance instead, set `ADDON_SECRET` to put the whole addon under a
secret path. Set `PUBLIC_URL=https://your-host` if a proxy doesn't forward the Host
header correctly.

## How it works

1. Stremio asks `/subtitles/{movie|series}/{imdbId[:season:episode]}.json`.
2. The addon gets the title from Cinemeta, searches ktuvit, and matches on IMDb id.
3. It scrapes the subtitle list, sorts it by similarity to your video's file name,
   and returns links to `/sub/{filmId}/{subId}.srt`, each labelled with its release name
   (shown by Stremio versions that support subtitle labels).
4. When Stremio loads a link, the addon downloads the file from ktuvit with your
   session, converts it to UTF-8 (many files are windows-1255) and serves it.

## Notes

- Your credentials stay on the server you run this on. Anyone who can reach the addon
  downloads through that account, so use a dedicated ktuvit account for a public instance.
- This is a scraper; if ktuvit changes its pages, `parseSubsHtml` / the endpoint
  paths in `index.js` are what need updating.
