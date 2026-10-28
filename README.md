# Camberstack: a Google Ads MCP server

[![Camberstack MCP server on Glama](https://glama.ai/mcp/servers/zwznco/camberstack-mcp/badges/score.svg)](https://glama.ai/mcp/servers/zwznco/camberstack-mcp)

Connect Google Ads (and, optionally, Search Console) to Claude, ChatGPT, Cursor or any MCP client. Your AI
reads the account with read-only tools and can propose changes, from negative keywords to whole Search,
Performance Max, Display and YouTube campaigns. **Nothing changes in the account until you approve a specific
proposal, and every applied change can be undone in one call, on every plan.** Risky changes (turning a campaign on,
more than doubling a budget or bid, switching bid strategy) are flagged in the proposal before you approve. A demo
account lets anyone try every tool first.

Hosted: **https://camberstack.io/mcp** (Free: 1 Google Ads account at a time with one switch a month, every tool, unlimited changes; Pro $15/mo: up to 5 accounts; Agency $49/mo: up to 25).

**Setup guides, with screenshots and troubleshooting:** [Connect Google Ads to Claude](https://camberstack.io/google-ads-claude) ·
[Connect Google Ads to ChatGPT](https://camberstack.io/google-ads-chatgpt) · [every tool](https://camberstack.io/tools) ·
[Cursor, VS Code and others](https://camberstack.io/#setup)

## Tools

| tool | writes? | what it does |
|---|---|---|
| `list_accounts` | no | every account the login reaches, including client accounts under a manager (MCC) |
| `account_overview` | no | spend, conversions, cost per conversion per campaign |
| `keyword_ideas` | no | Keyword Planner ideas from seed keywords and/or a URL: monthly searches, competition, top-of-page bid range; marks ideas the account already targets or blocks |
| `keyword_metrics` | no | Keyword Planner numbers for an exact list, with the last 12 months of searches |
| `run_gaql` | no | any read-only GAQL `SELECT` |
| `search_console_sites` | no | the websites (Search Console properties) the login can read |
| `search_console_summary` | no | site-wide clicks, impressions, CTR and position for a window vs. the window before it |
| `search_console_performance` | no | organic clicks, impressions, CTR and position by query, page, country, device or date; text or RE2 regex filters |
| `search_console_trend` | no | a window vs. the one before it, per query and per page: rising, falling, new, lost, and rising searches losing position |
| `search_console_opportunities` | no | queries on positions 4-20 with projected click gain, top-5 queries with weak CTR, question-shaped queries |
| `search_console_inspect_urls` | no | URL Inspection for up to 20 pages: indexed or why not, last crawl, canonical chosen vs declared, structured-data errors |
| `search_console_sitemaps` | no | submitted sitemaps: last downloaded, URL count, errors and warnings |
| `paid_organic_overlap` | no | joins an Ads account's search terms with a site's organic queries: searches paid for that already rank near the top, and page-2+ searches with no ad |
| `analytics_properties` | no | the Google Analytics 4 properties the login can read; if Analytics isn't granted yet, a personal link that adds it |
| `analytics_setup` | no | a property's web streams (measurement IDs), key events and Google Ads links |
| `propose_analytics_changes` | no | like `propose_changes`, for GA4 setup: `create_ga4_property` (with a web stream; the applied result gives the tag), `mark_key_event`/`unmark_key_event`, `link_google_ads`/`unlink_google_ads`. Applied and undone with `apply_changes`/`undo_changes` |
| `analytics_landing_pages` | no | sessions, users, engagement rate, key events and key event rate per landing page, optionally for one channel (e.g. Paid Search) |
| `analytics_report` | no | any GA4 Data API report by dimension and metric names, with a contains filter |
| `propose_changes` | no | resolves changes against the live account, dry-runs them with Google (`validateOnly`), stores a proposal with a plain-English summary |
| `apply_changes` | **yes** | applies a stored proposal (the user's own, un-applied, still matching the account; if the account moved, returns an updated proposal to approve instead); records each change's inverse |
| `undo_changes` | no | builds the reversing proposal for an applied one |
| `switch_account` | plan only | spends the plan's one account switch per 30 days on an account, after the user agrees; changes nothing in Google Ads |
| `billing` | no | plan, Google Ads accounts in use (last 30 days) vs. the plan's limit, and a personal upgrade or manage-billing link |
| `discard_proposal` | no | marks an open proposal discarded so it can't be applied |
| `change_history` | no | every proposal, with what was applied, what failed and what was undone |
| `disconnect` | no | revokes Camberstack's Google access and deletes the stored credentials (the user confirms) |

The Search Console tools take either `days` or exact `start_date`/`end_date`, and `fresh: true` to include the last 2-3
days Google is still filling in. Requesting indexing and submitting sitemaps aren't available: Camberstack only holds
the read-only scope.

The Google Analytics tools need `analytics.readonly` and `analytics.edit` (Google-verified sensitive scopes). Sign-in
asks for them alongside Ads and Search Console; a connection made before they were added gets a personal
`/connect/analytics` link on its first Analytics call, which adds both to the same Google account. The Cloud project
needs the Google Analytics Data API and Admin API enabled.

What a proposal can do:

- **Control:** add negative keywords; pause or enable a campaign, ad group, keyword or ad; set a campaign's
  daily budget (never a shared budget) or its end date.
- **Build**, always created **paused** (building and spending are two separate approvals):
  - a **Search** campaign: ad groups, keywords, responsive search ads, targeting, negatives, sitelinks;
  - a **Performance Max** campaign: asset groups of text, images and YouTube videos, with the business name and
    logo on the campaign as Google's brand guidelines require (no shopping feed);
  - a **Display** campaign: responsive display ads;
  - a **Demand Gen** campaign with YouTube video ads, the API's only way onto YouTube (it refuses to create
    Video campaigns: `MUTATE_NOT_ALLOWED`, v23).

  Images are existing image assets or https URLs, which are downloaded SSRF-safe (`src/fetch-safe.ts`) and
  uploaded. A proposal can also add an ad group, keywords, an ad or sitelinks to an existing campaign.
- **Tune:** keyword and ad group bids, bid strategy, location and language targeting, presence-only location
  mode, final URL suffix, and a campaign's EU political advertising declaration (Google refuses every change to an
  account while any campaign lacks one).
- **Measure:** create a conversion action, set its counting, import a GA4 key event, scope a campaign to one conversion goal.

Risky changes carry a ⚠ line in the proposal summary: enabling a campaign, more than doubling a budget or a
bid, switching bid strategy, removing the last location, a new primary conversion action. Undo removes only
what Camberstack itself created; nothing the user built is ever deleted. (Undoing a GA4 import removes the action, since
Google can't hide it again; importing again restores it.) Search Console is read-only.

## How auth works

Camberstack is an OAuth 2.1 authorization server for MCP clients (dynamic client registration,
PKCE). Its `/authorize` sends the user to Google for `adwords` + `openid email`, plus `webmasters.readonly`
(Search Console). Either is enough to connect ("à la carte"): a tool that needs a missing one, or Google Analytics, returns a personal
`/connect/<google-ads|search-console|analytics>` link that adds just that service to the same Google account. The Google refresh
token is stored AES-256-GCM encrypted and never leaves the server. The MCP client gets
Camberstack's own tokens, which are stored only as SHA-256 hashes.

Two MCP SDKs, on purpose: `/mcp` is served by SDK v2 (`@modelcontextprotocol/server` + `/node`), which
answers both 2026-07-28 clients (`server/discover`) and 2025-era ones (`initialize`, kept on a
JSON-response transport). The authorization server (`mcpAuthRouter`, `requireBearerAuth`) stays on
`@modelcontextprotocol/sdk` 1.x, because v2 ships only the resource-server half. Don't drop 1.x
until v2 (or a companion package) has `/authorize`, `/token` and `/register`.

## Run it

```bash
npm ci && npm test
ENCRYPTION_KEY=$(openssl rand -hex 32) \
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GOOGLE_ADS_DEVELOPER_TOKEN=… \
BASE_URL=https://your.host npm run dev
```

| env | |
|---|---|
| `ENCRYPTION_KEY` | 32 bytes, hex or base64. **Losing it only forces users to reconnect**; leaking it exposes stored Google tokens |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client from a **dedicated** Google Cloud project with Google Ads API access. Redirect URI: `<BASE_URL>/oauth/google/callback`. Unset = pages only, sign-in reports "not open yet" |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | sent when set |
| `BASE_URL` | public origin, the OAuth issuer (default `https://camberstack.io`) |
| `DATA_DIR` | SQLite location (default `./data`) |
| `FREE_ACCOUNTS` / `PRO_ACCOUNTS` / `PRO_EMAILS` | Google Ads accounts each plan covers at a time, counted as distinct accounts used in the last 30 days plus one switch per 30 days, manager and demo accounts excluded (defaults 1 / 10) / emails treated as Pro |
| `FREE_ONE_SERVICE` | Free covers one Google service at a time (Ads, Search Console or GA4: the most recently used, over 30 days); paid plans cover all three. `YYYY-MM-DD` = announced until that day (UTC): the site, `billing`, the account page and the welcome email describe the change, nothing is gated; from that day it's on, and only calls since then count, so every Free user picks a service. `1` = on now. Off unless set. The demo never counts |
| `STRIPE_SECRET_KEY` / `STRIPE_PRO_PRICE_ID` | Pro subscription via Stripe Checkout; unset = no upgrade links |
| `STRIPE_AGENCY_PRICE_ID` / `AGENCY_ACCOUNTS` | the Agency plan's price (its own product) / accounts it covers (default 25); unset price = no Agency offered. Which plan a user is on follows their subscription's price, so a Pro ↔ Agency switch in Stripe's billing portal (which must list both prices) moves it within the hour |

The hosted HTTP server is `npm run start:http` (the Docker image runs `node dist/server.js`).
`npm start` is a stdio mode that needs no env, database or Google login: it lists every tool for
directory inspectors (Glama runs `mcp-proxy -- pnpm run start`), and any tool call answers with
the hosted URL to connect to. `pnpm-workspace.yaml` turns off native builds for pnpm installs, so
stdio mode installs anywhere; production installs with npm.

`scripts/try-account.ts` runs the read tools against a real account from an existing refresh
token, skipping OAuth. Use it for dogfooding.

## License

MIT
