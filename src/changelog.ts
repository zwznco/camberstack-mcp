/**
 * What changed in each version, for people using Camberstack: /changelog renders it, and a GitHub release's notes
 * come from the same entry (`npx tsx src/changelog.ts <version>`). Newest first. Keep it to what users notice;
 * internal work (admin pages, deploys) stays in git.
 */
export interface Release { version: string; date: string; summary: string; items?: string[] }

export const CHANGELOG: Release[] = [
  {
    version: "0.23.0", date: "2026-10-30",
    summary: "Remarketing lists, acting on Google's recommendations, review requests, and a fix for logos on Search.",
    items: [
      "**Remarketing lists** (`create_remarketing_list`): a list of your site's visitors built from the Google tag, with no customer data uploaded. `set_campaign_audience` adds a list to a campaign in observation, with an optional bid change, and takes it off again.",
      "**Google's recommendations** (`act_on_recommendation`): apply or dismiss one. Applying has no undo and Google picks the details, so the summary warns you first. `account_overview` also links to the recommendations page.",
      "**Ask Google to review a refused ad or keyword:** when a refusal is exemptible and you say it complies, your assistant can resubmit it with a review request. It can't run until Google approves, and prohibited content can't be exempted.",
      "**Fixed:** adding a logo to a Search campaign failed. It now uses Google's business logo, and says so if the campaign already has one.",
    ],
  },
  {
    version: "0.22.0", date: "2026-10-30",
    summary: "Ad schedules, device bids, callouts and other assets, AI Max, and conversion settings.",
    items: [
      "**Ad schedules** (`set_ad_schedule`): choose which days and hours a campaign runs, with optional bid changes. The summary warns that hours left out stop showing ads.",
      "**Device bids** (`set_device_bid`): raise or lower bids on desktop, mobile or tablet. Smart bidding ignores everything except -100%, and the summary says so.",
      "**More campaign assets:** add callouts, structured snippets, a business name, logos and images (`add_campaign_assets`), and take them off again (`delete_campaign_assets`).",
      "**AI Max and Google-written text** (`set_ai_max`): turn them on or off in one change. Google only allows Google-written text on Search with AI Max on, and turning AI Max off turns that text off too.",
      "**Conversion settings** (`set_conversion_settings`): change a conversion action's value, counting window or attribution, with undo. Actions imported from GA4 stay managed there.",
    ],
  },
  {
    version: "0.21.0", date: "2026-10-30",
    summary: "Delete what you no longer want, edit an ad in place, manage ad group and shared negatives, and see what needs a look in the overview.",
    items: [
      "**Delete what you no longer want:** keywords, ads, ad groups, campaigns, a campaign's negative keywords and its sitelinks. Google can't restore a deleted ad, ad group or campaign, so the summary warns you before you approve and there's no undo. Undo adds a keyword, negative or sitelink back; a sitelink comes back as a new one, so its history restarts.",
      "**To change a sitelink,** your assistant replaces it: Google can't edit one in place.",
      "**Edit a responsive search ad in place** (`edit_responsive_search_ad`): change its words or link and it keeps its ID and its stats, instead of starting again as a new ad. Google reviews it again, and undo puts the old text and pins back.",
      "**Negatives at every level:** ad group negatives, so one group stops catching another's searches, and shared negative lists you can create, edit, and put on or take off campaigns.",
      "**`account_overview` now says what needs a look:** ads with policy problems and why, Google's open recommendations, and primary conversions with nothing recorded in 30 days.",
      "**A safer account switch:** `switch_account` waits until you've seen what a switch would lock, and an account your login can't reach no longer uses it up.",
    ],
  },
  {
    version: "0.20.0", date: "2026-10-29",
    summary: "Remove a conversion action, recount a GA4 key event, and track calls from ads.",
    items: [
      "**Remove a conversion action** (`remove_conversion_action`). Google can't restore a removed action, so the summary warns you before you approve and there's no undo, except for one imported from GA4, which undo imports again. Past conversions stay in your reports.",
      "**Recount a GA4 key event** (`set_key_event_counting`): once per event or once per session, with undo. Google Ads won't recount a conversion imported from GA4, so when you ask, your assistant now proposes this instead.",
      "**Count phone calls as conversions:** `create_conversion_action` takes calls from the number in your ads or from a Google forwarding number on your site, counting those that last a minimum length (60 seconds by default).",
      "**A campaign on maximize conversion value can switch bid strategy**, with undo. Before, Camberstack refused because it couldn't put it back.",
      "**Accounts under a manager inside another manager now show up** in `list_accounts`; only the first level was read before.",
      "**Plans:** Pro covers 5 Google Ads accounts, and Agency covers 25. From November 15, Free covers one Google service at a time (Google Ads, Search Console or Google Analytics), and Plus covers all three on one Google Ads account. /plans lists what each includes.",
      "**Clearer answers:** a change that's already in place says so instead of failing; an experiment's trial campaign is named as one; an account you can't reach names the login and how to get access; and more `run_gaql` errors point at the field or filter that works.",
    ],
  },
  {
    version: "0.19.0", date: "2026-10-23",
    summary: "Pick your account first, and an account switch is a question, not an error.",
    items: [
      "**With more Google Ads accounts than your plan covers, your assistant asks which to start on** before using any of them, instead of the plan taking whichever it opened first.",
      "**Asking about a new account on a full plan now answers with what a switch would lock and until when**, as a normal reply rather than an error. Nothing is spent until you agree.",
      "**A clearer fix for change history older than Google allows:** `change_event` reaches back 30 days to the second, so the assistant starts a day inside it.",
    ],
  },
  {
    version: "0.18.0", date: "2026-10-22",
    summary: "Clear Google's EU political ads block from the chat, and fewer failed retries.",
    items: [
      "**Declare whether a campaign contains EU political advertising** (`set_eu_political_advertising`). Google refuses every change to an account while any campaign lacks this declaration; when that happens, your assistant now finds those campaigns, asks you, and proposes the declaration for your approval.",
      "**Repeated ad text is caught before Google sees it:** a headline or description that appears twice in one ad is named, so the assistant fixes the right one first time. Spacing doesn't make two texts different; capitals do.",
      "**Clearer fixes for more Google Ads errors:** `OR` in a query, a segment that can't split cost, and duplicated assets. An error Google repeats for every item is shown once.",
    ],
  },
  {
    version: "0.17.0", date: "2026-10-19",
    summary: "Import a GA4 key event into Google Ads without leaving the chat.",
    items: [
      "**Import a GA4 key event into Google Ads** (`import_ga4_key_event`), so a campaign can count and bid on it, such as a `generate_lead` you just marked as a key event. The GA4 property must be linked to the Ads account. Like every change, it waits for your approval.",
      "**Undo removes the import** (Google can't hide one again; importing again brings it back), and stops bidding on any goals the import turned on. If a campaign bids only on that conversion, undo says to give it another goal first.",
      "**Clearer pointers:** marking a key event says how to import it next, and asking a campaign to bid on a goal the account doesn't have yet explains why.",
    ],
  },
  {
    version: "0.16.0", date: "2026-10-19",
    summary: "Switching accounts is its own step, and ChatGPT gets a tool for each kind of change.",
    items: [
      "**Switching your plan's active account is a separate, explicit step** (`switch_account`). Asking about a new account still stops first and says what the switch would lock and until when; nothing is spent until you agree. A switch is never spent on an account your login can't reach.",
      "**In ChatGPT, every kind of change has its own tool**, such as `propose_pause_campaign`, `propose_set_daily_budget` or `propose_mark_key_event`, plus `propose_undo`. Each still makes a proposal that waits for your approval. In ChatGPT, after updating, refresh the connector to get the new tools. Claude and other apps keep the same tools as before.",
      "**Clearer names for undo and discard:** undo makes a proposal that reverses an applied change, which you approve like any other, and a discarded proposal can't be brought back.",
    ],
  },
  {
    version: "0.15.0", date: "2026-10-17",
    summary: "Google Analytics 4 for everyone.",
    items: [
      "**Google Analytics tools are open to every account.** Google verified Camberstack's Analytics access, so your AI can list your GA4 properties, read reports and landing pages, and check each property's setup. Changes to that setup (a new property, key events, a Google Ads link) still wait for your approval, and each one can be undone.",
      "**Google Analytics is a box on the sign-in screen**, next to Google Ads and Search Console. Any of the three can be unticked and added later through a link Camberstack gives you. Already connected? The first time you ask about Analytics, you get that link; no reconnecting.",
    ],
  },
  {
    version: "0.14.1", date: "2026-10-16",
    summary: "Query-error fixes for the usual slips.",
    items: [
      "**Suggestions for the usual slips are back.** `metrics.cost` points at `metrics.cost_micros`, `keyword_text` at `keyword.text`, `segments.device_type` at `segments.device`, which 0.14.0's stricter matching had dropped.",
      "**A query that forgot its FROM** now says to add one, and a temporary Google error on a field lookup no longer reads as a syntax problem.",
    ],
  },
  {
    version: "0.14.0", date: "2026-10-16",
    summary: "Field lookups inside custom queries, and query errors that name the fix.",
    items: [
      "**Look fields up with `run_gaql`.** A query with no FROM reads Google's field catalog instead of an account: `SELECT name, category WHERE name LIKE '%search_term%'`, or `SELECT attribute_resources, metrics, segments WHERE name = 'campaign'` for what a resource can use. It works in every AI app without refreshing the connector, and doesn't count toward your plan's accounts. (`gaql_fields` keeps working where your app already has it.)",
      "**Query errors name the fix.** A segment the resource has as its own field now points at that field (`campaign_search_term_view.search_term`, not `segments.search_term`); a mistyped field only gets suggestions that are close to it, otherwise the lookup that finds it; and errors never send your AI to a tool its app may not have.",
    ],
  },
  {
    version: "0.13.0", date: "2026-10-16",
    summary: "Price up to 500 keywords at once, and a clear way back in when Google access is revoked.",
    items: [
      "**`keyword_metrics` takes up to 500 keywords** (was 100). Over 100, the result comes back as a compact table, so a big list doesn't fill your AI's context.",
      "**Reconnecting after Google access is revoked.** Camberstack now tells your AI app to sign in again, instead of answering every request with \"reconnect\" while the app still showed it as connected.",
    ],
  },
  {
    version: "0.12.0", date: "2026-10-16",
    summary: "A warning before switching accounts on the Free plan, and approved proposals stay valid until the account changes.",
    items: [
      "**Switching accounts asks first.** The Free plan covers one Google Ads account at a time, with one switch every 30 days. Your AI now tells you which account the switch would lock, and until when, before anything is spent, and you can upgrade to keep both instead.",
      "**Proposals don't expire after 24 hours.** Approving an older proposal now checks whether the account changed since; if nothing did, it applies.",
    ],
  },
  {
    version: "0.11.0", date: "2026-10-14",
    summary: "Shared bid strategies, a field lookup for custom queries, and clearer query errors.",
    items: [
      "**Shared (portfolio) bid strategies.** Move one campaign off a shared strategy onto its own (undo puts it back); change a shared strategy's target CPA, target ROAS or max CPC ceiling, with every campaign it affects named before you approve; or create a new shared strategy and move campaigns onto it in one step (undo moves them back and removes it). Camberstack still never deletes a strategy you built.",
      "**`gaql_fields`**: your AI can look fields up in Google's own field catalog before writing a custom query, instead of guessing names.",
      "**Clearer errors on custom queries.** When Google rejects a query, Camberstack adds what Google's field catalog says: the real fields closest to a mistyped one, and where a field can be queried instead. Plus specific fixes for recommendation impact, Maximize clicks (`target_spend` in the API), and items Google won't let the API change.",
      "**Emails**: a welcome after you connect, and a confirmation when you subscribe to Pro.",
    ],
  },
  { version: "0.10.1", date: "2026-10-12", summary: "The source code moved to github.com/zwznco/camberstack-mcp. No changes to how Camberstack works." },
  {
    version: "0.10.0", date: "2026-10-12",
    summary: "Three more campaign types, each proposed, approved, then created paused.",
    items: [
      "**Performance Max**: asset groups of headlines, descriptions, images and YouTube videos, with your business name and logo.",
      "**Display**: responsive display ads from image URLs or images already in your account.",
      "**YouTube**, through Demand Gen video campaigns (Google's API doesn't allow creating Video campaigns).",
      "Clearer fixes for ad policy rejections, wrong image sizes and common query mistakes.",
    ],
  },
  { version: "0.9.0", date: "2026-10-09", summary: "Supports the newest version of the MCP protocol, alongside the previous one. Nothing changes for you." },
  { version: "0.8.0", date: "2026-10-06", summary: "Search Console: what's rising and falling, near-page-one opportunities, whether Google has indexed a page and why not, and when it last read your sitemaps." },
  { version: "0.7.0", date: "2026-10-06", summary: "Search Console, read-only and optional: your sites, their search totals, queries and pages, and searches you pay for that already rank organically." },
  { version: "0.6.0", date: "2026-10-04", summary: "Tuning: keyword and ad group bids, pausing and enabling ads, locations and languages, bid strategy, URL tracking suffix, and conversion actions." },
  { version: "0.5.0", date: "2026-10-04", summary: "Campaign building: a whole Search campaign with ad groups, keywords, ads and sitelinks, created paused; plus adding ad groups, keywords and ads to existing ones." },
  { version: "0.4.0", date: "2026-10-02", summary: "Set a campaign's end date. Turning a campaign on now warns with the budget it will spend." },
  { version: "0.3.0", date: "2026-10-02", summary: "Plans count Google Ads accounts: Free covers one, Pro up to ten." },
  { version: "0.2.0", date: "2026-10-02", summary: "Keyword Planner: keyword ideas, and search volume and bids for your own list." },
  { version: "0.1.0", date: "2026-09-29", summary: "First release: read your Google Ads account, and make changes you approve one proposal at a time, each with an undo." },
];

/** A release's notes as Markdown, for its GitHub release. */
export function releaseNotes(version: string): string {
  const r = CHANGELOG.find((x) => x.version === version);
  if (!r) throw new Error(`No changelog entry for ${version}`);
  return [r.summary, ...(r.items?.length ? [r.items.map((i) => `- ${i}`).join("\n")] : []), "Full history: https://camberstack.io/changelog"].join("\n\n");
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(releaseNotes(process.argv[2] ?? CHANGELOG[0]!.version));
