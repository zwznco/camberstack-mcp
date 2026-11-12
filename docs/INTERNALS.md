# Camberstack internals

Reference for running and maintaining the server. The product overview is the [README](../README.md); every tool is also documented at https://camberstack.io/tools.

## How auth works

Camberstack is an OAuth 2.1 authorization server for MCP clients (dynamic client registration,
PKCE). Its `/authorize` sends the user to Google for `openid email` plus `adwords` (Google Ads), `webmasters`
(Search Console) and `analytics.readonly` + `analytics.edit` (Google Analytics). Any one is enough to connect ("à la carte"), Google Ads included: a tool that needs a missing one returns a personal
`/connect/<google-ads|search-console|analytics>` link that adds just that service to the same Google account. Connections from before 0.25.0 hold `webmasters.readonly`, which still reads: their first Search Console proposal returns the `/connect/search-console` link. The Google refresh
token is stored AES-256-GCM encrypted and never leaves the server. The MCP client gets
Camberstack's own tokens, which are stored only as SHA-256 hashes.

## Tools (full reference)

| tool | writes? | what it does |
|---|---|---|
| `list_accounts` | no | every account the login reaches, including client accounts under a manager (MCC) |
| `account_overview` | no | spend, conversions, cost per conversion per campaign, plus `attention` when something needs a look: ads with policy problems and why, Google's open recommendations, primary conversions quiet for 30 days |
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
| `send_feedback` | no | sends the user's approved message to the maintainer; no account data or conversation |
| `propose_search_console_changes` | no | checks sitemap and property changes against the live property and stores a proposal |
| `paid_organic_overlap` | no | joins an Ads account's search terms with a site's organic queries: searches paid for that already rank near the top, and page-2+ searches with no ad |
| `analytics_properties` | no | the Google Analytics 4 properties the login can read; if Analytics isn't granted yet, a personal link that adds it |
| `analytics_setup` | no | a property's web streams (measurement IDs), key events and Google Ads links |
| `propose_analytics_changes` | no | like `propose_changes`, for GA4 setup: `create_ga4_property` (with a web stream; the applied result gives the tag), `mark_key_event`/`unmark_key_event`, `link_google_ads`/`unlink_google_ads`. Applied and undone with `apply_changes`/`undo_changes` |
| `analytics_landing_pages` | no | sessions, users, engagement rate, key events and key event rate per landing page, optionally for one channel (e.g. Paid Search) |
| `analytics_report` | no | any GA4 Data API report by dimension and metric names, with a contains filter |
| `landing_page_speed` | no | PageSpeed Insights for up to 5 pages: Core Web Vitals from real Chrome visitors (28 days), a Lighthouse score, and the fixes worth most. Any public URL, no Google service needed |
| `merchant_accounts` | no | the Merchant Center accounts the login can read (sub-accounts included); if Merchant Center isn't granted yet, a personal link that adds it |
| `merchant_product_issues` | no | account issues, product status counts, and each product issue with how many products it hits and examples; or one product's issues in full |
| `merchant_report` | no | any read-only Merchant Center Query Language (MCQL) query, e.g. Shopping clicks per product from `product_performance_view` |
| `merchant_ad_spend` | no | Merchant Center problems (disapproved, limited, pending) joined with what each product earned in Shopping and Performance Max ads, most value first, and whether it stopped spending in the last 7 days |
| `propose_merchant_changes` | no | like `propose_changes`, for Merchant Center products: `set_product_attributes` (price, GTIN, title, …), `exclude_products`/`include_products`, `clear_product_overrides`, and `add_product`/`update_product`/`delete_product` for products in Camberstack's own "Camberstack products" source. Applied and undone with `apply_changes`/`undo_changes` |
| `propose_changes` | no | resolves changes against the live account, dry-runs them with Google (`validateOnly`), stores a proposal with a plain-English summary |
| `apply_changes` | **yes** | applies a stored proposal (the user's own, un-applied, still matching the account; if the account moved, returns an updated proposal to approve instead); records each change's inverse |
| `undo_changes` | no | builds the reversing proposal for an applied one |
| `switch_account` (`choose_account` on ChatGPT) | plan only | takes the account the user picked after an "Account choice:" notice as one of the plan's; changes nothing in Google Ads. No switching since 0.29.0; ChatGPT's review flagged the old name as inconsistent with that (0.30.1) |
| `billing` | no | plan, Google Ads accounts in use (last 30 days) vs. the plan's limit, and a personal upgrade or manage-billing link |
| `discard_proposal` | no | marks an open proposal discarded so it can't be applied |
| `change_history` | no | every proposal, with what was applied, what failed and what was undone |
| `disconnect` | no | revokes Camberstack's Google access and deletes the stored credentials (the user confirms) |

The Search Console tools take either `days` or exact `start_date`/`end_date`, and `fresh: true` to include the last 2-3
days Google is still filling in. Sitemaps and properties change through `propose_search_console_changes`
(submit or delete a sitemap, add or remove a property). Requesting indexing has no API, and verifying a property is
done in Search Console.

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
- **Delete:** keywords, ads, ad groups, campaigns, a campaign's negatives and sitelinks (`delete_*`).
- **Edit and organize:** edit a responsive search ad in place (it keeps its id and stats), ad group negatives, shared negative lists, ad schedules, device bids, callouts, snippets, business name, logos and images, AI Max and Google-written text, conversion value, window and attribution, remarketing lists, applying or dismissing recommendations, and review requests for exemptible refusals.
- **Measure:** create or remove a conversion action, set its counting, import a GA4 key event, scope a campaign to one conversion goal.
- **Connect:** link or unlink a Merchant Center account (`productLinks:create`/`:remove`; neither dry-runs: create has
  none and remove's always answers 500, so propose checks the account is reachable and not a test account, which Google won't link).

Risky changes carry a ⚠ line in the proposal summary: enabling a campaign, more than doubling a budget or a
bid, switching bid strategy, removing the last location, a new primary conversion action, removing a conversion
action, deleting an ad, ad group or campaign. Undo removes only what Camberstack itself created. Google can't restore a removed
ad, ad group, campaign or conversion action, so those carry a ⚠ and no undo (a GA4 import is the exception: undo imports it
again). Undo adds a deleted keyword back with its id and stats, and a negative or sitelink as a new one; a paused keyword has no undo. (Undoing a GA4 import removes the action, since Google can't hide it again; importing again
restores it.) Removing a verified Search Console property carries a ⚠ and no undo: it has to be added and verified again.

## Merchant Center, Analytics and SDK notes

The Google Analytics tools need `analytics.readonly` and `analytics.edit` (Google-verified sensitive scopes). Sign-in
asks for them alongside Ads and Search Console; a connection made before they were added gets a personal
`/connect/analytics` link on its first Analytics call, which adds both to the same Google account. The Cloud project
needs the Google Analytics Data API and Admin API enabled.

Merchant Center accounts are their own plan allowance, the same size as Google Ads' (Free 1, Plus 1, Pro 5, Agency 25), counted as
`mc:<id>` in `tool_calls` with their own switch (`switch_account` takes `mc:<id>`).

The Merchant Center tools need `content`, which isn't part of connecting: the first call without it
returns a personal `/connect/merchant-center` link that adds it. Before any call works, the Cloud project needs
the Merchant API enabled and **registered once** with a production Merchant Center account the operator administers
(`POST https://merchantapi.googleapis.com/accounts/v1/accounts/{ID}/developerRegistration:registerGcp`); merchants
don't register. Unregistered, calls answer 401 "not registered", which the tools report as Camberstack's to fix.
Reports work on standalone accounts and sub-accounts, not on an advanced account itself. Account `000000001` is the
demo (sample data: two best sellers disapproved for a price mismatch 9 days ago; overrides there fix the issue).

Products Camberstack creates live in its own primary API source ("Camberstack products"); only those can be updated in
place or deleted (undo re-creates them from Camberstack's copy). Adding an offer_id another feed already has is refused,
since Google would move that product into our source ("offer stealing").

Merchant Center changes never edit the merchant's feed. Each is an override in Camberstack's own supplemental data source
("Camberstack overrides"), created on the first write. Google applies a supplemental source only once it's in a primary
source's rules, so the first override on a feed's products also patches that feed's `defaultRule` to put ours first
(every source already there is kept): the summary shows it as a ⚠ line. Feeds made in the Merchant Center UI or by
autofeed can't be patched, and the proposal says so. Google can't read overrides back, so `merchant_overrides` keeps
Camberstack's copy per product; undo restores exactly that (removing the input when there was none). The Merchant API
has no dry run: re-resolving at apply is the check, as with GA4.

Two MCP SDKs, on purpose: `/mcp` is served by SDK v2 (`@modelcontextprotocol/server` + `/node`), which
answers both 2026-07-28 clients (`server/discover`) and 2025-era ones (`initialize`, kept on a
JSON-response transport). The authorization server (`mcpAuthRouter`, `requireBearerAuth`) stays on
`@modelcontextprotocol/sdk` 1.x, because v2 ships only the resource-server half. Don't drop 1.x
until v2 (or a companion package) has `/authorize`, `/token` and `/register`.

## Run it

```bash
npm ci && npm test
ENCRYPTION_KEY=$(openssl rand -hex 32) \
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… \
BASE_URL=https://your.host npm run dev
```

| env | |
|---|---|
| `ENCRYPTION_KEY` | 32 bytes, hex or base64. **Losing it only forces users to reconnect**; leaking it exposes stored Google tokens |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client from a **dedicated** Google Cloud project with Google Ads API access. Redirect URI: `<BASE_URL>/oauth/google/callback`. Unset = pages only, sign-in reports "not open yet" |
| `BASE_URL` | public origin, the OAuth issuer (default `https://camberstack.io`) |
| `DATA_DIR` | SQLite location (default `./data`) |
| `PRO_EMAILS` | emails treated as Pro |
| `FREE_ONE_SERVICE` | Free covers one Google service at a time (Ads, Search Console, GA4, Merchant Center or Tag Manager: the most recently used, over 30 days); paid plans cover all five. `YYYY-MM-DD` = announced until that day, 08:00 UTC (midnight Pacific): the site, `billing`, the account page and the welcome email describe the change, nothing is gated; from that day it's on, and only calls since then count, so every Free user picks a service. `1` = on now. Off unless set. The demo never counts |
| `FREE_CHANGE_CAP` | Free applies at most this many proposals per 30 days (a whole number; unset = unlimited). One `apply_changes` of a proposal counts once, however many changes it holds; undo, the demo and calls before `plan_reset_at` don't count. Past it, `apply_changes` returns a `Change limit:` notice (a normal result, not an error) with the date the next opens, and the proposal stays open; Plus, Pro and Agency are unlimited. The site, `billing`, the account page and the welcome email describe the cap, Plus is sold as unlimited changes on 1 account, and the `change_limit` email goes out the next morning. Prod: `10` since 0.31.0, replacing `FREE_ONE_SERVICE` before it switched on |
| `FREE_CHANGE_CAP_FROM` | ISO time the cap went on; approvals before it don't count, so everyone started at 0 (prod: `2026-11-12T01:54:44Z`, when 0.31.0 went live). Also the start of the admin paywall read. Unset = the whole 30 days count |
| `STRIPE_SECRET_KEY` / `STRIPE_PRO_PRICE_ID` | Pro subscription via Stripe Checkout; unset = no upgrade links |
| `STRIPE_PLUS_PRICE_ID` | the Plus plan's price; unset = no Plus offered |
| `STRIPE_AGENCY_PRICE_ID` | the Agency plan's price (its own product); unset = no Agency offered. Which plan a user is on follows their subscription's price, so a plan switch in Stripe's billing portal (which must list the prices) moves it within the hour |

The hosted HTTP server is `npm run start:http` (the Docker image runs `node dist/server.js`).
`npm start` is a stdio mode that needs no env, database or Google login: it lists every tool for
directory inspectors (Glama runs `mcp-proxy -- pnpm run start`), and any tool call answers with
the hosted URL to connect to. `pnpm-workspace.yaml` turns off native builds for pnpm installs, so
stdio mode installs anywhere; production installs with npm.

