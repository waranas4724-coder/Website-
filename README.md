# PromptForge

A clean prompt-library website with:
- responsive public prompt library
- search, media filters and categories
- prompt detail + copy
- protected admin panel
- 5-click logo gesture to reveal `/admin.html`
- scheduled automatic collector
- duplicate protection
- JSON storage for a simple starter deployment

## Run

1. Install Node.js 18+.
2. Copy `.env.example` to `.env`.
3. Change `SESSION_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD`.
4. `npm install`
5. `npm start`
6. Open `http://localhost:3000`

## Automatic publishing

Set `SOURCE_URL` to an API/feed you are authorized to use. It must return either:

`[{ "title": "...", "prompt": "...", "media": "Image", "model": "...", "category": "...", "imageUrl": "...", "source": "..." }]`

or:

`{ "prompts": [ ... ] }`

The collector runs according to `AUTO_POST_CRON` (default every 30 minutes), checks duplicates, and publishes new records.

This starter intentionally does not scrape/copy third-party websites without permission. Use an official API, RSS/feed, or your own source.

## Admin

The 5-click logo gesture only hides/reveals the login page. Real protection is the server-side username/password session. Do not rely on the click gesture as security.

For production, move data to PostgreSQL/Supabase and put the app behind HTTPS.

## Public API (read-only, CORS open)

- `GET /api/v1/prompts?media=photo|video&category=&q=&license=&page=1&limit=20`
- `GET /api/v1/prompts/:slug`
- `GET /api/v1/categories`

## Feeds

- `/rss.xml` (all), `/rss/image.xml` (photo), `/rss/video.xml` (video), `/feed.json` (JSON Feed)
- Set `SITE_URL` in `.env` so feed links use your real domain.

## Legal sourcing

The built-in library (`data/seed.json`) is original text released as CC0. External sources go in `data/sources.json`
(`type`: `json` or `rss`); the collector skips any source without a `license` and `"permission": true`.
Do not add sources you have no right to republish. Every prompt stores its `license`, `source` and `sourceUrl`.

## Ads

Admin panel (5 quick logo clicks) has an Ads & Monetization card: head code, popunder, social bar, 4 banner places, native banner and smart link. Banners load inside sandboxed iframes. Note: on hosts with a temporary disk (Render free) `data/ads.json` resets on redeploy - keep a copy of your ad codes.
