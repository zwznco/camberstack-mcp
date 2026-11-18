/**
 * Read tools for what users asked run_gaql for most (gap audit, ~/scripts/gap-audit, prod 2026-10-19 → 11-18): 52% of all
 * calls were run_gaql, and the top clusters by distinct users were a campaign's settings and targeting (63), conversion
 * actions and which recorded (72), ads (55), search terms (51), keywords (48). Each tool returns what those users' own
 * queries selected, in one call, with names instead of resource ids. Every query here was run against a real account
 * (2026-11-18) and only uses resources the demo answers (demo.ts), so the demo works unchanged.
 *
 * Each function takes `read` (the account's GAQL search) and returns plain JSON; session.ts adds the account head.
 */
import { micros } from "./google.js";

export type Read = (query: string) => Promise<any[]>;

const round = (n: number) => Math.round(n * 100) / 100;
const pctOf = (v: unknown) => (v == null ? null : round(Number(v) * 100));
const DAY = 86400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
/** The window ending yesterday (today is partial), as account_overview reads it. */
export function dateRange(days: number): string {
  const d = Math.max(1, Math.min(365, Math.floor(days)));
  const end = Date.now() - DAY;
  return `segments.date BETWEEN '${isoDay(end - (d - 1) * DAY)}' AND '${isoDay(end)}'`;
}
const digits = (s: string) => {
  if (!/^\d+$/.test(s)) throw new Error(`"${s}" isn't an id: give the digits only.`);
  return s;
};

type Totals = { cost: number; clicks: number; impressions: number; conversions: number; conversion_value: number };
const zero = (): Totals => ({ cost: 0, clicks: 0, impressions: 0, conversions: 0, conversion_value: 0 });
function addMetrics(t: Totals, m: any) {
  t.cost += micros(m?.costMicros);
  t.clicks += Number(m?.clicks ?? 0);
  t.impressions += Number(m?.impressions ?? 0);
  t.conversions += Number(m?.conversions ?? 0);
  t.conversion_value += Number(m?.conversionsValue ?? 0);
}
const done = (t: Totals) => ({
  cost: round(t.cost), clicks: t.clicks, impressions: t.impressions, conversions: round(t.conversions),
  ...(t.conversion_value ? { conversion_value: round(t.conversion_value) } : {}),
  ...(t.conversions > 0 ? { cost_per_conversion: round(t.cost / t.conversions) } : {}),
  ...(t.impressions > 0 ? { ctr: round((100 * t.clicks) / t.impressions) } : {}),
});

/** Display names for geo and language constants, by resource name; a failed lookup leaves the id. */
async function constantNames(read: Read, resource: "geo_target_constant" | "language_constant", rns: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!rns.length) return out;
  const field = resource === "geo_target_constant" ? "canonical_name" : "name";
  try {
    const rows = await read(`SELECT ${resource}.resource_name, ${resource}.${field} FROM ${resource}
      WHERE ${resource}.resource_name IN (${[...new Set(rns)].map((r) => `'${r}'`).join(", ")})`);
    for (const r of rows) {
      const x = resource === "geo_target_constant" ? r.geoTargetConstant : r.languageConstant;
      if (x?.resourceName) out.set(x.resourceName, x.canonicalName ?? x.name);
    }
  } catch { /* ids are still an answer */ }
  return out;
}

const DAYS_OF_WEEK = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const hm = (h: unknown, m: unknown) => `${String(h ?? 0).padStart(2, "0")}:${({ ZERO: "00", FIFTEEN: "15", THIRTY: "30", FORTY_FIVE: "45" } as Record<string, string>)[String(m)] ?? "00"}`;
const NEGATIVES_SHOWN = 200;

// ---------------------------------------------------------------- campaign_details

export async function campaignDetails(read: Read, campaignId: string, days: number) {
  const id = digits(campaignId);
  const soft = (q: string) => read(q).catch(() => null);  // a failed section drops itself, never the answer
  const [settings, perf, criteria, shared, assets, goals, groups, groupPerf] = await Promise.all([
    read(`SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.primary_status_reasons, campaign.serving_status,
        campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign.bidding_strategy_type,
        campaign.target_spend.cpc_bid_ceiling_micros, campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas,
        campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas, campaign.target_impression_share.location,
        campaign.target_impression_share.location_fraction_micros, campaign.target_impression_share.cpc_bid_ceiling_micros,
        campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign.start_date_time, campaign.end_date_time,
        campaign.network_settings.target_google_search, campaign.network_settings.target_search_network,
        campaign.network_settings.target_content_network, campaign.network_settings.target_partner_search_network,
        campaign.geo_target_type_setting.positive_geo_target_type, campaign.geo_target_type_setting.negative_geo_target_type,
        campaign.tracking_url_template, campaign.final_url_suffix FROM campaign WHERE campaign.id = ${id}`),
    soft(`SELECT campaign.id, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value,
        metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
        FROM campaign WHERE campaign.id = ${id} AND ${dateRange(days)}`),
    soft(`SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.status,
        campaign_criterion.bid_modifier, campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant,
        campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, campaign_criterion.ad_schedule.day_of_week,
        campaign_criterion.ad_schedule.start_hour, campaign_criterion.ad_schedule.start_minute, campaign_criterion.ad_schedule.end_hour,
        campaign_criterion.ad_schedule.end_minute, campaign_criterion.device.type, campaign_criterion.proximity.radius,
        campaign_criterion.proximity.radius_units, campaign_criterion.proximity.address.city_name
        FROM campaign_criterion WHERE campaign.id = ${id} AND campaign_criterion.status != 'REMOVED' LIMIT 10000`),
    soft(`SELECT campaign.id, shared_set.id, shared_set.name, shared_set.type, shared_set.member_count, campaign_shared_set.status
        FROM campaign_shared_set WHERE campaign.id = ${id} AND campaign_shared_set.status = 'ENABLED'`),
    soft(`SELECT campaign.id, campaign_asset.field_type, campaign_asset.status, asset.id, asset.type, asset.final_urls,
        asset.sitelink_asset.link_text, asset.sitelink_asset.description1, asset.sitelink_asset.description2, asset.callout_asset.callout_text,
        asset.call_asset.phone_number, asset.structured_snippet_asset.header, asset.structured_snippet_asset.values,
        asset.policy_summary.approval_status FROM campaign_asset WHERE campaign.id = ${id} AND campaign_asset.status != 'REMOVED'`),
    soft(`SELECT campaign.id, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable
        FROM campaign_conversion_goal WHERE campaign.id = ${id}`),
    soft(`SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status, ad_group.primary_status, ad_group.type, ad_group.cpc_bid_micros
        FROM ad_group WHERE campaign.id = ${id} AND ad_group.status != 'REMOVED'`),
    soft(`SELECT campaign.id, ad_group.id, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value
        FROM ad_group WHERE campaign.id = ${id} AND ad_group.status != 'REMOVED' AND ${dateRange(days)}`),
  ]);
  const row = settings[0];
  if (!row) throw new Error(`Campaign ${campaignId} isn't in this account. account_overview lists its campaigns with their ids.`);
  const c = row.campaign;

  const totals = zero();
  let share: any = null;
  for (const r of perf ?? []) {
    addMetrics(totals, r.metrics);
    share ??= r.metrics;  // not segmented by date: one row for the whole window
  }

  const crit = (criteria ?? []).map((r) => r.campaignCriterion);
  const geoNames = await constantNames(read, "geo_target_constant", crit.filter((x) => x.location?.geoTargetConstant).map((x) => x.location.geoTargetConstant));
  const langNames = await constantNames(read, "language_constant", crit.filter((x) => x.language?.languageConstant).map((x) => x.language.languageConstant));
  const locations = crit.filter((x) => x.type === "LOCATION").map((x) => ({
    id: String(x.location.geoTargetConstant).split("/").pop(), name: geoNames.get(x.location.geoTargetConstant) ?? null,
    ...(x.negative ? { excluded: true } : {}), ...(x.bidModifier && x.bidModifier !== 1 ? { bid_adjustment: x.bidModifier } : {}),
  }));
  const radius = crit.filter((x) => x.type === "PROXIMITY").map((x) => ({
    radius: x.proximity?.radius, units: x.proximity?.radiusUnits, around: x.proximity?.address?.cityName ?? null, ...(x.negative ? { excluded: true } : {}),
  }));
  const negatives = crit.filter((x) => x.type === "KEYWORD" && x.negative)
    .map((x) => ({ text: x.keyword?.text, match_type: x.keyword?.matchType, criterion_id: String(x.criterionId) }));
  const schedule = crit.filter((x) => x.type === "AD_SCHEDULE").map((x) => ({
    day: x.adSchedule?.dayOfWeek, from: hm(x.adSchedule?.startHour, x.adSchedule?.startMinute), to: hm(x.adSchedule?.endHour, x.adSchedule?.endMinute),
    ...(x.bidModifier && x.bidModifier !== 1 ? { bid_adjustment: x.bidModifier } : {}),
  })).sort((a, b) => DAYS_OF_WEEK.indexOf(a.day) - DAYS_OF_WEEK.indexOf(b.day) || a.from.localeCompare(b.from));
  const devices = crit.filter((x) => x.type === "DEVICE" && x.bidModifier != null && x.bidModifier !== 1)
    .map((x) => ({ device: x.device?.type, bid_adjustment: x.bidModifier }));

  const byGroup = new Map<string, Totals>();
  for (const r of groupPerf ?? []) {
    const k = String(r.adGroup.id);
    const t = byGroup.get(k) ?? zero();
    addMetrics(t, r.metrics);
    byGroup.set(k, t);
  }

  const assetRows = (assets ?? []).map((r) => {
    const a = r.asset ?? {};
    const text = a.sitelinkAsset?.linkText ?? a.calloutAsset?.calloutText ?? a.callAsset?.phoneNumber
      ?? (a.structuredSnippetAsset ? `${a.structuredSnippetAsset.header}: ${(a.structuredSnippetAsset.values ?? []).join(", ")}` : null);
    return {
      field: r.campaignAsset?.fieldType, asset_id: String(a.id), ...(text ? { text } : { type: a.type }),
      ...(a.sitelinkAsset?.description1 ? { description: [a.sitelinkAsset.description1, a.sitelinkAsset.description2].filter(Boolean).join(" / ") } : {}),
      ...(a.finalUrls?.[0] ? { url: a.finalUrls[0] } : {}),
      ...(r.campaignAsset?.status !== "ENABLED" ? { status: r.campaignAsset?.status } : {}),
      ...(a.policySummary?.approvalStatus && a.policySummary.approvalStatus !== "APPROVED" ? { approval: a.policySummary.approvalStatus } : {}),
    };
  });

  const bidding: Record<string, unknown> = { strategy: c.biddingStrategyType };
  const cap = c.targetSpend?.cpcBidCeilingMicros ?? c.targetImpressionShare?.cpcBidCeilingMicros;
  if (cap) bidding.max_cpc_ceiling = micros(cap);
  const cpa = c.maximizeConversions?.targetCpaMicros ?? c.targetCpa?.targetCpaMicros;
  if (cpa && Number(cpa) > 0) bidding.target_cpa = micros(cpa);
  const roas = c.maximizeConversionValue?.targetRoas ?? c.targetRoas?.targetRoas;
  if (roas) bidding.target_roas = roas;
  if (c.targetImpressionShare?.location) {
    bidding.target_impression_share = { where: c.targetImpressionShare.location, percent: Number(c.targetImpressionShare.locationFractionMicros ?? 0) / 10_000 };
  }

  return {
    window: `last ${days} days`,
    campaign: {
      campaign_id: String(c.id), name: c.name, status: c.status, primary_status: c.primaryStatus,
      ...(c.primaryStatusReasons?.length ? { status_reasons: c.primaryStatusReasons.filter((x: string) => x !== "UNKNOWN") } : {}),
      type: c.advertisingChannelType, ...(c.advertisingChannelSubType && c.advertisingChannelSubType !== "UNKNOWN" ? { sub_type: c.advertisingChannelSubType } : {}),
      daily_budget: micros(row.campaignBudget?.amountMicros), ...(row.campaignBudget?.explicitlyShared ? { budget_shared: true } : {}),
      bidding,
      start: c.startDateTime ?? null, end: c.endDateTime ?? null,
      networks: {
        google_search: !!c.networkSettings?.targetGoogleSearch, search_partners: !!c.networkSettings?.targetSearchNetwork,
        display: !!c.networkSettings?.targetContentNetwork,
      },
      location_mode: c.geoTargetTypeSetting?.positiveGeoTargetType === "PRESENCE" ? "people in the locations only" : "people in or interested in the locations",
      ...(c.trackingUrlTemplate ? { tracking_template: c.trackingUrlTemplate } : {}),
      ...(c.finalUrlSuffix ? { final_url_suffix: c.finalUrlSuffix } : {}),
    },
    performance: {
      ...done(totals),
      ...(share?.searchImpressionShare != null ? {
        search_impression_share: pctOf(share.searchImpressionShare),
        lost_to_budget: pctOf(share.searchBudgetLostImpressionShare), lost_to_rank: pctOf(share.searchRankLostImpressionShare),
      } : {}),
    },
    targeting: criteria == null ? { unavailable: "Google didn't return this campaign's targeting; try again." } : {
      locations: locations.length ? locations : "none set: shows everywhere",
      ...(radius.length ? { radius } : {}),
      languages: crit.filter((x) => x.type === "LANGUAGE").map((x) => langNames.get(x.language.languageConstant) ?? String(x.language.languageConstant).split("/").pop()),
      ...(schedule.length ? { ad_schedule: schedule } : {}),
      ...(devices.length ? { device_bid_adjustments: devices } : {}),
    },
    negative_keywords: {
      count: negatives.length, ...(negatives.length > NEGATIVES_SHOWN ? { shown: NEGATIVES_SHOWN } : {}),
      keywords: negatives.slice(0, NEGATIVES_SHOWN),
      shared_lists: (shared ?? []).map((r) => ({ id: String(r.sharedSet.id), name: r.sharedSet.name, type: r.sharedSet.type, keywords: Number(r.sharedSet.memberCount ?? 0) })),
    },
    assets: assetRows,
    conversion_goals: (goals ?? []).map((r) => ({
      category: r.campaignConversionGoal.category, origin: r.campaignConversionGoal.origin, bids_on_it: !!r.campaignConversionGoal.biddable,
    })),
    ad_groups: (groups ?? []).map((r) => ({
      ad_group_id: String(r.adGroup.id), name: r.adGroup.name, status: r.adGroup.status, primary_status: r.adGroup.primaryStatus,
      ...(r.adGroup.cpcBidMicros && Number(r.adGroup.cpcBidMicros) > 10_000 ? { max_cpc: micros(r.adGroup.cpcBidMicros) } : {}),
      ...done(byGroup.get(String(r.adGroup.id)) ?? zero()),
    })).sort((a, b) => b.cost - a.cost),
    note: "Assets listed are the campaign's own; account-level assets also show with its ads. Impression shares are percents for the window.",
  };
}

// ---------------------------------------------------------------- conversion_tracking

export async function conversionTracking(read: Read, days: number, demo: boolean) {
  const soft = (q: string) => read(q).catch(() => null);
  const [account, actions, counts, goals] = await Promise.all([
    soft(`SELECT customer.auto_tagging_enabled, customer.conversion_tracking_setting.conversion_tracking_status,
        customer.conversion_tracking_setting.google_ads_conversion_customer, customer.conversion_tracking_setting.accepted_customer_data_terms,
        customer.call_reporting_setting.call_reporting_enabled, customer.call_reporting_setting.call_conversion_reporting_enabled FROM customer`),
    read(`SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category,
        conversion_action.origin, conversion_action.primary_for_goal, conversion_action.counting_type, conversion_action.include_in_conversions_metric,
        conversion_action.value_settings.default_value, conversion_action.value_settings.always_use_default_value,
        conversion_action.click_through_lookback_window_days, conversion_action.attribution_model_settings.attribution_model,
        conversion_action.phone_call_duration_seconds, conversion_action.google_analytics_4_settings.event_name,
        conversion_action.google_analytics_4_settings.property_id, metrics.conversion_last_conversion_date
        FROM conversion_action WHERE conversion_action.status != 'REMOVED'`),
    // The demo has no per-action counts: say so rather than show zeros.
    demo ? Promise.resolve(null) : soft(`SELECT segments.conversion_action, metrics.conversions, metrics.all_conversions, metrics.conversions_value
        FROM customer WHERE ${dateRange(days)}`),
    soft(`SELECT customer_conversion_goal.category, customer_conversion_goal.origin, customer_conversion_goal.biddable FROM customer_conversion_goal`),
  ]);
  const byAction = new Map<string, { conversions: number; all: number; value: number }>();
  for (const r of counts ?? []) {
    const id = String(r.segments?.conversionAction ?? "").split("/").pop()!;
    const e = byAction.get(id) ?? { conversions: 0, all: 0, value: 0 };
    e.conversions += Number(r.metrics?.conversions ?? 0);
    e.all += Number(r.metrics?.allConversions ?? 0);
    e.value += Number(r.metrics?.conversionsValue ?? 0);
    byAction.set(id, e);
  }
  const list = actions.map((r) => {
    const a = r.conversionAction;
    const n = byAction.get(String(a.id));
    const ga4 = a.googleAnalytics4Settings;
    return {
      id: String(a.id), name: a.name, status: a.status, type: a.type, category: a.category, origin: a.origin,
      primary: !!a.primaryForGoal, counted_in_conversions: !!a.includeInConversionsMetric, counting: a.countingType,
      ...(counts ? { conversions: round(n?.conversions ?? 0), all_conversions: round(n?.all ?? 0), ...(n?.value ? { value: round(n.value) } : {}) } : {}),
      last_conversion: r.metrics?.conversionLastConversionDate ?? null,
      default_value: a.valueSettings?.defaultValue ?? null, ...(a.valueSettings?.alwaysUseDefaultValue ? { always_default_value: true } : {}),
      click_lookback_days: a.clickThroughLookbackWindowDays != null ? Number(a.clickThroughLookbackWindowDays) : null,
      attribution: a.attributionModelSettings?.attributionModel ?? null,
      ...(/CALL/.test(String(a.type)) && a.phoneCallDurationSeconds ? { min_call_seconds: Number(a.phoneCallDurationSeconds) } : {}),
      ...(ga4?.eventName ? { ga4_event: ga4.eventName, ga4_property: ga4.propertyId ? String(ga4.propertyId) : null } : {}),
    };
  }).sort((x, y) => Number(y.primary) - Number(x.primary) || (y.all_conversions ?? 0) - (x.all_conversions ?? 0));

  const c = account?.[0]?.customer;
  const watch: string[] = [];
  if (c && c.autoTaggingEnabled === false) watch.push("Auto-tagging is off: Google Analytics and offline imports can't tie visits to ad clicks.");
  if (!list.some((a) => a.primary && a.status === "ENABLED")) watch.push("No enabled primary conversion action: bidding has nothing to optimize for.");
  if (counts) for (const a of list) {
    if (a.primary && a.status === "ENABLED" && !a.all_conversions) watch.push(`Primary action "${a.name}" recorded nothing in the window${a.last_conversion ? ` (last ${a.last_conversion})` : " and has never recorded"}.`);
  }
  return {
    window: `last ${days} days`,
    ...(c ? { account: {
      auto_tagging: !!c.autoTaggingEnabled, tracking_status: c.conversionTrackingSetting?.conversionTrackingStatus ?? null,
      ...(c.conversionTrackingSetting?.googleAdsConversionCustomer ? { conversions_owned_by: String(c.conversionTrackingSetting.googleAdsConversionCustomer).split("/").pop() } : {}),
      customer_data_terms_accepted: !!c.conversionTrackingSetting?.acceptedCustomerDataTerms,
      call_reporting: !!c.callReportingSetting?.callReportingEnabled,
    } } : {}),
    ...(watch.length ? { watch } : {}),
    actions: list,
    account_goals: (goals ?? []).map((r) => ({ category: r.customerConversionGoal.category, origin: r.customerConversionGoal.origin, bids_on_it: !!r.customerConversionGoal.biddable })),
    note: (counts ? "conversions: counted in the Conversions column (primary actions); all_conversions: every action, by click date. " : "Per-action counts aren't in the demo's sample data. ")
      + "Tag snippets are left out: tag_manager_setup shows what a site's tags send.",
  };
}

// ---------------------------------------------------------------- search_terms_report

const TERM_ROWS = 100;
export async function searchTerms(read: Read, o: { campaign_id?: string; ad_group_id?: string; days: number; limit?: number }) {
  const where = [dateRange(o.days), ...(o.campaign_id ? [`campaign.id = ${digits(o.campaign_id)}`] : []), ...(o.ad_group_id ? [`ad_group.id = ${digits(o.ad_group_id)}`] : [])];
  const rows = await read(`SELECT search_term_view.search_term, search_term_view.status, campaign.id, campaign.name, ad_group.id, ad_group.name,
      segments.keyword.info.text, segments.keyword.info.match_type, metrics.impressions, metrics.clicks, metrics.cost_micros,
      metrics.conversions, metrics.conversions_value FROM search_term_view WHERE ${where.join(" AND ")}
      ORDER BY metrics.cost_micros DESC LIMIT 10000`);
  // One row per term, ad group and matching keyword: merged per term and ad group.
  const m = new Map<string, { t: Totals; term: string; status: string; campaign: string; campaign_id: string; ad_group: string; ad_group_id: string; keywords: Set<string> }>();
  for (const r of rows) {
    const k = `${r.adGroup?.id}|${r.searchTermView?.searchTerm}`;
    const e = m.get(k) ?? { t: zero(), term: r.searchTermView?.searchTerm, status: r.searchTermView?.status, campaign: r.campaign?.name,
      campaign_id: String(r.campaign?.id), ad_group: r.adGroup?.name, ad_group_id: String(r.adGroup?.id), keywords: new Set<string>() };
    addMetrics(e.t, r.metrics);
    const kw = r.segments?.keyword?.info;
    if (kw?.text) e.keywords.add(`${kw.text} (${String(kw.matchType ?? "").toLowerCase()})`);
    m.set(k, e);
  }
  const all = [...m.values()].sort((a, b) => b.t.cost - a.t.cost);
  const total = zero();
  for (const e of all) { total.cost += e.t.cost; total.clicks += e.t.clicks; total.impressions += e.t.impressions; total.conversions += e.t.conversions; total.conversion_value += e.t.conversion_value; }
  const noConv = all.filter((e) => e.t.conversions === 0 && e.t.cost > 0);
  const limit = Math.min(o.limit ?? TERM_ROWS, 500);
  return {
    window: `last ${o.days} days`,
    totals: { terms: all.length, ...done(total), cost_without_conversions: round(noConv.reduce((s, e) => s + e.t.cost, 0)), terms_without_conversions: noConv.length },
    ...(all.length > limit ? { shown: `top ${limit} by cost of ${all.length}` } : {}),
    terms: all.slice(0, limit).map((e) => ({
      term: e.term, ...(e.status && e.status !== "NONE" ? { status: e.status.toLowerCase() } : {}),
      campaign: e.campaign, campaign_id: e.campaign_id, ad_group: e.ad_group, ad_group_id: e.ad_group_id,
      ...(e.keywords.size ? { matched_keywords: [...e.keywords] } : {}), ...done(e.t),
    })),
    note: "status added/excluded: the term is already a keyword or a negative. Performance Max terms aren't in this report "
      + "(Google reports them only as categories). To block terms, propose add_negative_keywords.",
  };
}

// ---------------------------------------------------------------- ads_report

const ADS_SHOWN = 50;
const assetText = (xs: any[] | undefined) => (xs ?? []).map((h) => ({
  text: h.text, ...(h.pinnedField ? { pinned: h.pinnedField } : {}),
  ...(h.assetPerformanceLabel && !["PENDING", "UNKNOWN", "UNSPECIFIED"].includes(h.assetPerformanceLabel) ? { performance: h.assetPerformanceLabel } : {}),
  ...(h.policySummaryInfo?.approvalStatus && h.policySummaryInfo.approvalStatus !== "APPROVED" ? { approval: h.policySummaryInfo.approvalStatus } : {}),
}));

export async function adsReport(read: Read, o: { campaign_id?: string; ad_group_id?: string; days: number; include_paused?: boolean; limit?: number }) {
  const shown = Math.min(o.limit ?? ADS_SHOWN, 200);
  const filter = [...(o.campaign_id ? [`campaign.id = ${digits(o.campaign_id)}`] : []), ...(o.ad_group_id ? [`ad_group.id = ${digits(o.ad_group_id)}`] : []),
    o.include_paused ? "ad_group_ad.status != 'REMOVED'" : "ad_group_ad.status = 'ENABLED'", "campaign.status != 'REMOVED'", "ad_group.status != 'REMOVED'"];
  const [ads, perf] = await Promise.all([
    read(`SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status,
        ad_group_ad.primary_status, ad_group_ad.primary_status_reasons, ad_group_ad.ad_strength, ad_group_ad.policy_summary.approval_status,
        ad_group_ad.policy_summary.review_status, ad_group_ad.policy_summary.policy_topic_entries, ad_group_ad.ad.final_urls,
        ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
        ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2
        FROM ad_group_ad WHERE ${filter.join(" AND ")} LIMIT 5000`),
    read(`SELECT ad_group.id, ad_group_ad.ad.id, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value
        FROM ad_group_ad WHERE ${[...filter, dateRange(o.days)].join(" AND ")} LIMIT 10000`).catch(() => []),
  ]);
  const byAd = new Map<string, Totals>();
  for (const r of perf) {
    const k = `${r.adGroup?.id}~${r.adGroupAd?.ad?.id}`;
    const t = byAd.get(k) ?? zero();
    addMetrics(t, r.metrics);
    byAd.set(k, t);
  }
  const list = ads.map((r) => {
    const x = r.adGroupAd, ad = x.ad ?? {}, rsa = ad.responsiveSearchAd;
    const t = byAd.get(`${r.adGroup?.id}~${ad.id}`) ?? zero();
    const topics = (x.policySummary?.policyTopicEntries ?? []).map((p: any) => `${p.topic}${p.type ? ` (${String(p.type).toLowerCase()})` : ""}`);
    return {
      ad_id: String(ad.id), ad_group_id: String(r.adGroup?.id), ad_group: r.adGroup?.name, campaign: r.campaign?.name, campaign_id: String(r.campaign?.id),
      type: ad.type, status: x.status, primary_status: x.primaryStatus,
      ...(x.primaryStatusReasons?.length ? { status_reasons: x.primaryStatusReasons.filter((s: string) => s !== "UNKNOWN") } : {}),
      approval: x.policySummary?.approvalStatus ?? null, ...(topics.length ? { policy: topics } : {}),
      ...(x.adStrength && !["UNSPECIFIED", "UNKNOWN"].includes(x.adStrength) ? { ad_strength: x.adStrength } : {}),
      final_url: ad.finalUrls?.[0] ?? null,
      ...(rsa ? { headlines: assetText(rsa.headlines), descriptions: assetText(rsa.descriptions),
        ...(rsa.path1 ? { path: [rsa.path1, rsa.path2].filter(Boolean).join("/") } : {}) } : {}),
      ...done(t),
    };
  }).sort((a, b) => b.cost - a.cost);
  return {
    window: `last ${o.days} days`,
    ...(list.length > shown ? { shown: `top ${shown} by cost of ${list.length}: pass campaign_id, ad_group_id or a higher limit for the rest` } : {}),
    ads: list.slice(0, shown),
    ...(list.length ? {} : { none: o.include_paused ? "No ads here." : "No enabled ads here; include_paused lists paused ones too." }),
    note: "Performance Max and Smart campaigns build ads from assets, not ads: they don't list here.",
  };
}

// ---------------------------------------------------------------- keywords_report

const KEYWORDS_SHOWN = 100;
export async function keywordsReport(read: Read, o: { campaign_id?: string; ad_group_id?: string; days: number; include_paused?: boolean; limit?: number }) {
  const shown = Math.min(o.limit ?? KEYWORDS_SHOWN, 500);
  const scope = [...(o.campaign_id ? [`campaign.id = ${digits(o.campaign_id)}`] : []), ...(o.ad_group_id ? [`ad_group.id = ${digits(o.ad_group_id)}`] : []),
    "campaign.status != 'REMOVED'", "ad_group.status != 'REMOVED'"];
  const [kws, perf] = await Promise.all([
    read(`SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type, ad_group_criterion.negative, ad_group_criterion.status, ad_group_criterion.primary_status,
        ad_group_criterion.primary_status_reasons, ad_group_criterion.approval_status, ad_group_criterion.cpc_bid_micros,
        ad_group_criterion.effective_cpc_bid_micros, ad_group_criterion.final_urls, ad_group_criterion.quality_info.quality_score,
        ad_group_criterion.quality_info.creative_quality_score, ad_group_criterion.quality_info.post_click_quality_score,
        ad_group_criterion.quality_info.search_predicted_ctr FROM ad_group_criterion
        WHERE ${[...scope, "ad_group_criterion.type = 'KEYWORD'", o.include_paused ? "ad_group_criterion.status != 'REMOVED'" : "ad_group_criterion.status = 'ENABLED'"].join(" AND ")} LIMIT 10000`),
    read(`SELECT ad_group.id, ad_group_criterion.criterion_id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions,
        metrics.conversions_value FROM keyword_view WHERE ${[...scope, dateRange(o.days)].join(" AND ")} LIMIT 10000`).catch(() => []),
  ]);
  const byKw = new Map<string, Totals>();
  for (const r of perf) {
    const k = `${r.adGroup?.id}~${r.adGroupCriterion?.criterionId}`;
    const t = byKw.get(k) ?? zero();
    addMetrics(t, r.metrics);
    byKw.set(k, t);
  }
  const score = (s: unknown) => (s && !["UNSPECIFIED", "UNKNOWN"].includes(String(s)) ? String(s).toLowerCase() : undefined);
  const positive = [], negative = [];
  for (const r of kws) {
    const k = r.adGroupCriterion;
    const base = { text: k.keyword?.text, match_type: k.keyword?.matchType, criterion_id: String(k.criterionId), ad_group_id: String(r.adGroup?.id),
      ad_group: r.adGroup?.name, campaign: r.campaign?.name, campaign_id: String(r.campaign?.id) };
    if (k.negative) { negative.push(base); continue; }
    const q = k.qualityInfo ?? {};
    positive.push({
      ...base, status: k.status, primary_status: k.primaryStatus,
      ...(k.primaryStatusReasons?.length ? { status_reasons: k.primaryStatusReasons.filter((s: string) => s !== "UNKNOWN") } : {}),
      ...(k.approvalStatus && k.approvalStatus !== "APPROVED" ? { approval: k.approvalStatus } : {}),
      ...(q.qualityScore ? { quality_score: q.qualityScore, expected_ctr: score(q.searchPredictedCtr), ad_relevance: score(q.creativeQualityScore),
        landing_page: score(q.postClickQualityScore) } : {}),
      ...(k.cpcBidMicros ? { max_cpc: micros(k.cpcBidMicros) } : {}),
      ...(k.finalUrls?.[0] ? { final_url: k.finalUrls[0] } : {}),
      ...done(byKw.get(`${r.adGroup?.id}~${k.criterionId}`) ?? zero()),
    });
  }
  positive.sort((a, b) => b.cost - a.cost || b.impressions - a.impressions);
  return {
    window: `last ${o.days} days`,
    ...(positive.length > shown ? { shown: `top ${shown} by cost of ${positive.length}: pass campaign_id, ad_group_id or a higher limit for the rest` } : {}),
    keywords: positive.slice(0, shown),
    ad_group_negatives: negative.slice(0, NEGATIVES_SHOWN), ...(negative.length > NEGATIVES_SHOWN ? { ad_group_negatives_count: negative.length } : {}),
    note: "quality_score is Google's 1-10, with its three parts (below_average / average / above_average). Campaign-level negatives and "
      + "shared lists are in campaign_details.",
  };
}
