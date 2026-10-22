/**
 * The only way this service writes to a Google Ads account.
 *
 *   propose  → resolve every change against the live account, dry-run it with validateOnly, store
 *              it with a plain-English diff. Nothing is written.
 *   apply    → only a stored, un-applied proposal belonging to this user, and only if, re-resolved against
 *              the account now, it still reads as the summary the user approved (else it is proposed afresh).
 *              Each change records its inverse, so any applied proposal can be undone.
 *
 * Surface: negatives, pause/enable keyword, ad group or campaign, daily budget, campaign end date, and
 * building: a whole Search, Display, Demand Gen or Performance Max campaign (always created PAUSED, so
 * building and spending are two separate approvals), ad groups, keywords, responsive search ads,
 * sitelinks, which conversion category a campaign bids on, a campaign's EU political advertising declaration, a campaign's bid strategy (including moving it off a shared one),
 * a shared (portfolio) strategy's targets, and creating a shared strategy (undo moves its campaigns back, then removes it). YouTube is Demand Gen with video ads: the
 * API refuses to create VIDEO campaigns (MUTATE_NOT_ALLOWED, checked against v23 on 2026-10-12). Nothing
 * a user built is ever deleted: the only removals are undos of things this service created.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { fetchImage } from "./fetch-safe.js";
import { micros, toMicros, type AdsClient } from "./google.js";

export const MAX_CHANGES = 50;

const id = z.string().regex(/^\d+$/, "numeric id");
const campaignId = id.describe("Campaign id, digits only (campaign_id from account_overview or run_gaql)");
const adGroupId = id.describe("Ad group id, digits only (ad_group.id from run_gaql)");
const criterionId = id.describe("Keyword criterion id, digits only (ad_group_criterion.criterion_id from run_gaql)");
const matchType = z.enum(["EXACT", "PHRASE", "BROAD"]);
const bid = z.number().positive().max(1000);
const url = z.string().url().regex(/^https?:\/\//, "http(s) URL").max(2048);
/**
 * Ad texts, refused when two would be the same asset to Google (DUPLICATE_ASSET). It compares them with spacing trimmed
 * and collapsed, but not case: "Free Trial" and "free trial" are both accepted (dry-run against v23, 2026-10-22).
 * Checked here so the AI hears which text repeats; Google only names the field, and retries made it worse.
 */
const distinctTexts = <T extends z.ZodArray<z.ZodString>>(xs: T) => xs.superRefine((texts, ctx) => {
  const seen = new Set<string>();
  for (const t of texts) {
    const key = t.trim().replace(/\s+/g, " ");
    if (seen.has(key)) ctx.addIssue({ code: "custom", message: `"${key}" is in this list twice. Google refuses repeated text in one ad (spacing doesn't make it different; capitals do): make every entry different` });
    seen.add(key);
  }
});

const keywordSpec = z.object({
  text: z.string().min(1).max(80).describe("The keyword, e.g. \"cleaning invoice template\""),
  match_type: matchType.describe("PHRASE matches searches containing the words in order; the usual choice"),
  max_cpc: bid.optional().describe("Max cost per click for this keyword in the account's currency (manual CPC only); omit to use the ad group's"),
});
const adSpec = z.object({
  headlines: distinctTexts(z.array(z.string().min(1).max(30)).min(3).max(15).describe("3 to 15 headlines, each at most 30 characters")),
  descriptions: distinctTexts(z.array(z.string().min(1).max(90)).min(2).max(4).describe("2 to 4 descriptions, each at most 90 characters")),
  final_url: url.describe("The landing page"),
  path1: z.string().min(1).max(15).optional().describe("Display path part 1, at most 15 characters"),
  path2: z.string().min(1).max(15).optional().describe("Display path part 2, at most 15 characters"),
}).describe("A responsive search ad");
const adGroupSpec = z.object({
  name: z.string().min(1).max(255),
  default_max_cpc: bid.optional().describe("Default max cost per click for the ad group (required when the campaign uses manual CPC)"),
  keywords: z.array(keywordSpec).min(1).max(50),
  ads: z.array(adSpec).min(1).max(3),
});
const sitelinkSpec = z.object({
  text: z.string().min(1).max(25).describe("Link text, at most 25 characters"),
  url,
  description1: z.string().min(1).max(35).optional().describe("At most 35 characters; give both descriptions or neither"),
  description2: z.string().min(1).max(35).optional(),
});
const negativeSpec = z.object({ text: z.string().min(1).max(80), match_type: matchType });

// Display and Demand Gen ads are built from uploaded images. An image is either a public https URL
// (fetched, checked and uploaded as a new image asset) or an image asset already in the account.
const image = z.string().min(1).max(2048)
  .describe("An https URL of a PNG, JPEG or GIF (at most 5120 KB), or the id of an image asset already in the account (asset.id from run_gaql WHERE asset.type = 'IMAGE')");
const images = (what: string, min: number, max: number) => z.array(image).min(min).max(max).describe(what);
const displayAdSpec = z.object({
  headlines: distinctTexts(z.array(z.string().min(1).max(30)).min(1).max(5).describe("1 to 5 short headlines, each at most 30 characters")),
  long_headline: z.string().min(1).max(90).describe("One long headline, at most 90 characters"),
  descriptions: distinctTexts(z.array(z.string().min(1).max(90)).min(1).max(5).describe("1 to 5 descriptions, each at most 90 characters")),
  business_name: z.string().min(1).max(25).describe("The advertiser's name, at most 25 characters"),
  final_url: url.describe("The landing page"),
  marketing_images: images("1 to 15 landscape images, 1.91:1 (e.g. 1200×628, at least 600×314)", 1, 15),
  square_marketing_images: images("1 to 15 square images, 1:1 (e.g. 1200×1200, at least 300×300)", 1, 15),
  square_logo_images: images("0 to 5 square logos, 1:1 (e.g. 1200×1200, at least 128×128)", 0, 5).default([]),
  logo_images: images("0 to 5 landscape logos, 4:1 (e.g. 1200×300, at least 512×128)", 0, 5).default([]),
}).describe("A responsive display ad: Google assembles ads from these headlines, descriptions and images");
const displayAdGroupSpec = z.object({
  name: z.string().min(1).max(255),
  default_max_cpc: bid.optional().describe("Default max cost per click (required when the campaign uses manual CPC)"),
  ads: z.array(displayAdSpec).min(1).max(3),
});
const youtubeVideo = z.string().min(1).max(200)
  .describe("A YouTube video id (e.g. dQw4w9WgXcQ) or its youtube.com / youtu.be URL. The video must be public or unlisted");
const demandGenVideoAdSpec = z.object({
  videos: z.array(youtubeVideo).min(1).max(5).describe("1 to 5 YouTube videos"),
  headlines: distinctTexts(z.array(z.string().min(1).max(40)).min(1).max(5).describe("1 to 5 headlines, each at most 40 characters")),
  long_headlines: distinctTexts(z.array(z.string().min(1).max(90)).min(1).max(5).describe("1 to 5 long headlines, each at most 90 characters")),
  descriptions: distinctTexts(z.array(z.string().min(1).max(90)).min(1).max(5).describe("1 to 5 descriptions, each at most 90 characters")),
  business_name: z.string().min(1).max(25).describe("The advertiser's name, at most 25 characters"),
  logo_image: image.describe("A square 1:1 logo (e.g. 1200×1200, at least 128×128): an https URL, or an image asset id from the account"),
  final_url: url.describe("The landing page"),
}).describe("A Demand Gen video ad: runs on YouTube (in-stream, in-feed and Shorts), Discover and Gmail");
const demandGenAdGroupSpec = z.object({
  name: z.string().min(1).max(255),
  location_ids: z.array(id).min(1).max(50).default(["2840"])
    .describe("Google geo target ids, e.g. 2840 United States (Demand Gen targets locations per ad group, not per campaign)"),
  language_ids: z.array(id).min(1).max(20).default(["1000"]).describe("Google language ids, e.g. 1000 English"),
  ads: z.array(demandGenVideoAdSpec).min(1).max(3),
});
const assetGroupSpec = z.object({
  name: z.string().min(1).max(255),
  final_url: url.describe("The landing page (Google may also send people to other pages on the same site)"),
  headlines: distinctTexts(z.array(z.string().min(1).max(30)).min(3).max(15).describe("3 to 15 headlines, each at most 30 characters")),
  long_headlines: distinctTexts(z.array(z.string().min(1).max(90)).min(1).max(5).describe("1 to 5 long headlines, each at most 90 characters")),
  descriptions: distinctTexts(z.array(z.string().min(1).max(90)).min(2).max(5).describe("2 to 5 descriptions, each at most 90 characters; Google recommends one of 60 or fewer")),
  marketing_images: images("1 to 20 landscape images, 1.91:1 (e.g. 1200×628)", 1, 20),
  square_marketing_images: images("1 to 20 square images, 1:1 (e.g. 1200×1200)", 1, 20),
  portrait_marketing_images: images("0 to 20 portrait images, 4:5 (e.g. 960×1200)", 0, 20).default([]),
  videos: z.array(youtubeVideo).max(5).default([]).describe("0 to 5 YouTube videos; without one, Google may auto-generate a video from the images"),
}).describe("An asset group: the headlines, descriptions, images and videos Google combines into ads on every channel");
const shared = {
  name: z.string().min(1).max(255).describe("Campaign name; must not match an existing campaign"),
  daily_budget: z.number().positive().max(1_000_000).describe("Average daily budget in the account's currency, e.g. 20 for $20.00/day"),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").optional().describe("Last day the campaign runs, YYYY-MM-DD"),
};
const goalCategory = z.string().regex(/^[A-Z_]+$/, "a conversion category such as SIGNUP")
  .describe("Conversion category, e.g. SIGNUP, PURCHASE, SUBMIT_LEAD_FORM, QUALIFIED_LEAD (see conversion_action.category in run_gaql)");

/**
 * What the AI may propose. Every field is described so a model can fill it without guessing where an
 * id comes from or what unit an amount is in (ChatGPT took ~2 minutes to work out a budget change
 * before these existed).
 */
export const PUBLIC_CHANGES = [
  z.object({
    type: z.literal("add_negative_keywords"),
    campaign_id: campaignId,
    keywords: z.array(z.object({
      text: z.string().min(1).max(80).describe('The search words to block, e.g. "free"'),
      match_type: z.enum(["EXACT", "PHRASE", "BROAD"]).describe("PHRASE blocks any search containing the words in order; the usual choice"),
    })).min(1).max(MAX_CHANGES),
  }).describe("Block searches containing these words in one campaign"),
  z.object({ type: z.literal("pause_keyword"), ad_group_id: adGroupId, criterion_id: criterionId }).describe("Pause one keyword"),
  z.object({ type: z.literal("enable_keyword"), ad_group_id: adGroupId, criterion_id: criterionId }).describe("Re-enable one paused keyword"),
  z.object({ type: z.literal("pause_campaign"), campaign_id: campaignId }).describe("Pause a whole campaign (stops all its spend)"),
  z.object({ type: z.literal("enable_campaign"), campaign_id: campaignId })
    .describe("Turn a paused campaign back on. It starts spending again; the summary says how much"),
  z.object({ type: z.literal("pause_ad_group"), ad_group_id: adGroupId }).describe("Pause one ad group"),
  z.object({ type: z.literal("enable_ad_group"), ad_group_id: adGroupId }).describe("Re-enable one paused ad group"),
  z.object({
    type: z.literal("set_daily_budget"),
    campaign_id: campaignId,
    amount: z.number().positive().max(1_000_000)
      .describe("New average daily budget in the account's currency, e.g. 10 for $10.00/day (not micros)"),
  }).describe("Change a campaign's daily budget (not shared budgets)"),
  z.object({
    type: z.literal("set_end_date"),
    campaign_id: campaignId,
    end_date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"), z.literal("none")])
      .describe('Last day the campaign runs, YYYY-MM-DD in the account\'s time zone (it stops after 23:59:59 that day), or "none" to remove the end date'),
  }).describe("Set the last day a campaign runs, so it stops spending on its own"),
  z.object({
    type: z.literal("create_campaign"),
    name: z.string().min(1).max(255).describe("Campaign name; must not match an existing campaign"),
    daily_budget: z.number().positive().max(1_000_000).describe("Average daily budget in the account's currency, e.g. 20 for $20.00/day"),
    bidding: z.enum(["MANUAL_CPC", "MAXIMIZE_CLICKS", "MAXIMIZE_CONVERSIONS"]).default("MANUAL_CPC")
      .describe("MANUAL_CPC uses the ad group and keyword max CPCs; MAXIMIZE_CLICKS and MAXIMIZE_CONVERSIONS let Google bid within the budget"),
    max_cpc_ceiling: bid.optional().describe("MAXIMIZE_CLICKS only: the most Google may bid per click"),
    location_ids: z.array(id).min(1).max(50).default(["2840"])
      .describe("Google geo target ids, e.g. 2840 United States, 2826 United Kingdom, 2124 Canada (look others up in geo_target_constant)"),
    language_ids: z.array(id).min(1).max(20).default(["1000"]).describe("Google language ids, e.g. 1000 English, 1003 Spanish"),
    presence_only: z.boolean().default(true).describe("Show ads only to people IN the locations (true), not merely interested in them"),
    search_partners: z.boolean().default(false).describe("Also show on Google's search partner sites"),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").optional().describe("Last day the campaign runs, YYYY-MM-DD"),
    negative_keywords: z.array(negativeSpec).max(200).default([]).describe("Searches to block across the campaign"),
    sitelinks: z.array(sitelinkSpec).max(8).default([]),
    ad_groups: z.array(adGroupSpec).min(1).max(10),
  }).describe("Build a new Search campaign with its ad groups, keywords, ads, targeting, negatives and sitelinks, in one step. It is created PAUSED: nothing spends until a separate enable_campaign"),
  z.object({
    type: z.literal("create_display_campaign"),
    ...shared,
    bidding: z.enum(["MANUAL_CPC", "MAXIMIZE_CLICKS", "MAXIMIZE_CONVERSIONS"]).default("MAXIMIZE_CLICKS")
      .describe("MANUAL_CPC uses the ad groups' max CPCs; MAXIMIZE_CLICKS and MAXIMIZE_CONVERSIONS let Google bid within the budget"),
    max_cpc_ceiling: bid.optional().describe("MAXIMIZE_CLICKS only: the most Google may bid per click"),
    location_ids: z.array(id).min(1).max(50).default(["2840"]).describe("Google geo target ids, e.g. 2840 United States"),
    language_ids: z.array(id).min(1).max(20).default(["1000"]).describe("Google language ids, e.g. 1000 English"),
    presence_only: z.boolean().default(true).describe("Show ads only to people IN the locations (true), not merely interested in them"),
    ad_groups: z.array(displayAdGroupSpec).min(1).max(5),
  }).describe("Build a new Display campaign (image ads across Google's Display Network of sites and apps) with ad groups and responsive display ads. Google's optimized targeting finds the audience. It is created PAUSED: nothing spends until a separate enable_campaign"),
  z.object({
    type: z.literal("create_demand_gen_campaign"),
    ...shared,
    bidding: z.enum(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CLICKS"]).default("MAXIMIZE_CONVERSIONS")
      .describe("Demand Gen bids automatically: MAXIMIZE_CONVERSIONS (needs conversion tracking) or MAXIMIZE_CLICKS"),
    ad_groups: z.array(demandGenAdGroupSpec).min(1).max(5),
  }).describe("Build a new Demand Gen campaign with YouTube video ads, which is how to advertise on YouTube through the API (Google doesn't allow creating Video campaigns there). It is created PAUSED: nothing spends until a separate enable_campaign"),
  z.object({
    type: z.literal("create_performance_max_campaign"),
    ...shared,
    bidding: z.enum(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]).default("MAXIMIZE_CONVERSIONS")
      .describe("Performance Max bids for conversions only: MAXIMIZE_CONVERSIONS, or MAXIMIZE_CONVERSION_VALUE when conversions carry values"),
    target_cpa: bid.optional().describe("MAXIMIZE_CONVERSIONS only: target cost per conversion"),
    location_ids: z.array(id).min(1).max(50).default(["2840"]).describe("Google geo target ids, e.g. 2840 United States"),
    language_ids: z.array(id).min(1).max(20).default(["1000"]).describe("Google language ids, e.g. 1000 English"),
    business_name: z.string().min(1).max(25).describe("The advertiser's name, at most 25 characters (linked to the campaign, per Google's brand guidelines)"),
    logo_images: images("1 to 5 square logos, 1:1 (e.g. 1200×1200, at least 128×128), linked to the campaign", 1, 5),
    asset_groups: z.array(assetGroupSpec).min(1).max(5),
  }).describe("Build a new Performance Max campaign: one budget, Google places ads across Search, YouTube, Display, Discover, Gmail and Maps from the asset groups' text, images and videos. No shopping feed (non-retail). It is created PAUSED: nothing spends until a separate enable_campaign"),
  z.object({ type: z.literal("add_ad_group"), campaign_id: campaignId, ad_group: adGroupSpec })
    .describe("Add an ad group, with its keywords and ads, to an existing Search campaign"),
  z.object({ type: z.literal("add_keywords"), ad_group_id: adGroupId, keywords: z.array(keywordSpec).min(1).max(MAX_CHANGES) })
    .describe("Add keywords to an existing ad group"),
  z.object({ type: z.literal("add_responsive_search_ad"), ad_group_id: adGroupId, ad: adSpec })
    .describe("Add a responsive search ad to an existing ad group"),
  z.object({ type: z.literal("add_sitelinks"), campaign_id: campaignId, sitelinks: z.array(sitelinkSpec).min(1).max(8) })
    .describe("Add sitelinks to a campaign"),
  z.object({ type: z.literal("set_conversion_goal"), campaign_id: campaignId, category: goalCategory })
    .describe("Make a campaign count and bid on ONE conversion category only (e.g. SIGNUP), so another product's or step's conversions don't steer it"),
  z.object({ type: z.literal("set_keyword_bid"), ad_group_id: adGroupId, criterion_id: criterionId,
    max_cpc: bid.nullable().describe("New max cost per click for this keyword, or null to clear it so the keyword uses the ad group's bid") })
    .describe("Change one keyword's max CPC (manual CPC campaigns)"),
  z.object({ type: z.literal("set_ad_group_bid"), ad_group_id: adGroupId, max_cpc: bid.describe("New default max cost per click for the ad group") })
    .describe("Change an ad group's default max CPC, which its keywords use unless they have their own"),
  z.object({ type: z.literal("pause_ad"), ad_group_id: adGroupId, ad_id: id.describe("Ad id, digits only (ad_group_ad.ad.id from run_gaql)") }).describe("Pause one ad"),
  z.object({ type: z.literal("enable_ad"), ad_group_id: adGroupId, ad_id: id.describe("Ad id, digits only (ad_group_ad.ad.id from run_gaql)") }).describe("Re-enable one paused ad"),
  z.object({ type: z.literal("add_campaign_targeting"), campaign_id: campaignId,
    location_ids: z.array(id).max(50).default([]).describe("Geo target ids to add, e.g. 2840 United States"),
    language_ids: z.array(id).max(20).default([]).describe("Language ids to add, e.g. 1000 English") })
    .describe("Add locations and/or languages a campaign targets"),
  z.object({ type: z.literal("remove_campaign_targeting"), campaign_id: campaignId,
    location_ids: z.array(id).max(50).default([]), language_ids: z.array(id).max(20).default([]) })
    .describe("Stop targeting some of a campaign's locations and/or languages"),
  z.object({ type: z.literal("set_location_mode"), campaign_id: campaignId,
    presence_only: z.boolean().describe("true: only people IN the locations; false: also people interested in them") })
    .describe("Choose whether a campaign shows to people in its locations only, or also to people interested in them"),
  z.object({ type: z.literal("set_bidding_strategy"), campaign_id: campaignId,
    strategy: z.enum(["MANUAL_CPC", "MAXIMIZE_CLICKS", "MAXIMIZE_CONVERSIONS"]),
    max_cpc_ceiling: bid.optional().describe("MAXIMIZE_CLICKS only: the most Google may bid per click"),
    target_cpa: bid.optional().describe("MAXIMIZE_CONVERSIONS only: target cost per conversion") })
    .describe("Switch ONE campaign's bid strategy. A campaign on a shared (portfolio) strategy moves off it onto its own; the other campaigns "
      + "on the shared strategy keep it. To change the shared strategy for every campaign on it, use set_shared_bid_strategy. If the user "
      + "didn't say which they mean, ask. Google re-learns after a switch, so performance can wobble for a week or two"),
  z.object({ type: z.literal("set_shared_bid_strategy"),
    bidding_strategy_id: id.describe("Shared (portfolio) strategy id: bidding_strategy.id from run_gaql, or the id at the end of campaign.bidding_strategy"),
    target_cpa: bid.optional().describe("Target cost per conversion (TARGET_CPA and MAXIMIZE_CONVERSIONS strategies)"),
    target_roas: z.number().positive().max(1000).optional().describe("Target return on ad spend as a ratio, e.g. 4 = 400% (TARGET_ROAS and MAXIMIZE_CONVERSION_VALUE)"),
    max_cpc_ceiling: bid.optional().describe("The most Google may bid per click") })
    .describe("Change a shared (portfolio) bid strategy's targets. This changes EVERY campaign on it, which the proposal lists. "
      + "Its type can't be changed; to move one campaign to another strategy, use set_bidding_strategy"),
  z.object({ type: z.literal("create_shared_bid_strategy"),
    name: z.string().min(1).max(255).describe("Name for the shared strategy; must not match an existing one"),
    strategy: z.enum(["MAXIMIZE_CLICKS", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_CPA", "TARGET_ROAS"]),
    target_cpa: bid.optional().describe("Target cost per conversion: required for TARGET_CPA, optional for MAXIMIZE_CONVERSIONS"),
    target_roas: z.number().positive().max(1000).optional().describe("Target return on ad spend as a ratio, e.g. 4 = 400%: required for TARGET_ROAS, optional for MAXIMIZE_CONVERSION_VALUE"),
    max_cpc_ceiling: bid.optional().describe("The most Google may bid per click"),
    campaign_ids: z.array(id).max(50).default([]).describe("Campaigns to move onto it in the same step (each leaves its current strategy)") })
    .describe("Create a shared (portfolio) bid strategy, optionally moving campaigns onto it. Undo moves those campaigns back and removes it"),
  z.object({ type: z.literal("set_url_suffix"), campaign_id: campaignId,
    suffix: z.string().max(1000).describe('Query string Google appends to every landing page in the campaign, e.g. "utm_source=google&utm_medium=cpc&utm_term={keyword}", or "none" to clear it') })
    .describe("Set or clear a campaign's final URL suffix (tracking parameters on every ad click)"),
  z.object({ type: z.literal("set_eu_political_advertising"), campaign_id: campaignId,
    contains_eu_political_advertising: z.boolean()
      .describe("The user's answer: true only if the campaign carries political ads under EU rules (about an election, a referendum, or a law or regulation, shown in the EU)") })
    .describe("Declare whether a campaign contains EU political advertising. While any campaign lacks this declaration, Google refuses every change "
      + "to the account (EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED); find those campaigns with campaign.missing_eu_political_advertising_declaration = TRUE. "
      + "It is the advertiser's own legal statement: ask the user, never assume the answer"),
  z.object({ type: z.literal("create_conversion_action"),
    name: z.string().min(1).max(100),
    category: goalCategory,
    source: z.enum(["UPLOAD_CLICKS", "WEBPAGE"]).default("UPLOAD_CLICKS")
      .describe("UPLOAD_CLICKS: your server uploads ad click ids (no Google tag). WEBPAGE: Google gives you a tag to put on the page"),
    counting: z.enum(["ONE_PER_CLICK", "MANY_PER_CLICK"]).default("ONE_PER_CLICK").describe("ONE_PER_CLICK for sign-ups and leads; MANY_PER_CLICK for purchases"),
    primary: z.boolean().default(true).describe("Primary actions count in Conversions and can steer bidding"),
    default_value: z.number().min(0).max(1_000_000).optional().describe("Value per conversion when none is sent"),
  }).describe("Create a conversion action to measure sign-ups, leads or purchases"),
  z.object({ type: z.literal("set_conversion_counting"), conversion_action_id: id.describe("conversion_action.id from run_gaql"),
    counting: z.enum(["ONE_PER_CLICK", "MANY_PER_CLICK"]) })
    .describe("Set how many conversions one ad click can produce for a conversion action"),
  z.object({ type: z.literal("import_ga4_key_event"), property_id: id.describe("GA4 property id (from analytics_properties)"),
    event_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/).describe("The GA4 key event, e.g. generate_lead, purchase, sign_up"),
    primary: z.boolean().default(true).describe("Primary actions count in Conversions and can steer bidding") })
    .describe("Import a GA4 key event into Google Ads as a conversion action, so campaigns can count and bid on it. The GA4 property must be linked to this account"),
] as const;

/** For propose_changes' input: what the AI sees. */
export const PublicChangeSchema = z.discriminatedUnion("type", [...PUBLIC_CHANGES]);

/** Everything the server accepts, including the change only undo creates. */
export const ChangeSchema = z.discriminatedUnion("type", [
  ...PUBLIC_CHANGES,
  // Used only by undo: remove what this service created, or restore what it replaced. Not offered to the AI.
  z.object({ type: z.literal("remove_negative_keywords"), campaign_id: id, resource_names: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("remove_campaign"), resource_name: z.string(), name: z.string() }),
  z.object({ type: z.literal("remove_ad_group"), resource_name: z.string(), name: z.string() }),
  z.object({ type: z.literal("remove_keywords"), resource_names: z.array(z.string()).min(1), what: z.string() }),
  z.object({ type: z.literal("remove_ad"), resource_name: z.string(), what: z.string() }),
  z.object({ type: z.literal("remove_campaign_assets"), resource_names: z.array(z.string()).min(1), what: z.string() }),
  z.object({ type: z.literal("restore_bidding"), campaign_id: id, bidding: z.record(z.string(), z.any()), mask: z.string(), label: z.string() }),
  z.object({ type: z.literal("remove_shared_bid_strategy"), resource_name: z.string(), name: z.string(),
    restore: z.array(z.object({ campaign_id: id, name: z.string(), bidding: z.record(z.string(), z.any()), mask: z.string(), label: z.string() })).default([]) }),
  z.object({ type: z.literal("restore_shared_bid_strategy"), bidding_strategy_id: id, fields: z.record(z.string(), z.any()), mask: z.string(), label: z.string() }),
  z.object({ type: z.literal("remove_campaign_criteria"), campaign_id: id, resource_names: z.array(z.string()).min(1), what: z.string() }),
  z.object({ type: z.literal("remove_conversion_action"), resource_name: z.string(), name: z.string() }),
  z.object({ type: z.literal("remove_imported_conversion_action"), resource_name: z.string(), name: z.string(), property_id: id, event_name: z.string(), primary: z.boolean(),
    category: z.string(), biddable_before: z.array(z.string()) }),
  z.object({ type: z.literal("restore_conversion_goals"), campaign_id: id, goals: z.array(z.object({ resource_name: z.string(), biddable: z.boolean() })).min(1) }),
]);
export type Change = z.infer<typeof ChangeSchema>;

/** A change resolved against the account: the exact API operation plus what it looked like before. */
export interface ResolvedChange {
  change: Change;
  /** "googleAds" = the cross-service atomic mutate, whose operations are MutateOperations. */
  service: "campaignCriteria" | "adGroupCriteria" | "adGroups" | "campaignBudgets" | "campaigns" | "adGroupAds"
    | "campaignConversionGoals" | "conversionActions" | "biddingStrategies" | "googleAds";
  operations: object[];
  describe: string;
  /** Filled at resolve time when the inverse is knowable up front (pause/enable/budget). */
  inverse?: Change;
}


/** One conversion category's goals: the account default (no campaign) and each live campaign's. */
async function goalsOf(q: (gaql: string) => Promise<any[]>, category: string) {
  const cat = gaqlStr(category);
  const [acct, camps] = await Promise.all([
    q(`SELECT customer_conversion_goal.resource_name, customer_conversion_goal.biddable FROM customer_conversion_goal WHERE customer_conversion_goal.category = '${cat}'`),
    q(`SELECT campaign.name, campaign.status, campaign_conversion_goal.resource_name, campaign_conversion_goal.biddable FROM campaign_conversion_goal
      WHERE campaign_conversion_goal.category = '${cat}'`)]);
  return [
    ...acct.map((r) => ({ resourceName: r.customerConversionGoal.resourceName as string, biddable: !!r.customerConversionGoal.biddable, campaign: undefined as string | undefined })),
    ...camps.filter((r) => r.campaign.status !== "REMOVED")
      .map((r) => ({ resourceName: r.campaignConversionGoal.resourceName as string, biddable: !!r.campaignConversionGoal.biddable, campaign: r.campaign.name as string })),
  ];
}

const EU_POLITICAL = "CONTAINS_EU_POLITICAL_ADVERTISING", NO_EU_POLITICAL = "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING";

/** Google's stand-in for "no end date". */
const NO_END_DATE_TIME = "2037-12-30 23:59:59";

/** A campaign's end date as YYYY-MM-DD, or "none". */
function endDateOf(endDateTime: string | undefined): string {
  return !endDateTime || endDateTime.startsWith("2037-12-30") ? "none" : endDateTime.slice(0, 10);
}

/**
 * Budgets and end dates a proposal sets for its own campaigns, keyed by campaign id. Each change is
 * resolved against the live account, so without this an "enable campaign" next to a budget change
 * warned about the old budget.
 */
export interface Pending { budgets: Map<string, number>; endDates: Map<string, string> }

export function pendingOf(changes: Change[]): Pending {
  const p: Pending = { budgets: new Map(), endDates: new Map() };
  for (const c of changes) {
    if (c.type === "set_daily_budget") p.budgets.set(c.campaign_id, c.amount);
    if (c.type === "set_end_date") p.endDates.set(c.campaign_id, c.end_date);
  }
  return p;
}

export async function resolveChange(
  ads: Pick<AdsClient, "search">, customerId: string, login: string | null, change: Change,
  pending: Pending = pendingOf([]),
): Promise<ResolvedChange> {
  const q = (query: string) => ads.search(customerId, query, login);
  switch (change.type) {
    case "add_negative_keywords": {
      const [c] = await q(`SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.status
        FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found in account ${customerId}`);
      const existing = await q(`SELECT campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
        FROM campaign_criterion WHERE campaign.id = ${change.campaign_id}
        AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = true`);
      const have = new Set(existing.map((r) =>
        `${String(r.campaignCriterion?.keyword?.text ?? "").toLowerCase()}|${r.campaignCriterion?.keyword?.matchType}`));
      const fresh = change.keywords.filter((k) => isNew(have, `${k.text.toLowerCase()}|${k.match_type}`));
      const skipped = change.keywords.length - fresh.length;
      const campaign = `customers/${customerId}/campaigns/${change.campaign_id}`;
      return {
        change: { ...change, keywords: fresh },
        service: "campaignCriteria",
        operations: fresh.map((k) => ({
          create: { campaign, negative: true, keyword: { text: k.text, matchType: k.match_type } },
        })),
        describe: `Add ${fresh.length} negative keyword(s) to campaign "${c.campaign.name}": ` +
          fresh.map((k) => fmtKw(k.text, k.match_type)).join(", ") +
          (skipped ? ` (${skipped} already present or repeated, skipped)` : ""),
      };
    }
    case "pause_keyword":
    case "enable_keyword": {
      const [k] = await q(`SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
          ad_group_criterion.status, ad_group.name, campaign.name
        FROM ad_group_criterion WHERE ad_group.id = ${change.ad_group_id}
        AND ad_group_criterion.criterion_id = ${change.criterion_id}`);
      if (!k) throw new Error(`Keyword ${change.criterion_id} not found in ad group ${change.ad_group_id}`);
      const { ad_group_id, criterion_id } = change;
      return toggle(change, "pause_keyword", "enable_keyword", (type) => ({ type, ad_group_id, criterion_id }), {
        service: "adGroupCriteria", before: k.adGroupCriterion.status,
        resourceName: `customers/${customerId}/adGroupCriteria/${ad_group_id}~${criterion_id}`,
        what: `keyword ${fmtKw(k.adGroupCriterion.keyword.text, k.adGroupCriterion.keyword.matchType)} in ad group "${k.adGroup.name}"`,
        context: `campaign "${k.campaign.name}"`,
      });
    }
    case "pause_campaign":
    case "enable_campaign": {
      const [c] = await q(`SELECT campaign.name, campaign.status, campaign.end_date_time, campaign_budget.amount_micros,
          campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      const before = c.campaign.status as string;
      if (before === "REMOVED") throw new Error(`Campaign "${c.campaign.name}" was removed in Google Ads and can't be changed.`);
      // Turning a campaign on is the one change that takes spend from zero to real money: say so in the
      // summary, with the budget and end date it will run under once this proposal is applied.
      const budget = pending.budgets.get(change.campaign_id) ?? micros(c.campaignBudget?.amountMicros);
      const end = pending.endDates.get(change.campaign_id) ?? endDateOf(c.campaign.endDateTime);
      const warn = change.type === "enable_campaign" && before !== "ENABLED"
        ? ` ⚠ it starts spending again, up to an average of ${budget.toFixed(2)}/day` +
          `${c.campaignBudget?.explicitlyShared ? " from a shared budget" : ""}${end === "none" ? "" : ` until ${end}`}`
        : "";
      const { campaign_id } = change;
      return toggle(change, "pause_campaign", "enable_campaign", (type) => ({ type, campaign_id }), {
        service: "campaigns", before, resourceName: `customers/${customerId}/campaigns/${campaign_id}`,
        what: `campaign "${c.campaign.name}"`, warn,
      });
    }
    case "pause_ad_group":
    case "enable_ad_group": {
      const [g] = await q(`SELECT ad_group.name, ad_group.status, campaign.name FROM ad_group WHERE ad_group.id = ${change.ad_group_id}`);
      if (!g) throw new Error(`Ad group ${change.ad_group_id} not found`);
      const { ad_group_id } = change;
      return toggle(change, "pause_ad_group", "enable_ad_group", (type) => ({ type, ad_group_id }), {
        service: "adGroups", before: g.adGroup.status, resourceName: `customers/${customerId}/adGroups/${ad_group_id}`,
        what: `ad group "${g.adGroup.name}"`, context: `campaign "${g.campaign.name}"`,
      });
    }
    case "set_daily_budget": {
      const [c] = await q(`SELECT campaign.name, campaign_budget.resource_name, campaign_budget.amount_micros,
          campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      if (c.campaignBudget.explicitlyShared) {
        throw new Error(`Campaign "${c.campaign.name}" uses a shared budget; changing it would change every campaign on it. Edit it in Google Ads instead.`);
      }
      const before = micros(c.campaignBudget.amountMicros);
      const same = before === change.amount;
      return {
        change,
        service: "campaignBudgets",
        operations: same ? [] : [{ update: { resourceName: c.campaignBudget.resourceName, amountMicros: toMicros(change.amount) }, updateMask: "amount_micros" }],
        describe: `Set daily budget of campaign "${c.campaign.name}" from ${before.toFixed(2)} to ${change.amount.toFixed(2)}` +
          (before > 0 && change.amount > before * 2 ? ` ⚠ ${(change.amount / before).toFixed(1)}× the current budget` : ""),
        inverse: same ? undefined : { type: "set_daily_budget", campaign_id: change.campaign_id, amount: before },
      };
    }
    case "set_end_date": {
      const [c] = await q(`SELECT campaign.name, campaign.status, campaign.end_date_time FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      if (c.campaign.status === "REMOVED") throw new Error(`Campaign "${c.campaign.name}" was removed in Google Ads and can't be changed.`);
      const before = endDateOf(c.campaign.endDateTime);
      const label = (d: string) => (d === "none" ? "no end date" : d);
      return {
        change,
        service: "campaigns",
        operations: before === change.end_date ? [] : [{
          update: {
            resourceName: `customers/${customerId}/campaigns/${change.campaign_id}`,
            endDateTime: change.end_date === "none" ? NO_END_DATE_TIME : `${change.end_date} 23:59:59`,
          },
          updateMask: "end_date_time",
        }],
        describe: `Set end date of campaign "${c.campaign.name}" from ${label(before)} to ${label(change.end_date)}` +
          (change.end_date === "none" ? "" : " (it stops serving after that day)"),
        inverse: { type: "set_end_date", campaign_id: change.campaign_id, end_date: before },
      };
    }
    case "create_campaign": {
      const c = change;
      await buildChecks(q, c);
      requireBids(c.bidding, c.ad_groups.filter((g) => g.default_max_cpc == null && g.keywords.some((k) => k.max_cpc == null)));
      const T = tempIds(customerId);
      const { campaign, ops: base } = campaignOps(T, c, "SEARCH", {
        networkSettings: { targetGoogleSearch: true, targetSearchNetwork: c.search_partners, targetContentNetwork: false, targetPartnerSearchNetwork: false },
        ...geoMode(c.presence_only), ...biddingFields(c.bidding, { ceiling: c.max_cpc_ceiling }),
      });
      const ops: object[] = [
        ...base,
        ...targetingOps({ campaign }, c.location_ids, c.language_ids),
        ...c.negative_keywords.map((k) => ({ campaignCriterionOperation: { create: { campaign, negative: true, keyword: { text: k.text, matchType: k.match_type } } } })),
        ...sitelinkOps(T, campaign, c.sitelinks),
        ...c.ad_groups.flatMap((g) => adGroupOps(T, campaign, g)),
      ];
      const groups = c.ad_groups.map((g) => `"${g.name}" (${g.keywords.length} keyword(s)${g.default_max_cpc ? `, bid ${g.default_max_cpc.toFixed(2)}` : ""}, ${g.ads.length} ad(s) → ${g.ads[0]!.final_url})`);
      return {
        change, service: "googleAds", operations: ops,
        describe: `${buildHead("Search", c)}, ${biddingLabel(c.bidding, { ceiling: c.max_cpc_ceiling })}, ` +
          `${await targetingLabel(q, c.location_ids, c.language_ids, c.presence_only)}` +
          `${c.end_date ? `, ends ${c.end_date}` : ""}${c.search_partners ? ", plus search partners" : ""}; ` +
          `${c.ad_groups.length} ad group(s): ${groups.join("; ")}` +
          `${c.negative_keywords.length ? `; ${c.negative_keywords.length} negative keyword(s)` : ""}` +
          `${c.sitelinks.length ? `; ${c.sitelinks.length} sitelink(s)` : ""}` + budgetWarn(c.daily_budget),
      };
    }
    case "create_display_campaign": {
      const c = change;
      await buildChecks(q, c);
      requireBids(c.bidding, c.ad_groups.filter((g) => g.default_max_cpc == null));
      const T = tempIds(customerId);
      const { campaign, ops: base } = campaignOps(T, c, "DISPLAY", { ...geoMode(c.presence_only), ...biddingFields(c.bidding, { ceiling: c.max_cpc_ceiling }) });
      const imgs = await imageAssets(q, T, customerId, c.ad_groups.flatMap((g) => g.ads.flatMap((a) =>
        [...a.marketing_images, ...a.square_marketing_images, ...a.square_logo_images, ...a.logo_images])));
      const ref = (xs: string[]) => xs.map((x) => ({ asset: imgs.of(x) }));
      const ops: object[] = [
        ...base,
        ...targetingOps({ campaign }, c.location_ids, c.language_ids),
        ...imgs.ops,
        ...c.ad_groups.flatMap((g) => {
          const adGroup = T.next("adGroups");
          return [
            { adGroupOperation: { create: { resourceName: adGroup, campaign, name: g.name, status: "ENABLED", type: "DISPLAY_STANDARD",
              ...(g.default_max_cpc ? { cpcBidMicros: toMicros(g.default_max_cpc) } : {}) } } },
            ...g.ads.map((a) => ({ adGroupAdOperation: { create: { adGroup, status: "ENABLED", ad: { finalUrls: [a.final_url], responsiveDisplayAd: {
              headlines: textList(a.headlines), longHeadline: { text: a.long_headline }, descriptions: textList(a.descriptions), businessName: a.business_name,
              marketingImages: ref(a.marketing_images), squareMarketingImages: ref(a.square_marketing_images),
              ...(a.square_logo_images.length ? { squareLogoImages: ref(a.square_logo_images) } : {}),
              ...(a.logo_images.length ? { logoImages: ref(a.logo_images) } : {}),
            } } } } })),
          ];
        }),
      ];
      const groups = c.ad_groups.map((g) => `"${g.name}" (${g.default_max_cpc ? `bid ${g.default_max_cpc.toFixed(2)}, ` : ""}${g.ads.length} ad(s) → ${g.ads[0]!.final_url})`);
      return {
        change, service: "googleAds", operations: ops,
        describe: `${buildHead("Display", c)}, ${biddingLabel(c.bidding, { ceiling: c.max_cpc_ceiling })}, ` +
          `${await targetingLabel(q, c.location_ids, c.language_ids, c.presence_only)}${c.end_date ? `, ends ${c.end_date}` : ""}; ` +
          `${c.ad_groups.length} ad group(s): ${groups.join("; ")}; ${imgs.summary}` + budgetWarn(c.daily_budget),
      };
    }
    case "create_demand_gen_campaign": {
      const c = change;
      await buildChecks(q, c);
      const T = tempIds(customerId);
      const { campaign, ops: base } = campaignOps(T, c, "DEMAND_GEN", biddingFields(c.bidding));
      const imgs = await imageAssets(q, T, customerId, c.ad_groups.flatMap((g) => g.ads.map((a) => a.logo_image)));
      const vids = videoAssets(T, c.ad_groups.flatMap((g) => g.ads.flatMap((a) => a.videos)));
      const ops: object[] = [
        ...base, ...imgs.ops, ...vids.ops,
        ...c.ad_groups.flatMap((g) => {
          const adGroup = T.next("adGroups");
          return [
            { adGroupOperation: { create: { resourceName: adGroup, campaign, name: g.name, status: "ENABLED" } } },
            // Demand Gen takes locations and languages on the ad group; Google rejects them on the campaign.
            ...targetingOps({ adGroup }, g.location_ids, g.language_ids),
            ...g.ads.map((a, i) => ({ adGroupAdOperation: { create: { adGroup, status: "ENABLED", ad: {
              name: `Video ad ${i + 1}`, finalUrls: [a.final_url], demandGenVideoResponsiveAd: {
                videos: a.videos.map((v) => ({ asset: vids.of(v) })), logoImages: [{ asset: imgs.of(a.logo_image) }],
                headlines: textList(a.headlines), longHeadlines: textList(a.long_headlines),
                descriptions: textList(a.descriptions), businessName: { text: a.business_name },
              } } } } })),
          ];
        }),
      ];
      const groups = await Promise.all(c.ad_groups.map(async (g) =>
        `"${g.name}" (${await targetingLabel(q, g.location_ids, g.language_ids)}; ${g.ads.length} video ad(s) → ${g.ads[0]!.final_url})`));
      return {
        change, service: "googleAds", operations: ops,
        describe: `${buildHead("Demand Gen (YouTube video ads)", c)}, ${biddingLabel(c.bidding)}${c.end_date ? `, ends ${c.end_date}` : ""}; ` +
          `${c.ad_groups.length} ad group(s): ${groups.join("; ")}; ${vids.count} video(s), ${imgs.summary}` +
          (c.bidding === "MAXIMIZE_CONVERSIONS" ? CONVERSIONS_WARN : "") + budgetWarn(c.daily_budget),
      };
    }
    case "create_performance_max_campaign": {
      const c = change;
      await buildChecks(q, c);
      if (c.target_cpa != null && c.bidding !== "MAXIMIZE_CONVERSIONS") throw new Error("target_cpa only goes with MAXIMIZE_CONVERSIONS.");
      const T = tempIds(customerId);
      // Google's default since brand guidelines: business name and logo belong to the campaign, not the asset groups.
      const { campaign, ops: base } = campaignOps(T, c, "PERFORMANCE_MAX", { brandGuidelinesEnabled: true, ...biddingFields(c.bidding, { targetCpa: c.target_cpa }) });
      const imgs = await imageAssets(q, T, customerId, [...c.logo_images, ...c.asset_groups.flatMap((g) =>
        [...g.marketing_images, ...g.square_marketing_images, ...g.portrait_marketing_images])]);
      const vids = videoAssets(T, c.asset_groups.flatMap((g) => g.videos));
      const texts = textAssets(T);
      const businessName = texts.of(c.business_name);
      const groups = c.asset_groups.flatMap((g) => {
        const assetGroup = T.next("assetGroups");
        const link = (asset: string, fieldType: string) => ({ assetGroupAssetOperation: { create: { assetGroup, asset, fieldType } } });
        return [
          { assetGroupOperation: { create: { resourceName: assetGroup, campaign, name: g.name, finalUrls: [g.final_url], status: "ENABLED" } } },
          ...g.headlines.map((t) => link(texts.of(t), "HEADLINE")),
          ...g.long_headlines.map((t) => link(texts.of(t), "LONG_HEADLINE")),
          ...g.descriptions.map((t) => link(texts.of(t), "DESCRIPTION")),
          ...g.marketing_images.map((x) => link(imgs.of(x), "MARKETING_IMAGE")),
          ...g.square_marketing_images.map((x) => link(imgs.of(x), "SQUARE_MARKETING_IMAGE")),
          ...g.portrait_marketing_images.map((x) => link(imgs.of(x), "PORTRAIT_MARKETING_IMAGE")),
          ...g.videos.map((v) => link(vids.of(v), "YOUTUBE_VIDEO")),
        ];
      });
      const ops: object[] = [
        ...base,
        ...targetingOps({ campaign }, c.location_ids, c.language_ids),
        // Every asset before anything links to it; an asset group and its links must share one request, which this is.
        ...imgs.ops, ...vids.ops, ...texts.ops(),
        { campaignAssetOperation: { create: { campaign, asset: businessName, fieldType: "BUSINESS_NAME" } } },
        ...c.logo_images.map((x) => ({ campaignAssetOperation: { create: { campaign, asset: imgs.of(x), fieldType: "LOGO" } } })),
        ...groups,
      ];
      const summary = c.asset_groups.map((g) => `"${g.name}" (${g.headlines.length} headlines, ${g.descriptions.length} descriptions, ` +
        `${g.marketing_images.length + g.square_marketing_images.length + g.portrait_marketing_images.length} images, ${g.videos.length} video(s) → ${g.final_url})`);
      return {
        change, service: "googleAds", operations: ops,
        describe: `${buildHead("Performance Max", c)}, ${biddingLabel(c.bidding, { targetCpa: c.target_cpa })}, ` +
          `${await targetingLabel(q, c.location_ids, c.language_ids)}${c.end_date ? `, ends ${c.end_date}` : ""}; business name "${c.business_name}"; ` +
          `${c.asset_groups.length} asset group(s): ${summary.join("; ")}; ${imgs.summary}` + CONVERSIONS_WARN +
          (c.asset_groups.some((g) => !g.videos.length) ? "; with no video, Google may auto-generate one from the images" : "") + budgetWarn(c.daily_budget),
      };
    }
    case "add_ad_group": {
      const [c] = await q(`SELECT campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type
        FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      if (c.campaign.status === "REMOVED") throw new Error(`Campaign "${c.campaign.name}" was removed in Google Ads and can't be changed.`);
      if (c.campaign.advertisingChannelType !== "SEARCH") throw new Error(`Campaign "${c.campaign.name}" isn't a Search campaign; ad groups can only be added to Search campaigns here.`);
      const g = change.ad_group;
      if (c.campaign.biddingStrategyType === "MANUAL_CPC" && g.default_max_cpc == null && g.keywords.some((k) => k.max_cpc == null)) {
        throw new Error(`Campaign "${c.campaign.name}" uses manual CPC: give the ad group a default_max_cpc.`);
      }
      const T = tempIds(customerId);
      return {
        change, service: "googleAds",
        operations: adGroupOps(T, `customers/${customerId}/campaigns/${change.campaign_id}`, g),
        describe: `Add ad group "${g.name}" to campaign "${c.campaign.name}": ${g.keywords.length} keyword(s)` +
          `${g.default_max_cpc ? `, bid ${g.default_max_cpc.toFixed(2)}` : ""}, ${g.ads.length} ad(s) → ${g.ads[0]!.final_url}` +
          (c.campaign.status === "ENABLED" ? " ⚠ the campaign is on, so this starts serving once Google approves the ads" : ""),
      };
    }
    case "add_keywords": {
      const [g] = await q(`SELECT ad_group.name, campaign.name, campaign.status FROM ad_group WHERE ad_group.id = ${change.ad_group_id}`);
      if (!g) throw new Error(`Ad group ${change.ad_group_id} not found`);
      const existing = await q(`SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion
        WHERE ad_group.id = ${change.ad_group_id} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = false
        AND ad_group_criterion.status != 'REMOVED'`);
      const have = new Set(existing.map((r) => `${String(r.adGroupCriterion?.keyword?.text ?? "").toLowerCase()}|${r.adGroupCriterion?.keyword?.matchType}`));
      const fresh = change.keywords.filter((k) => isNew(have, `${k.text.toLowerCase()}|${k.match_type}`));
      const skipped = change.keywords.length - fresh.length;
      const adGroup = `customers/${customerId}/adGroups/${change.ad_group_id}`;
      return {
        change: { ...change, keywords: fresh }, service: "adGroupCriteria",
        operations: fresh.map((k) => ({ create: keywordCreate(adGroup, k) })),
        describe: `Add ${fresh.length} keyword(s) to ad group "${g.adGroup.name}" (campaign "${g.campaign.name}"): ` +
          fresh.map((k) => fmtKw(k.text, k.match_type) + (k.max_cpc ? ` @ ${k.max_cpc.toFixed(2)}` : "")).join(", ") +
          (skipped ? ` (${skipped} already present or repeated, skipped)` : ""),
      };
    }
    case "add_responsive_search_ad": {
      const [g] = await q(`SELECT ad_group.name, campaign.name FROM ad_group WHERE ad_group.id = ${change.ad_group_id}`);
      if (!g) throw new Error(`Ad group ${change.ad_group_id} not found`);
      return {
        change, service: "adGroupAds",
        operations: [{ create: adCreate(`customers/${customerId}/adGroups/${change.ad_group_id}`, change.ad) }],
        describe: `Add a responsive search ad to ad group "${g.adGroup.name}" (campaign "${g.campaign.name}"): ` +
          `${change.ad.headlines.length} headlines, ${change.ad.descriptions.length} descriptions → ${change.ad.final_url}`,
      };
    }
    case "add_sitelinks": {
      const [c] = await q(`SELECT campaign.name FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      const T = tempIds(customerId);
      return {
        change, service: "googleAds",
        operations: sitelinkOps(T, `customers/${customerId}/campaigns/${change.campaign_id}`, change.sitelinks),
        describe: `Add ${change.sitelinks.length} sitelink(s) to campaign "${c.campaign.name}": ${change.sitelinks.map((x) => `"${x.text}"`).join(", ")}`,
      };
    }
    case "set_conversion_goal": {
      const rows = await q(`SELECT campaign.name, campaign_conversion_goal.resource_name, campaign_conversion_goal.category,
          campaign_conversion_goal.origin, campaign_conversion_goal.biddable
        FROM campaign_conversion_goal WHERE campaign.id = ${change.campaign_id}`);
      if (!rows.length) throw new Error(`Campaign ${change.campaign_id} not found, or it has no conversion goals yet`);
      const cats = [...new Set(rows.map((r) => r.campaignConversionGoal.category as string))];
      if (!cats.includes(change.category)) {
        throw new Error(`No ${change.category} goal on this campaign. The account's conversion actions give it: ${cats.join(", ")}. `
          + `A GA4 key event becomes a goal only once it is imported (the import_ga4_key_event change), and then under its category; `
          + `a HIDDEN action is one not imported yet. Check with SELECT conversion_action.name, conversion_action.category, conversion_action.status, `
          + `conversion_action.google_analytics_4_settings.event_name FROM conversion_action.`);
      }
      const flips = rows.filter((r) => !!r.campaignConversionGoal.biddable !== (r.campaignConversionGoal.category === change.category));
      const before = [...new Set(rows.filter((r) => r.campaignConversionGoal.biddable).map((r) => r.campaignConversionGoal.category as string))];
      return {
        change, service: "campaignConversionGoals",
        operations: flips.map((r) => ({
          update: { resourceName: r.campaignConversionGoal.resourceName, biddable: r.campaignConversionGoal.category === change.category },
          updateMask: "biddable",
        })),
        describe: `Campaign "${rows[0].campaign.name}" counts and bids on ${change.category} conversions only (was: ${before.join(", ") || "none"})`,
        inverse: flips.length ? {
          type: "restore_conversion_goals", campaign_id: change.campaign_id,
          goals: flips.map((r) => ({ resource_name: r.campaignConversionGoal.resourceName, biddable: !!r.campaignConversionGoal.biddable })),
        } : undefined,
      };
    }
    case "restore_conversion_goals": {
      const [c] = await q(`SELECT campaign.name FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      return {
        change, service: "campaignConversionGoals",
        operations: change.goals.map((g) => ({ update: { resourceName: g.resource_name, biddable: g.biddable }, updateMask: "biddable" })),
        describe: `Restore the conversion goals campaign ${c ? `"${c.campaign.name}"` : change.campaign_id} bid on before`,
      };
    }
    case "remove_campaign":
      return {
        change, service: "campaigns", operations: [{ remove: change.resource_name }],
        describe: `Remove campaign "${change.name}" that Camberstack created ⚠ a removed campaign can't be restored; to only stop spending, pause it instead`,
      };
    case "remove_ad_group":
      return { change, service: "adGroups", operations: [{ remove: change.resource_name }], describe: `Remove ad group "${change.name}" that Camberstack created` };
    case "remove_keywords":
      return { change, service: "adGroupCriteria", operations: change.resource_names.map((r) => ({ remove: r })), describe: `Remove ${change.what}` };
    case "remove_ad":
      return { change, service: "adGroupAds", operations: [{ remove: change.resource_name }], describe: `Remove ${change.what}` };
    case "remove_campaign_assets":
      return { change, service: "googleAds", operations: change.resource_names.map((r) => ({ campaignAssetOperation: { remove: r } })), describe: `Remove ${change.what}` };
    case "set_keyword_bid": {
      const [k] = await q(`SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.cpc_bid_micros,
          ad_group.name, ad_group.cpc_bid_micros FROM ad_group_criterion WHERE ad_group.id = ${change.ad_group_id}
          AND ad_group_criterion.criterion_id = ${change.criterion_id}`);
      if (!k) throw new Error(`Keyword ${change.criterion_id} not found in ad group ${change.ad_group_id}`);
      const before = k.adGroupCriterion.cpcBidMicros ? micros(k.adGroupCriterion.cpcBidMicros) : null;
      const label = (v: number | null) => (v == null ? `the ad group's ${micros(k.adGroup.cpcBidMicros).toFixed(2)}` : v.toFixed(2));
      const same = before === change.max_cpc;
      return {
        change, service: "adGroupCriteria",
        operations: same ? [] : [{ update: { resourceName: `customers/${customerId}/adGroupCriteria/${change.ad_group_id}~${change.criterion_id}`,
          ...(change.max_cpc != null ? { cpcBidMicros: toMicros(change.max_cpc) } : {}) }, updateMask: "cpc_bid_micros" }],
        describe: `Set max CPC of keyword ${fmtKw(k.adGroupCriterion.keyword.text, k.adGroupCriterion.keyword.matchType)} in ad group "${k.adGroup.name}" from ${label(before)} to ${label(change.max_cpc)}` +
          bidWarn(before ?? micros(k.adGroup.cpcBidMicros), change.max_cpc),
        inverse: same ? undefined : { type: "set_keyword_bid", ad_group_id: change.ad_group_id, criterion_id: change.criterion_id, max_cpc: before },
      };
    }
    case "set_ad_group_bid": {
      const [g] = await q(`SELECT ad_group.name, ad_group.cpc_bid_micros, campaign.name FROM ad_group WHERE ad_group.id = ${change.ad_group_id}`);
      if (!g) throw new Error(`Ad group ${change.ad_group_id} not found`);
      const before = micros(g.adGroup.cpcBidMicros);
      return {
        change, service: "adGroups",
        operations: before === change.max_cpc ? [] : [{ update: { resourceName: `customers/${customerId}/adGroups/${change.ad_group_id}`, cpcBidMicros: toMicros(change.max_cpc) }, updateMask: "cpc_bid_micros" }],
        describe: `Set default max CPC of ad group "${g.adGroup.name}" (campaign "${g.campaign.name}") from ${before.toFixed(2)} to ${change.max_cpc.toFixed(2)}` + bidWarn(before, change.max_cpc),
        inverse: before === change.max_cpc ? undefined : { type: "set_ad_group_bid", ad_group_id: change.ad_group_id, max_cpc: before },
      };
    }
    case "pause_ad":
    case "enable_ad": {
      const [a] = await q(`SELECT ad_group_ad.status, ad_group_ad.ad.final_urls, ad_group.name, campaign.name FROM ad_group_ad
        WHERE ad_group.id = ${change.ad_group_id} AND ad_group_ad.ad.id = ${change.ad_id}`);
      if (!a) throw new Error(`Ad ${change.ad_id} not found in ad group ${change.ad_group_id}`);
      const { ad_group_id, ad_id } = change;
      return toggle(change, "pause_ad", "enable_ad", (type) => ({ type, ad_group_id, ad_id }), {
        service: "adGroupAds", before: a.adGroupAd.status, resourceName: `customers/${customerId}/adGroupAds/${ad_group_id}~${ad_id}`,
        what: `ad ${ad_id}${a.adGroupAd.ad?.finalUrls?.[0] ? ` (→ ${a.adGroupAd.ad.finalUrls[0]})` : ""} in ad group "${a.adGroup.name}"`, context: `campaign "${a.campaign.name}"`,
      });
    }
    case "add_campaign_targeting":
    case "remove_campaign_targeting": {
      const [c] = await q(`SELECT campaign.name, campaign.status FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      if (!change.location_ids.length && !change.language_ids.length) throw new Error("Give location_ids and/or language_ids.");
      const have = await q(`SELECT campaign_criterion.resource_name, campaign_criterion.type, campaign_criterion.location.geo_target_constant,
          campaign_criterion.language.language_constant FROM campaign_criterion WHERE campaign.id = ${change.campaign_id}
          AND campaign_criterion.type IN ('LOCATION', 'LANGUAGE') AND campaign_criterion.negative = false`);
      const rnOf = (const_: string) => have.find((r) =>
        r.campaignCriterion.location?.geoTargetConstant === const_ || r.campaignCriterion.language?.languageConstant === const_)?.campaignCriterion.resourceName as string | undefined;
      const consts = [...change.location_ids.map((g) => `geoTargetConstants/${g}`), ...change.language_ids.map((l) => `languageConstants/${l}`)];
      const campaign = `customers/${customerId}/campaigns/${change.campaign_id}`;
      const places = [...await names(q, "geo_target_constant", "canonical_name", consts.filter((x) => x.startsWith("geo"))),
        ...await names(q, "language_constant", "name", consts.filter((x) => x.startsWith("lang")))];
      if (change.type === "add_campaign_targeting") {
        const fresh = consts.filter((x) => !rnOf(x));
        return {
          change, service: "campaignCriteria",
          operations: fresh.map((x) => ({ create: { campaign, ...(x.startsWith("geo") ? { location: { geoTargetConstant: x } } : { language: { languageConstant: x } }) } })),
          describe: `Add targeting to campaign "${c.campaign.name}": ${places.join(", ")}`,
        };
      }
      const gone = consts.filter((x) => rnOf(x));   // only these are removed, so only these come back on undo
      const rns = gone.map((x) => rnOf(x)!);
      const stillLoc = have.filter((r) => r.campaignCriterion.type === "LOCATION" && !rns.includes(r.campaignCriterion.resourceName)).length;
      return {
        change, service: "campaignCriteria", operations: rns.map((r) => ({ remove: r })),
        describe: `Stop targeting ${places.join(", ")} in campaign "${c.campaign.name}"` +
          (have.some((r) => r.campaignCriterion.type === "LOCATION") && !stillLoc ? " ⚠ no locations left: the campaign would show worldwide" : ""),
        inverse: rns.length ? { type: "add_campaign_targeting", campaign_id: change.campaign_id,
          location_ids: gone.filter((x) => x.startsWith("geo")).map((x) => x.split("/")[1]!),
          language_ids: gone.filter((x) => x.startsWith("lang")).map((x) => x.split("/")[1]!) } : undefined,
      };
    }
    case "set_location_mode": {
      const [c] = await q(`SELECT campaign.name, campaign.geo_target_type_setting.positive_geo_target_type FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      const before = c.campaign.geoTargetTypeSetting?.positiveGeoTargetType === "PRESENCE";
      const label = (p: boolean) => (p ? "people in the locations only" : "people in or interested in the locations");
      return {
        change, service: "campaigns",
        operations: before === change.presence_only ? [] : [{ update: { resourceName: `customers/${customerId}/campaigns/${change.campaign_id}`,
          geoTargetTypeSetting: { positiveGeoTargetType: change.presence_only ? "PRESENCE" : "PRESENCE_OR_INTEREST" } },
          updateMask: "geo_target_type_setting.positive_geo_target_type" }],
        describe: `Campaign "${c.campaign.name}" shows to ${label(change.presence_only)} (was: ${label(before)})`,
        inverse: { type: "set_location_mode", campaign_id: change.campaign_id, presence_only: before },
      };
    }
    case "set_bidding_strategy": {
      const [c] = await q(`SELECT campaign.name, campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.target_spend.cpc_bid_ceiling_micros,
          campaign.maximize_conversions.target_cpa_micros
        FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      // On a shared (portfolio) strategy: this campaign moves onto its own strategy; undo puts it back on the shared one.
      const shared = c.campaign.biddingStrategy ? await sharedStrategy(q, c.campaign.biddingStrategy as string) : null;
      if (change.max_cpc_ceiling && change.strategy !== "MAXIMIZE_CLICKS") throw new Error("max_cpc_ceiling only applies to MAXIMIZE_CLICKS.");
      if (change.target_cpa && change.strategy !== "MAXIMIZE_CONVERSIONS") throw new Error("target_cpa only applies to MAXIMIZE_CONVERSIONS.");
      const t = c.campaign.biddingStrategyType as string;
      const prev = shared
        ? { bidding: { biddingStrategy: shared.resourceName }, mask: "bidding_strategy", label: `shared strategy "${shared.name}"` }
        : biddingOf(t, c.campaign);
      if (!prev) throw new Error(`Campaign "${c.campaign.name}" uses ${t}, which Camberstack can't restore on undo; change it in Google Ads.`);
      const next = biddingOf(change.strategy === "MAXIMIZE_CLICKS" ? "TARGET_SPEND" : change.strategy, {
        targetSpend: { cpcBidCeilingMicros: change.max_cpc_ceiling ? toMicros(change.max_cpc_ceiling) : undefined },
        maximizeConversions: { targetCpaMicros: change.target_cpa ? toMicros(change.target_cpa) : undefined },
      })!;
      const others = shared ? shared.campaigns.filter((n) => n !== c.campaign.name) : [];
      return {
        change, service: "campaigns",
        operations: next.label === prev.label ? [] : [{ update: { resourceName: `customers/${customerId}/campaigns/${change.campaign_id}`, ...next.bidding }, updateMask: next.mask }],
        describe: `Switch bid strategy of campaign "${c.campaign.name}" from ${prev.label} to ${next.label}`
          + (shared ? ` (this campaign only${others.length ? `; ${others.length} other campaign${others.length === 1 ? " stays" : "s stay"} on "${shared.name}"` : ""})` : "")
          + " ⚠ Google re-learns after a switch; expect a week or two of uneven results",
        inverse: { type: "restore_bidding", campaign_id: change.campaign_id, bidding: prev.bidding, mask: prev.mask, label: prev.label },
      };
    }
    case "restore_bidding": {
      const [c] = await q(`SELECT campaign.name FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      return {
        change, service: "campaigns",
        operations: [{ update: { resourceName: `customers/${customerId}/campaigns/${change.campaign_id}`, ...change.bidding }, updateMask: change.mask }],
        describe: `Switch bid strategy of campaign ${c ? `"${c.campaign.name}"` : change.campaign_id} back to ${change.label}`,
      };
    }
    case "set_shared_bid_strategy":
    case "restore_shared_bid_strategy": {
      const rn = `customers/${customerId}/biddingStrategies/${change.bidding_strategy_id}`;
      const s = await sharedStrategy(q, rn);
      const reach = `⚠ applies to every campaign on it (${s.campaigns.length}): ${s.campaigns.map((n) => `"${n}"`).join(", ") || "none"}`;
      if (change.type === "restore_shared_bid_strategy") {
        return {
          change, service: "biddingStrategies",
          operations: [{ update: { resourceName: rn, ...change.fields }, updateMask: change.mask }],
          describe: `Set shared bid strategy "${s.name}" back to ${change.label} ${reach}`,
        };
      }
      const field = SHARED_FIELDS[s.type];
      if (!field) throw new Error(`Shared strategy "${s.name}" is ${s.type}, which Camberstack can't change; edit it in Google Ads.`);
      const want: [SharedSetting, number | undefined][] = [["target_cpa", change.target_cpa], ["target_roas", change.target_roas], ["max_cpc_ceiling", change.max_cpc_ceiling]];
      const given = want.filter(([, v]) => v !== undefined);
      if (!given.length) throw new Error("Give target_cpa, target_roas or max_cpc_ceiling.");
      for (const [k] of given) {
        if (!field[k]) throw new Error(`Shared strategy "${s.name}" is ${s.type}, which has no ${k}. It takes: ${SETTINGS.filter((x) => field[x]).join(", ")}.`);
      }
      const block = s.raw[field.key] ?? {};
      const show = (k: string, v: unknown) => (v === undefined || v === null || v === "" || v === "0" || v === 0 ? "none"
        : k === "target_roas" ? `${Math.round(Number(v) * 100)}%` : micros(v).toFixed(2));
      const nextFields: Record<string, unknown> = {}, prevFields: Record<string, unknown> = {}, masks: string[] = [], diff: string[] = [], back: string[] = [];
      for (const [k, v] of given) {
        const api = field[k]!;
        const before = block[api.camel];
        nextFields[api.camel] = k === "target_roas" ? v : String(toMicros(v!));
        if (before !== undefined && before !== null) prevFields[api.camel] = before;   // left out = cleared on undo
        masks.push(`${field.key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)}.${api.snake}`);
        diff.push(`${settingLabel(k)} ${show(k, before)} → ${show(k, nextFields[api.camel])}`);
        back.push(`${settingLabel(k)} ${show(k, before)}`);
      }
      const same = given.every(([k]) => String(block[field[k]!.camel] ?? "") === String(nextFields[field[k]!.camel]));
      return {
        change, service: "biddingStrategies",
        operations: same ? [] : [{ update: { resourceName: rn, [field.key]: nextFields }, updateMask: masks.join(",") }],
        describe: `Change shared bid strategy "${s.name}": ${diff.join(", ")} ${reach}`,
        inverse: same ? undefined : { type: "restore_shared_bid_strategy", bidding_strategy_id: change.bidding_strategy_id,
          fields: { [field.key]: prevFields }, mask: masks.join(","), label: back.join(", ") },
      };
    }
    case "create_shared_bid_strategy": {
      const type = change.strategy === "MAXIMIZE_CLICKS" ? "TARGET_SPEND" : change.strategy;
      const field = SHARED_FIELDS[type]!;
      if (type === "TARGET_CPA" && change.target_cpa === undefined) throw new Error("TARGET_CPA needs target_cpa.");
      if (type === "TARGET_ROAS" && change.target_roas === undefined) throw new Error("TARGET_ROAS needs target_roas.");
      const given = SETTINGS.filter((k) => change[k] !== undefined);
      for (const k of given) if (!field[k]) throw new Error(`${change.strategy} has no ${k}. It takes: ${SETTINGS.filter((x) => field[x]).join(", ")}.`);
      const dup = await q(`SELECT bidding_strategy.id FROM bidding_strategy WHERE bidding_strategy.name = '${gaqlStr(change.name)}' AND bidding_strategy.status != 'REMOVED'`);
      if (dup.length) throw new Error(`A shared bid strategy named "${change.name}" already exists (id ${dup[0].biddingStrategy.id}). Pick another name.`);
      const settings = Object.fromEntries(given.map((k) => [field[k]!.camel, k === "target_roas" ? change[k] : String(toMicros(change[k]!))]));
      const t = tempIds(customerId);
      const strategyRn = t.next("biddingStrategies");
      const ops: object[] = [{ biddingStrategyOperation: { create: { resourceName: strategyRn, name: change.name, [field.key]: settings } } }];
      const moved: { campaign_id: string; name: string; bidding: Record<string, unknown>; mask: string; label: string }[] = [];
      for (const cid of [...new Set(change.campaign_ids)]) {
        const [c] = await q(`SELECT campaign.name, campaign.status, campaign.bidding_strategy_type, campaign.bidding_strategy,
            campaign.target_spend.cpc_bid_ceiling_micros, campaign.maximize_conversions.target_cpa_micros FROM campaign WHERE campaign.id = ${cid}`);
        if (!c) throw new Error(`Campaign ${cid} not found`);
        if (c.campaign.status === "REMOVED") throw new Error(`Campaign "${c.campaign.name}" was removed in Google Ads and can't be changed.`);
        const shared = c.campaign.biddingStrategy ? await sharedStrategy(q, c.campaign.biddingStrategy as string) : null;
        const prev = shared
          ? { bidding: { biddingStrategy: shared.resourceName }, mask: "bidding_strategy", label: `shared strategy "${shared.name}"` }
          : biddingOf(c.campaign.biddingStrategyType as string, c.campaign);
        if (!prev) throw new Error(`Campaign "${c.campaign.name}" uses ${c.campaign.biddingStrategyType}, which Camberstack can't restore on undo; move it in Google Ads.`);
        moved.push({ campaign_id: cid, name: c.campaign.name, ...prev });
        ops.push({ campaignOperation: { update: { resourceName: `customers/${customerId}/campaigns/${cid}`, biddingStrategy: strategyRn }, updateMask: "bidding_strategy" } });
      }
      const what = given.map((k) => `${settingLabel(k)} ${k === "target_roas" ? `${Math.round(change[k]! * 100)}%` : change[k]!.toFixed(2)}`);
      return {
        change, service: "googleAds", operations: ops,
        // "target CPA 25.00", not "target CPA: target CPA 25.00", when the first setting already names the type.
        describe: `Create shared bid strategy "${change.name}" (${what[0]?.startsWith(STRATEGY_LABEL[type]!) ? what.join(", ")
          : `${STRATEGY_LABEL[type]}${what.length ? `: ${what.join(", ")}` : ""}`})`
          + (moved.length ? ` and move ${moved.length} campaign${moved.length === 1 ? "" : "s"} onto it: ${moved.map((m) => `"${m.name}" (from ${m.label})`).join(", ")}`
            + " ⚠ Google re-learns after a switch; expect a week or two of uneven results" : ""),
        // The strategy's real resource name is filled in after apply (inverseAfterApply).
        inverse: { type: "remove_shared_bid_strategy", resource_name: "", name: change.name, restore: moved },
      };
    }
    case "remove_shared_bid_strategy": {
      // Google won't remove a strategy campaigns are on: move them back first, in the same atomic request.
      const on = await q(`SELECT campaign.id, campaign.name FROM campaign WHERE campaign.bidding_strategy = '${gaqlStr(change.resource_name)}' AND campaign.status != 'REMOVED'`);
      const back = change.restore.filter((r) => on.some((c) => String(c.campaign.id) === r.campaign_id));
      const strays = on.filter((c) => !change.restore.some((r) => r.campaign_id === String(c.campaign.id)));
      if (strays.length) {
        throw new Error(`Shared strategy "${change.name}" is now also used by ${strays.map((c) => `"${c.campaign.name}"`).join(", ")}, `
          + "which Camberstack didn't move onto it. Move those off it first (set_bidding_strategy), then undo again.");
      }
      return {
        change, service: "googleAds",
        operations: [...back.map((r) => ({ campaignOperation: { update: { resourceName: `customers/${customerId}/campaigns/${r.campaign_id}`, ...r.bidding }, updateMask: r.mask } })),
          { biddingStrategyOperation: { remove: change.resource_name } }],
        describe: `Remove shared bid strategy "${change.name}" that Camberstack created`
          + (back.length ? `, moving ${back.map((r) => `"${r.name}" back to ${r.label}`).join(", ")}` : ""),
      };
    }
    case "set_url_suffix": {
      const [c] = await q(`SELECT campaign.name, campaign.final_url_suffix FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      const before = c.campaign.finalUrlSuffix || "none";
      const next = change.suffix.replace(/^\?/, "") || "none";
      return {
        change, service: "campaigns",
        operations: before === next ? [] : [{ update: { resourceName: `customers/${customerId}/campaigns/${change.campaign_id}`,
          ...(next === "none" ? {} : { finalUrlSuffix: next }) }, updateMask: "final_url_suffix" }],
        describe: `Set the URL suffix of campaign "${c.campaign.name}" from ${before === "none" ? "none" : `"${before}"`} to ${next === "none" ? "none" : `"${next}"`}`,
        inverse: { type: "set_url_suffix", campaign_id: change.campaign_id, suffix: before },
      };
    }
    case "set_eu_political_advertising": {
      const [c] = await q(`SELECT campaign.name, campaign.status, campaign.contains_eu_political_advertising FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      if (!c) throw new Error(`Campaign ${change.campaign_id} not found`);
      if (c.campaign.status === "REMOVED") throw new Error(`Campaign "${c.campaign.name}" was removed in Google Ads and can't be changed.`);
      const before = c.campaign.containsEuPoliticalAdvertising as string | undefined;
      const next = change.contains_eu_political_advertising ? EU_POLITICAL : NO_EU_POLITICAL;
      const label = (v: string | undefined) => (v === EU_POLITICAL ? "contains" : v === NO_EU_POLITICAL ? "does not contain" : "not declared");
      return {
        change, service: "campaigns",
        operations: before === next ? [] : [{ update: { resourceName: `customers/${customerId}/campaigns/${change.campaign_id}`,
          containsEuPoliticalAdvertising: next }, updateMask: "contains_eu_political_advertising" }],
        describe: `Declare that campaign "${c.campaign.name}" ${label(next)} EU political advertising (was: ${label(before)})`
          + (next === EU_POLITICAL ? " ⚠ Google no longer runs political ads in the EU, so the campaign won't show there" : ""),
        // Google has no way back to "not declared", so a first declaration can't be undone; a changed one can.
        inverse: before === EU_POLITICAL || before === NO_EU_POLITICAL
          ? { type: "set_eu_political_advertising", campaign_id: change.campaign_id, contains_eu_political_advertising: before === EU_POLITICAL } : undefined,
      };
    }
    case "create_conversion_action": {
      const dup = await q(`SELECT conversion_action.id FROM conversion_action WHERE conversion_action.name = '${gaqlStr(change.name)}' AND conversion_action.status != 'REMOVED'`);
      if (dup.length) throw new Error(`A conversion action named "${change.name}" already exists (id ${dup[0].conversionAction.id}).`);
      return {
        change, service: "conversionActions",
        operations: [{ create: {
          name: change.name, category: change.category, type: change.source, status: "ENABLED", countingType: change.counting, primaryForGoal: change.primary,
          valueSettings: { defaultValue: change.default_value ?? 0, alwaysUseDefaultValue: false },
        } }],
        describe: `Create conversion action "${change.name}" (${change.category}, ${change.source === "UPLOAD_CLICKS" ? "uploaded click ids" : "website tag"}, ` +
          `${change.counting === "ONE_PER_CLICK" ? "one per click" : "every conversion"}, ${change.primary ? "primary" : "secondary"})` +
          (change.primary ? " ⚠ a primary action counts toward every campaign that uses account-default goals; scope campaigns with set_conversion_goal" : ""),
      };
    }
    case "set_conversion_counting": {
      const [a] = await q(`SELECT conversion_action.name, conversion_action.counting_type FROM conversion_action WHERE conversion_action.id = ${change.conversion_action_id}`);
      if (!a) throw new Error(`Conversion action ${change.conversion_action_id} not found`);
      const before = a.conversionAction.countingType as "ONE_PER_CLICK" | "MANY_PER_CLICK";
      return {
        change, service: "conversionActions",
        operations: before === change.counting ? [] : [{ update: { resourceName: `customers/${customerId}/conversionActions/${change.conversion_action_id}`, countingType: change.counting }, updateMask: "counting_type" }],
        describe: `Set conversion action "${a.conversionAction.name}" to count ${change.counting === "ONE_PER_CLICK" ? "one conversion per click" : "every conversion"} (was ${before})`,
        inverse: { type: "set_conversion_counting", conversion_action_id: change.conversion_action_id, counting: before },
      };
    }
    case "import_ga4_key_event": {
      // Google Ads keeps a HIDDEN conversion action for each key event of a linked GA4 property; "Import" in its UI enables it.
      // The API can enable it but can't hide it again, so undo removes it (and importing again re-enables it).
      const rows = await q(`SELECT conversion_action.resource_name, conversion_action.name, conversion_action.status, conversion_action.category,
          conversion_action.primary_for_goal FROM conversion_action
        WHERE conversion_action.google_analytics_4_settings.property_id = ${change.property_id}
          AND conversion_action.google_analytics_4_settings.event_name = '${gaqlStr(change.event_name)}'`);
      const rank = { ENABLED: 0, HIDDEN: 1, REMOVED: 2 } as Record<string, number>;
      const a = rows.map((r) => r.conversionAction).sort((x, y) => (rank[x.status] ?? 3) - (rank[y.status] ?? 3))[0];
      if (!a) {
        throw new Error(`Google Ads has no conversion action for "${change.event_name}" from GA4 property ${change.property_id}. Google adds one once the `
          + `property is linked to this account (link_google_ads) and the event is a key event (mark_key_event); check both with analytics_setup.`);
      }
      const on = a.status === "ENABLED", wasPrimary = !!a.primaryForGoal;
      const label = `"${a.name}" (${a.category}${change.primary ? ", primary" : ", secondary"})`;
      const op = { update: { resourceName: a.resourceName, status: "ENABLED", primaryForGoal: change.primary }, updateMask: "status,primary_for_goal" };
      if (on) {
        return {
          change, service: "conversionActions", operations: wasPrimary === change.primary ? [] : [op],
          describe: `Make GA4 conversion action "${a.name}" ${change.primary ? "primary" : "secondary"}` + (wasPrimary === change.primary ? " (already imported)" : ""),
          inverse: { ...change, primary: wasPrimary },
        };
      }
      // A primary import can make Google bid on its category: in the account's default goals and in every campaign using them.
      // Undo needs what bid before, to switch off only what the import turned on.
      const biddableBefore = (await goalsOf(q, a.category)).filter((g) => g.biddable).map((g) => g.resourceName);
      return {
        change, service: "conversionActions", operations: [op],
        describe: `Import GA4 key event "${change.event_name}" into Google Ads as ${label}. It counts only while "${change.event_name}" is a key event in GA4`
          + (change.primary ? " ⚠ a primary action counts toward every campaign that uses account-default goals; scope campaigns with set_conversion_goal" : ""),
        inverse: { type: "remove_imported_conversion_action", resource_name: a.resourceName, name: a.name, property_id: change.property_id,
          event_name: change.event_name, primary: change.primary, category: a.category, biddable_before: biddableBefore },
      };
    }
    case "remove_imported_conversion_action": {
      const before = new Set(change.biddable_before);
      const off = (await goalsOf(q, change.category)).filter((g) => g.biddable && !before.has(g.resourceName));
      // Google refuses to leave a campaign on its own goals with none biddable: say what to do instead of passing on EMPTY_CONVERSION_GOALS.
      const offCampaigns = off.filter((g) => g.campaign);
      if (offCampaigns.length) {
        const bidding = (await q(`SELECT campaign_conversion_goal.resource_name FROM campaign_conversion_goal WHERE campaign_conversion_goal.biddable = TRUE`))
          .map((r) => r.campaignConversionGoal.resourceName as string);
        const cid = (rn: string) => rn.split("/").at(-1)!.split("~")[0];
        const only = offCampaigns.filter((g) => !bidding.some((rn) => cid(rn) === cid(g.resourceName) && rn !== g.resourceName));
        if (only.length) {
          throw new Error(`Campaign(s) ${only.map((g) => `"${g.campaign}"`).join(", ")} bid only on ${change.category} conversions, so undoing this import would leave `
            + `them nothing to bid on. First give them another goal (set_conversion_goal), or undo the change that scoped them to ${change.category}; then undo this.`);
        }
      }
      const campaigns = offCampaigns.map((g) => `"${g.campaign}"`);
      const account = off.some((g) => !g.campaign);
      return {
        change, service: "googleAds",
        operations: [{ conversionActionOperation: { remove: change.resource_name } },
          ...off.map((g) => ({ [g.campaign ? "campaignConversionGoalOperation" : "customerConversionGoalOperation"]:
            { update: { resourceName: g.resourceName, biddable: false }, updateMask: "biddable" } }))],
        describe: `Remove conversion action "${change.name}" from Google Ads (Google can't hide an import again; import_ga4_key_event brings it back)`
          + (off.length ? `, and stop bidding on ${change.category} conversions${account ? " in the account's default goals" : ""}`
            + `${account && campaigns.length ? " and" : ""}${campaigns.length ? ` in campaign(s) ${campaigns.join(", ")}` : ""}, which bid on them since the import` : ""),
        inverse: { type: "import_ga4_key_event", property_id: change.property_id, event_name: change.event_name, primary: change.primary },
      };
    }
    case "remove_campaign_criteria":
      return { change, service: "campaignCriteria", operations: change.resource_names.map((r) => ({ remove: r })), describe: `Remove ${change.what}` };
    case "remove_conversion_action":
      return { change, service: "conversionActions", operations: [{ remove: change.resource_name }], describe: `Remove conversion action "${change.name}" that Camberstack created` };
    case "remove_negative_keywords": {
      const [c] = await q(`SELECT campaign.name FROM campaign WHERE campaign.id = ${change.campaign_id}`);
      const name = c ? `"${c.campaign.name}"` : change.campaign_id;
      return {
        change,
        service: "campaignCriteria",
        operations: change.resource_names.map((r) => ({ remove: r })),
        describe: `Remove ${change.resource_names.length} negative keyword(s) previously added to campaign ${name}`,
      };
    }
  }
}

/** ⚠ when a bid more than doubles. */
function bidWarn(before: number, after: number | null): string {
  return before > 0 && after != null && after > before * 2 ? ` ⚠ ${(after / before).toFixed(1)}× the current bid` : "";
}

/**
 * A campaign's own (non-portfolio) bid strategy as the update that sets it, so undo can put it back.
 * null for strategies Camberstack doesn't restore (target ROAS, target impression share, …).
 */
function biddingOf(type: string, c: any): { bidding: Record<string, unknown>; mask: string; label: string } | null {
  const money = (m: unknown) => (m ? micros(m).toFixed(2) : null);
  switch (type) {
    case "MANUAL_CPC":
      return { bidding: { manualCpc: { enhancedCpcEnabled: false } }, mask: "manual_cpc.enhanced_cpc_enabled", label: "manual CPC" };
    case "TARGET_SPEND": {
      const ceil = c.targetSpend?.cpcBidCeilingMicros;
      return { bidding: { targetSpend: ceil ? { cpcBidCeilingMicros: String(ceil) } : {} }, mask: "target_spend.cpc_bid_ceiling_micros",
        label: `maximize clicks${ceil ? ` (max ${money(ceil)}/click)` : ""}` };
    }
    case "MAXIMIZE_CONVERSIONS": {
      const cpa = c.maximizeConversions?.targetCpaMicros;
      return { bidding: { maximizeConversions: cpa && Number(cpa) ? { targetCpaMicros: String(cpa) } : {} }, mask: "maximize_conversions.target_cpa_micros",
        label: `maximize conversions${cpa && Number(cpa) ? ` (target ${money(cpa)}/conversion)` : ""}` };
    }
    default:
      return null;
  }
}

/** A shared (portfolio) bid strategy: its name, type, settings, and the names of the campaigns on it. */
async function sharedStrategy(q: (query: string) => Promise<any[]>, resourceName: string) {
  const id = resourceName.split("/").pop()!;
  if (!/^\d+$/.test(id)) throw new Error(`Not a bid strategy: ${resourceName}`);
  const [b] = await q(`SELECT bidding_strategy.name, bidding_strategy.type, bidding_strategy.target_cpa.target_cpa_micros,
      bidding_strategy.target_cpa.cpc_bid_ceiling_micros, bidding_strategy.target_roas.target_roas, bidding_strategy.target_roas.cpc_bid_ceiling_micros,
      bidding_strategy.target_spend.cpc_bid_ceiling_micros, bidding_strategy.maximize_conversions.target_cpa_micros,
      bidding_strategy.maximize_conversions.cpc_bid_ceiling_micros, bidding_strategy.maximize_conversion_value.target_roas,
      bidding_strategy.maximize_conversion_value.cpc_bid_ceiling_micros
    FROM bidding_strategy WHERE bidding_strategy.id = ${id}`);
  if (!b) throw new Error(`Shared bid strategy ${id} not found (it may belong to a manager account).`);
  const camps = await q(`SELECT campaign.name FROM campaign WHERE campaign.bidding_strategy = '${gaqlStr(resourceName)}' AND campaign.status != 'REMOVED'`);
  return { resourceName, name: b.biddingStrategy.name as string, type: b.biddingStrategy.type as string, raw: b.biddingStrategy as Record<string, any>,
    campaigns: camps.map((r) => r.campaign.name as string) };
}

type SharedField = { camel: string; snake: string };
const STRATEGY_LABEL: Record<string, string> = { TARGET_SPEND: "maximize clicks", MAXIMIZE_CONVERSIONS: "maximize conversions",
  MAXIMIZE_CONVERSION_VALUE: "maximize conversion value", TARGET_CPA: "target CPA", TARGET_ROAS: "target ROAS" };
/** "max_cpc_ceiling" → "max CPC ceiling", as the summary shows it. */
const settingLabel = (k: string) => k.replace(/_/g, " ").replace(/\b(cpa|roas|cpc)\b/g, (m) => m.toUpperCase());
type SharedSetting = "target_cpa" | "target_roas" | "max_cpc_ceiling";
const SETTINGS: SharedSetting[] = ["target_cpa", "target_roas", "max_cpc_ceiling"];
/** Which settings each shared strategy type has, by the names set_shared_bid_strategy takes. */
const SHARED_FIELDS: Record<string, { key: string } & Partial<Record<SharedSetting, SharedField>>> = {
  TARGET_CPA: { key: "targetCpa", target_cpa: { camel: "targetCpaMicros", snake: "target_cpa_micros" }, max_cpc_ceiling: { camel: "cpcBidCeilingMicros", snake: "cpc_bid_ceiling_micros" } },
  TARGET_ROAS: { key: "targetRoas", target_roas: { camel: "targetRoas", snake: "target_roas" }, max_cpc_ceiling: { camel: "cpcBidCeilingMicros", snake: "cpc_bid_ceiling_micros" } },
  TARGET_SPEND: { key: "targetSpend", max_cpc_ceiling: { camel: "cpcBidCeilingMicros", snake: "cpc_bid_ceiling_micros" } },
  MAXIMIZE_CONVERSIONS: { key: "maximizeConversions", target_cpa: { camel: "targetCpaMicros", snake: "target_cpa_micros" }, max_cpc_ceiling: { camel: "cpcBidCeilingMicros", snake: "cpc_bid_ceiling_micros" } },
  MAXIMIZE_CONVERSION_VALUE: { key: "maximizeConversionValue", target_roas: { camel: "targetRoas", snake: "target_roas" }, max_cpc_ceiling: { camel: "cpcBidCeilingMicros", snake: "cpc_bid_ceiling_micros" } },
};

/** GAQL string literal body: escape backslashes and single quotes. */
function gaqlStr(v: string): string { return v.replace(/[\\']/g, "\\$&"); }

/**
 * Temporary resource names for one googleAds:mutate: negative ids that later operations in the same
 * request can reference, so a whole campaign is created atomically (all or nothing).
 */
function tempIds(customerId: string) {
  let n = 0;
  return { next: (collection: string) => `customers/${customerId}/${collection}/${--n}` };
}

/** Checks every campaign build makes before anything else: a unique name and an end date not in the past. */
async function buildChecks(q: (query: string) => Promise<any[]>, c: { name: string; end_date?: string }): Promise<void> {
  const dup = await q(`SELECT campaign.id FROM campaign WHERE campaign.name = '${gaqlStr(c.name)}' AND campaign.status != 'REMOVED'`);
  if (dup.length) throw new Error(`A campaign named "${c.name}" already exists (id ${dup[0].campaign.id}). Pick another name.`);
  if (c.end_date && c.end_date < new Date().toISOString().slice(0, 10)) throw new Error(`End date ${c.end_date} is in the past.`);
}

function requireBids(bidding: string, missing: { name: string }[]): void {
  if (bidding === "MANUAL_CPC" && missing.length) {
    throw new Error(`Manual CPC needs a bid: give default_max_cpc for ad group(s) ${missing.map((g) => `"${g.name}"`).join(", ")}.`);
  }
}

/** The budget and the PAUSED campaign every build starts with. */
function campaignOps(T: ReturnType<typeof tempIds>, c: { name: string; daily_budget: number; end_date?: string }, channel: string, fields: object) {
  const budget = T.next("campaignBudgets"), campaign = T.next("campaigns");
  return { campaign, ops: [
    { campaignBudgetOperation: { create: { resourceName: budget, name: `${c.name} budget`, amountMicros: toMicros(c.daily_budget), deliveryMethod: "STANDARD", explicitlyShared: false } } },
    { campaignOperation: { create: {
      resourceName: campaign, name: c.name, status: "PAUSED", campaignBudget: budget, advertisingChannelType: channel,
      containsEuPoliticalAdvertising: NO_EU_POLITICAL, ...fields,
      ...(c.end_date ? { endDateTime: `${c.end_date} 23:59:59` } : {}),
    } } },
  ] };
}

const buildHead = (kind: string, c: { name: string; daily_budget: number }) =>
  `Create ${kind} campaign "${c.name}", PAUSED (nothing spends until you enable it): ${c.daily_budget.toFixed(2)}/day`;
const budgetWarn = (daily: number) => (daily >= 100 ? ` ⚠ budget ${daily.toFixed(2)}/day` : "");
const CONVERSIONS_WARN = " ⚠ bidding for conversions needs working conversion tracking, or Google has nothing to optimize for";
const textList = (xs: string[]) => xs.map((text) => ({ text }));
const geoMode = (presenceOnly: boolean) =>
  ({ geoTargetTypeSetting: { positiveGeoTargetType: presenceOnly ? "PRESENCE" : "PRESENCE_OR_INTEREST", negativeGeoTargetType: "PRESENCE" } });

/** Location and language criteria on a campaign, or on an ad group (Demand Gen). */
function targetingOps(owner: { campaign: string } | { adGroup: string }, locationIds: string[], languageIds: string[]): object[] {
  const op = "campaign" in owner ? "campaignCriterionOperation" : "adGroupCriterionOperation";
  return [
    ...locationIds.map((g) => ({ [op]: { create: { ...owner, location: { geoTargetConstant: `geoTargetConstants/${g}` } } } })),
    ...languageIds.map((l) => ({ [op]: { create: { ...owner, language: { languageConstant: `languageConstants/${l}` } } } })),
  ];
}

async function targetingLabel(q: (query: string) => Promise<any[]>, locationIds: string[], languageIds: string[], presenceOnly = false): Promise<string> {
  const places = await names(q, "geo_target_constant", "canonical_name", locationIds.map((g) => `geoTargetConstants/${g}`));
  const langs = await names(q, "language_constant", "name", languageIds.map((l) => `languageConstants/${l}`));
  return `${places.join(", ")}${presenceOnly ? " (people in the location)" : ""}, ${langs.join(", ")}`;
}

type Bidding = "MANUAL_CPC" | "MAXIMIZE_CLICKS" | "MAXIMIZE_CONVERSIONS" | "MAXIMIZE_CONVERSION_VALUE";
function biddingFields(bidding: Bidding, o: { ceiling?: number; targetCpa?: number } = {}): object {
  switch (bidding) {
    case "MANUAL_CPC": return { manualCpc: { enhancedCpcEnabled: false } };
    case "MAXIMIZE_CLICKS": return { targetSpend: o.ceiling ? { cpcBidCeilingMicros: toMicros(o.ceiling) } : {} };
    case "MAXIMIZE_CONVERSIONS": return { maximizeConversions: o.targetCpa ? { targetCpaMicros: toMicros(o.targetCpa) } : {} };
    case "MAXIMIZE_CONVERSION_VALUE": return { maximizeConversionValue: {} };
  }
}

function biddingLabel(bidding: Bidding, o: { ceiling?: number; targetCpa?: number } = {}): string {
  switch (bidding) {
    case "MANUAL_CPC": return "manual CPC";
    case "MAXIMIZE_CLICKS": return `maximize clicks${o.ceiling ? ` (max ${o.ceiling.toFixed(2)}/click)` : ""}`;
    case "MAXIMIZE_CONVERSIONS": return `maximize conversions${o.targetCpa ? ` (target ${o.targetCpa.toFixed(2)}/conversion)` : ""}`;
    case "MAXIMIZE_CONVERSION_VALUE": return "maximize conversion value";
  }
}

/** Swappable so tests don't download anything. */
export const io = { fetchImage };

/**
 * Image references → asset resource names, plus the operations that upload the new ones. A digits-only
 * reference is an existing asset and must be an IMAGE in this account; a URL is downloaded (safely, see
 * fetch-safe.ts) and uploaded. The same bytes twice in one request must be one asset (Google rejects
 * duplicates with different names), so uploads are keyed by content hash and named after it.
 */
async function imageAssets(q: (query: string) => Promise<any[]>, T: ReturnType<typeof tempIds>, customerId: string, refs: string[]) {
  const unique = [...new Set(refs)];
  const ids = unique.filter((r) => /^\d+$/.test(r));
  const urls = unique.filter((r) => !/^\d+$/.test(r));
  const byRef = new Map<string, string>();
  if (ids.length) {
    const rows = await q(`SELECT asset.id, asset.type FROM asset WHERE asset.id IN (${ids.join(", ")})`);
    const found = new Map(rows.map((r) => [String(r.asset?.id), r.asset?.type]));
    for (const a of ids) {
      if (!found.has(a)) throw new Error(`Image asset ${a} isn't in this account. Find image assets with run_gaql: SELECT asset.id, asset.name FROM asset WHERE asset.type = 'IMAGE'.`);
      if (found.get(a) !== "IMAGE") throw new Error(`Asset ${a} is a ${found.get(a)} asset, not an image.`);
      byRef.set(a, `customers/${customerId}/assets/${a}`);
    }
  }
  const ops: object[] = [];
  const byHash = new Map<string, string>();
  const bytes = await Promise.all(urls.map((u) => io.fetchImage(u)));
  urls.forEach((u, i) => {
    const data = bytes[i]!;
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
    let rn = byHash.get(hash);
    if (!rn) {
      rn = T.next("assets");
      byHash.set(hash, rn);
      ops.push({ assetOperation: { create: { resourceName: rn, name: `Camberstack image ${hash}`, type: "IMAGE", imageAsset: { data: data.toString("base64") } } } });
    }
    byRef.set(u, rn);
  });
  const parts = [byHash.size && `${byHash.size} image(s) to upload`, ids.length && `${ids.length} existing image asset(s)`].filter(Boolean);
  return { ops, of: (ref: string) => byRef.get(ref)!, summary: parts.join(", ") };
}

/** A YouTube video id from an id or a youtube.com / youtu.be URL. */
export function youtubeId(input: string): string {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  if (!m) throw new Error(`"${input}" isn't a YouTube video id or URL.`);
  return m[1]!;
}

function videoAssets(T: ReturnType<typeof tempIds>, refs: string[]) {
  const byId = new Map<string, string>();
  const ops: object[] = [];
  for (const r of refs) {
    const v = youtubeId(r);
    if (byId.has(v)) continue;
    const rn = T.next("assets");
    byId.set(v, rn);
    ops.push({ assetOperation: { create: { resourceName: rn, type: "YOUTUBE_VIDEO", youtubeVideoAsset: { youtubeVideoId: v } } } });
  }
  return { ops, of: (ref: string) => byId.get(youtubeId(ref))!, count: byId.size };
}

/** Text assets for Performance Max, one per distinct text: a repeat in the same request would be a duplicate asset. */
function textAssets(T: ReturnType<typeof tempIds>) {
  const byText = new Map<string, string>();
  return {
    of: (text: string) => {
      let rn = byText.get(text);
      if (!rn) { rn = T.next("assets"); byText.set(text, rn); }
      return rn;
    },
    ops: () => [...byText].map(([text, resourceName]) => ({ assetOperation: { create: { resourceName, textAsset: { text } } } })),
  };
}

function keywordCreate(adGroup: string, k: { text: string; match_type: string; max_cpc?: number }) {
  return { adGroup, status: "ENABLED", keyword: { text: k.text, matchType: k.match_type }, ...(k.max_cpc ? { cpcBidMicros: toMicros(k.max_cpc) } : {}) };
}

function adCreate(adGroup: string, a: { headlines: string[]; descriptions: string[]; final_url: string; path1?: string; path2?: string }) {
  return {
    adGroup, status: "ENABLED",
    ad: { finalUrls: [a.final_url], responsiveSearchAd: {
      headlines: a.headlines.map((text) => ({ text })), descriptions: a.descriptions.map((text) => ({ text })),
      ...(a.path1 ? { path1: a.path1 } : {}), ...(a.path2 ? { path2: a.path2 } : {}),
    } },
  };
}

type AdGroupSpec = z.infer<typeof adGroupSpec>;
function adGroupOps(T: ReturnType<typeof tempIds>, campaign: string, g: AdGroupSpec): object[] {
  const adGroup = T.next("adGroups");
  return [
    { adGroupOperation: { create: { resourceName: adGroup, campaign, name: g.name, status: "ENABLED", type: "SEARCH_STANDARD",
      ...(g.default_max_cpc ? { cpcBidMicros: toMicros(g.default_max_cpc) } : {}) } } },
    ...g.ads.map((a) => ({ adGroupAdOperation: { create: adCreate(adGroup, a) } })),
    ...g.keywords.map((k) => ({ adGroupCriterionOperation: { create: keywordCreate(adGroup, k) } })),
  ];
}

type SitelinkSpec = z.infer<typeof sitelinkSpec>;
function sitelinkOps(T: ReturnType<typeof tempIds>, campaign: string, links: SitelinkSpec[]): object[] {
  return links.flatMap((l) => {
    if (!!l.description1 !== !!l.description2) throw new Error(`Sitelink "${l.text}": give both descriptions or neither.`);
    const asset = T.next("assets");
    return [
      { assetOperation: { create: { resourceName: asset, finalUrls: [l.url], sitelinkAsset: {
        linkText: l.text, ...(l.description1 ? { description1: l.description1, description2: l.description2 } : {}) } } } },
      { campaignAssetOperation: { create: { asset, campaign, fieldType: "SITELINK" } } },
    ];
  });
}

/** True the first time `key` is seen (adding it to `seen`): drops what's already there and repeats in one request. */
function isNew(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/** Human names for geo or language constants; falls back to the ids if they can't be read. */
async function names(q: (query: string) => Promise<any[]>, resource: string, field: string, rns: string[]): Promise<string[]> {
  try {
    const rows = await q(`SELECT ${resource}.resource_name, ${resource}.${field} FROM ${resource}
      WHERE ${resource}.resource_name IN (${rns.map((r) => `'${r}'`).join(", ")})`);
    const key = resource.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase());
    const by = new Map(rows.map((r) => [r[key]?.resourceName, r[key]?.[field === "canonical_name" ? "canonicalName" : field]]));
    return rns.map((r) => by.get(r) ?? r.split("/").pop()!);
  } catch {
    return rns.map((r) => r.split("/").pop()!);
  }
}

/**
 * A pause or enable: one status update, skipped when the target is already in place, whose inverse is
 * the opposite change.
 */
function toggle<P extends Change["type"], E extends Change["type"]>(
  change: Change, pause: P, enable: E, make: (type: P | E) => Change,
  o: { service: ResolvedChange["service"]; before: string; resourceName: string; what: string; context?: string; warn?: string },
): ResolvedChange {
  const pausing = change.type === pause;
  const target = pausing ? "PAUSED" : "ENABLED";
  const same = o.before === target;
  return {
    change,
    service: o.service,
    operations: same ? [] : [{ update: { resourceName: o.resourceName, status: target }, updateMask: "status" }],
    describe: `${pausing ? "Pause" : "Enable"} ${o.what} (${o.context ? `${o.context}; ` : ""}now ${o.before})${o.warn ?? ""}`,
    inverse: same ? undefined : make(pausing ? enable : pause),
  };
}

/** Inverse of an applied change, given the resource names the API returned. */
export function inverseAfterApply(r: ResolvedChange, resourceNames: string[]): Change | undefined {
  const c = r.change;
  const of = (collection: string) => resourceNames.filter((n) => n.includes(`/${collection}/`));
  if (c.type === "add_negative_keywords" && resourceNames.length) {
    return { type: "remove_negative_keywords", campaign_id: c.campaign_id, resource_names: resourceNames };
  }
  // Undo of a build removes the top of what was built; Google removes what hangs off it.
  if ((c.type === "create_campaign" || c.type === "create_display_campaign" || c.type === "create_demand_gen_campaign" || c.type === "create_performance_max_campaign") && of("campaigns")[0]) return { type: "remove_campaign", resource_name: of("campaigns")[0]!, name: c.name };
  if (c.type === "add_ad_group" && of("adGroups")[0]) return { type: "remove_ad_group", resource_name: of("adGroups")[0]!, name: c.ad_group.name };
  if (c.type === "add_keywords" && resourceNames.length) {
    return { type: "remove_keywords", resource_names: resourceNames, what: `${resourceNames.length} keyword(s) Camberstack added: ${c.keywords.map((k) => fmtKw(k.text, k.match_type)).join(", ")}` };
  }
  if (c.type === "add_responsive_search_ad" && resourceNames[0]) {
    return { type: "remove_ad", resource_name: resourceNames[0], what: `the responsive search ad Camberstack added (→ ${c.ad.final_url})` };
  }
  if (c.type === "add_campaign_targeting" && resourceNames.length) {
    return { type: "remove_campaign_criteria", campaign_id: c.campaign_id, resource_names: resourceNames, what: `${resourceNames.length} targeting criteria Camberstack added` };
  }
  if (c.type === "create_conversion_action" && resourceNames[0]) return { type: "remove_conversion_action", resource_name: resourceNames[0], name: c.name };
  if (c.type === "create_shared_bid_strategy" && of("biddingStrategies")[0] && r.inverse?.type === "remove_shared_bid_strategy") {
    return { ...r.inverse, resource_name: of("biddingStrategies")[0]! };
  }
  if (c.type === "add_sitelinks" && of("campaignAssets").length) {
    return { type: "remove_campaign_assets", resource_names: of("campaignAssets"), what: `${c.sitelinks.length} sitelink(s) Camberstack added: ${c.sitelinks.map((x) => `"${x.text}"`).join(", ")}` };
  }
  return r.inverse;
}

function fmtKw(text: string, matchType: string): string {
  return matchType === "EXACT" ? `[${text}]` : matchType === "PHRASE" ? `"${text}"` : text;
}

export function summarize(resolved: { operations: unknown[]; describe: string }[]): string {
  return resolved.filter((r) => r.operations.length)
    .map((r, i) => `${i + 1}. ${r.describe}`).join("\n");
}

/**
 * Do two summaries describe the same writes? Apply's drift check (session.ts) compares the summary the user approved with
 * the same changes re-resolved now. A proposal stores keyword changes with the duplicates already dropped, so the
 * "(n already present or repeated, skipped)" note is about the request, not the account, and is left out; the count before
 * it stays, so keywords that appeared in the account meanwhile still read as a change.
 */
export function sameSummary(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/ \(\d+ already present or repeated, skipped\)/g, "");
  return norm(a) === norm(b);
}
