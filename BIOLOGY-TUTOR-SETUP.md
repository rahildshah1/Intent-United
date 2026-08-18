# Biology Tutor — setup

The Biology Lab section on `ai.html` is a Gemini-backed chat. Unlike the
Botpress tutor above it, this one is ours end to end, so it needs a little
infrastructure: a Cloudflare Worker to hold the API keys and count the shared
daily budget, and one Supabase table to keep each student's conversation.

Nothing here is optional — until steps 1 and 2 are done the tutor will answer
every question with a sign-in or configuration error.

---

## 1. Supabase — the conversation table

Dashboard → SQL Editor → New query → paste and run **one** of:

- `supabase/bio-chat-schema.sql` — just the new `bio_chats` table, or
- `supabase/schema.sql` — the full combined schema, which now includes it.

Both are idempotent, so running either more than once is safe. They also update
`delete_own_account()` so "delete my account" erases the biology transcript
along with everything else.

## 2. Cloudflare — the Worker secrets

The two Gemini keys must never be committed or shipped to the browser. Set them
as Worker secrets:

```
npx wrangler secret put GEMINI_API_KEY_1
npx wrangler secret put GEMINI_API_KEY_2
```

Each command prompts for the value and stores it encrypted against the
`intent-united` Worker. Then deploy:

```
npm run cf:deploy
```

The first deploy also creates the `QuotaCounter` Durable Object (declared in
`wrangler.toml` under `[[migrations]]`), which is where the daily counts live.

## 3. Local development

```
npm run cf:dev
```

Create a `.dev.vars` file first (gitignored — never commit it):

```
GEMINI_API_KEY_1="AQ...."
GEMINI_API_KEY_2="AQ...."
```

`npm run dev` (the plain Node server) still serves the static pages, but it has
no `/api/bio-chat` route, so the Biology Tutor only works under `npm run cf:dev`.

> The `cf:dev` script passes `--persist-to` a directory outside the project.
> That is deliberate: `[assets] directory = "./"` makes wrangler watch the whole
> project folder, so leaving its local state in `./.wrangler` puts the Worker in
> an endless reload loop as its own SQLite writes retrigger the watcher.

---

## How the quota works

Four slots, tried strictly in this order. Each is one (key, model) pair with its
own 500-requests-per-day budget:

| # | key   | model                   | limit |
|---|-------|-------------------------|-------|
| 1 | key 1 | `gemini-3.5-flash-lite` | 500   |
| 2 | key 2 | `gemini-3.5-flash-lite` | 500   |
| 3 | key 1 | `gemini-3.1-flash-lite` | 500   |
| 4 | key 2 | `gemini-3.1-flash-lite` | 500   |

Every request claims a slot **before** calling Google, so the switch happens on
our own count rather than on an error coming back. A 429 from Google is still
handled as a backstop: that slot is retired for the day and the request retries
one step down, so a stale count costs a retry rather than a failure.

When all four are spent, the API returns HTTP 503 and the UI locks the composer
with **"The AI Agent has run out of usage for the day."**

Counters are keyed by the current date in `America/Los_Angeles`, so they reset
by themselves at midnight Pacific — there is no cron job, a new day simply means
new storage keys and the old ones are pruned.

### One thing to check

Gemini free-tier daily limits are metered **per Google Cloud project, not per
key**. If both keys were created in the same project they share a single 500/day
pool, and slots 2 and 4 will 429 straight away — the backstop handles it
gracefully, but you get 500 requests a day instead of 2000. To actually get
2 × 500, each key needs to live in its own project.

### Checking today's usage

`GET /api/bio-quota` (signed in) returns the per-slot counts:

```json
{
  "day": "2026-08-18",
  "remaining": 1997,
  "total": 2000,
  "slots": [{ "id": "key1:gemini-3.5-flash-lite", "used": 3, "limit": 500 }]
}
```

---

## Files

| File | Role |
|------|------|
| `worker/index.js` | Worker: `/api/bio-chat`, `/api/bio-quota`, the `QuotaCounter` Durable Object, and the tutor's system prompt |
| `wrangler.toml` | Worker entry, assets binding, Durable Object binding + migration |
| `bio-chat.js` | The chat UI. Never sees a key — it only posts to `/api/bio-chat` |
| `ai.html` | The Biology Lab section markup |
| `style.css` | `.bio-*` styles, appended at the end |
| `auth.js` | `getBioChat` / `saveBioChat` / `getAccessToken`, and clearing the local cache on sign-out |
| `supabase/bio-chat-schema.sql` | The `bio_chats` table, its RLS policies, and the updated delete function |

## Changing what the tutor will discuss

The whole persona and the biology-only boundary are in `SYSTEM_PROMPT` at the
top of `worker/index.js`. It is enforced by instruction, not by a filter, so
treat it as a strong default rather than a guarantee — spot-check it after any
edit. The starter questions students see are `STARTERS` in `bio-chat.js`.
