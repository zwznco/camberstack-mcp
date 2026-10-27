/**
 * Google OAuth (the user's consent to Google Ads access) and a thin Google Ads REST client.
 *
 * Scopes requested: `adwords` (the Ads API, required), `webmasters.readonly` (Search Console, read-only and
 * optional: the user can untick it and the Ads tools still work) and `openid email` (to know who the user
 * is, so a reconnect finds the same account and change log). Nothing else from the Google account is touched.
 */

export const ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
export const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
/** Google Analytics (GA4): reports, and setup changes (properties, key events, Google Ads links). Not in the main consent: asked
 *  for together, separately, when a GA4 tool first needs them (ga4.ts). */
export const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
export const ANALYTICS_EDIT_SCOPE = "https://www.googleapis.com/auth/analytics.edit";
const GOOGLE_SCOPES = ["openid", "email", ADS_SCOPE, SEARCH_CONSOLE_SCOPE];
export const ADS_API = "https://googleads.googleapis.com/v23";

/** The Ads API counts money in millionths of the account currency. */
export const micros = (m: unknown) => Number(m ?? 0) / 1_000_000;
export const toMicros = (x: number) => String(Math.round(x * 1_000_000));

export interface GoogleCreds {
  clientId: string;
  clientSecret: string;
  developerToken?: string;
}

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

/** `extraScopes`: more services asked at sign-in (Google Analytics); each stays an untickable box. */
export function googleAuthUrl(creds: GoogleCreds, redirectUri: string, state: string, extraScopes: readonly string[] = []): string {
  return `${GOOGLE_AUTH}?${new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [...GOOGLE_SCOPES, ...extraScopes].join(" "),
    access_type: "offline",
    // Always show consent so Google always returns a refresh token, including on reconnect.
    prompt: "consent",
    // Keeps scopes granted separately (Google Analytics) on the new token when someone reconnects.
    include_granted_scopes: "true",
    state,
  })}`;
}

/**
 * The Google services a user grants one by one ("à la carte"): any of them at sign-in, or each later through a personal
 * /connect/<kind> link (grant.ts) when a tool first needs it. `scopes[0]` is the one that must come back granted.
 */
export const GRANTS = {
  "google-ads": { label: "Google Ads", scopes: [ADS_SCOPE] },
  "search-console": { label: "Search Console", scopes: [SEARCH_CONSOLE_SCOPE] },
  "analytics": { label: "Google Analytics", scopes: [ANALYTICS_SCOPE, ANALYTICS_EDIT_SCOPE] },
} as const;
export type GrantKind = keyof typeof GRANTS;

/**
 * Add one service to an existing connection (incremental authorization): Google returns a refresh token covering
 * everything granted before plus this. openid email so the callback can check it's the same Google account.
 */
export function googleGrantUrl(creds: GoogleCreds, redirectUri: string, state: string, kind: GrantKind, loginHint: string): string {
  return `${GOOGLE_AUTH}?${new URLSearchParams({
    client_id: creds.clientId, redirect_uri: redirectUri, response_type: "code",
    scope: ["openid", "email", ...GRANTS[kind].scopes].join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true",
    login_hint: loginHint, state,
  })}`;
}

/** Google's answer when the token lacks the scope a call needs. */
export const scopeMissing = (status: number, body: string) =>
  status === 403 && /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(body);

/** A tool needs a Google service this connection doesn't have yet; `link` adds it (personal, 7 days). */
export class NotGrantedError extends Error {
  constructor(readonly kind: GrantKind, readonly link: string | null, edit = false) {
    const { label } = GRANTS[kind];
    super(`${edit ? `Changing ${label} needs its edit access, which this connection doesn't have (the box was unticked on Google's consent screen).`
      : `${label} access isn't part of this Google connection yet.`} `
      + (link ? `The user adds it here (a personal link, valid 7 days): ${link} . ` : "")
      + "The other Google tools keep working either way.");
  }
}

/** Identity only (openid email), no Ads access and no refresh token: the operator's /admin sign-in. */
export function googleSignInUrl(creds: GoogleCreds, redirectUri: string, state: string): string {
  return `${GOOGLE_AUTH}?${new URLSearchParams({
    client_id: creds.clientId, redirect_uri: redirectUri, response_type: "code",
    scope: "openid email", prompt: "select_account", state,
  })}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
}

type FetchLike = typeof fetch;

const postForm = (f: FetchLike, url: string, form: Record<string, string>) =>
  f(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });

export async function exchangeGoogleCode(
  creds: GoogleCreds, code: string, redirectUri: string, f: FetchLike = fetch,
): Promise<GoogleTokenResponse> {
  const res = await postForm(f, GOOGLE_TOKEN, {
    code, client_id: creds.clientId, client_secret: creds.clientSecret,
    redirect_uri: redirectUri, grant_type: "authorization_code",
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as GoogleTokenResponse;
}

export async function refreshGoogleToken(
  creds: Pick<GoogleCreds, "clientId" | "clientSecret">, refreshToken: string, f: FetchLike = fetch,
): Promise<{ access_token: string; expires_in: number; scope?: string }> {
  const res = await postForm(f, GOOGLE_TOKEN, {
    refresh_token: refreshToken, client_id: creds.clientId, client_secret: creds.clientSecret,
    grant_type: "refresh_token",
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Google token refresh failed: ${res.status} ${body}`);
    if (body.includes("invalid_grant")) (err as Error & { revoked?: boolean }).revoked = true;
    throw err;
  }
  return (await res.json()) as { access_token: string; expires_in: number; scope?: string };
}

export async function revokeGoogleToken(token: string, f: FetchLike = fetch): Promise<void> {
  await postForm(f, "https://oauth2.googleapis.com/revoke", { token }).catch(() => undefined);
}

/**
 * The id_token arrives directly from Google's token endpoint over TLS, in exchange for a code plus our
 * client secret, so its claims can be read without verifying the signature (OpenID Connect Core
 * §3.1.3.7, item 6).
 */
export function idTokenClaims(idToken: string): { sub: string; email: string; emailVerified: boolean } {
  const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
  if (!payload.sub || !payload.email) throw new Error("id_token missing sub/email");
  return { sub: String(payload.sub), email: String(payload.email).toLowerCase(), emailVerified: payload.email_verified === true };
}

const DURING_LITERALS = "TODAY, YESTERDAY, LAST_7_DAYS, LAST_14_DAYS, LAST_30_DAYS, THIS_MONTH, LAST_MONTH, LAST_BUSINESS_WEEK, "
  + "THIS_WEEK_MON_TODAY, THIS_WEEK_SUN_TODAY, LAST_WEEK_MON_SUN, LAST_WEEK_SUN_SAT";

/**
 * How to fix the GAQL and request errors AIs actually hit (tool_calls.error), appended to Google's message.
 * The rules are in run_gaql's description too, but a fix next to the error gets the retry right first time.
 * A wrong field, resource, segment, metric or enum value gets no generic fix here: run_gaql adds what Google's field
 * catalog says about the query (gaql.ts checkGaql), which names the real one. Only what the catalog can't know stays:
 * fields that moved or were renamed, and which resource a thing lives on. A generic guess next to the catalog's finding
 * contradicted it ("check the name" for FROM invoice, which has no such resource, 2026-10-20).
 */
const NO_OR = "GAQL has no parentheses or OR: WHERE conditions can only be joined with AND. Use field IN ('a', 'b') for alternatives, "
  + "LIKE for one pattern, or separate queries.";

function adsErrorFix(code: string, message: string, field: string): string | null {
  switch (code) {
    case "METRIC_ACCESS_DENIED":
      // Auction insights for a ChatGPT user, 2026-10-23: no query can get these, so say so instead of inviting a retry.
      return (message.includes("auction_insight")
        ? "Google gives auction insights metrics only to developer tokens it has approved for them, and Camberstack's isn't one, so no query "
          + "here can return them. The user can see competitors in Google Ads' Auction insights report; for the account's own share, "
          + "metrics.search_impression_share and metrics.search_top_impression_share work."
        : "Google restricts these metrics to developer tokens it has approved for them, and Camberstack's isn't one: drop them from the query.");
    case "EXPECTED_FILTERS_ON_DATE_RANGE":
      return "add a finite range to WHERE: segments.date DURING LAST_30_DAYS, or segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'.";
    case "CHANGE_DATE_RANGE_INFINITE":
      return "change_event needs both ends of the window, within the last 30 days, plus a LIMIT (at most 10000): WHERE change_event.change_date_time "
        + ">= 'YYYY-MM-DD' AND change_event.change_date_time <= 'YYYY-MM-DD' … LIMIT 1000. For changes made through Camberstack, use change_history.";
    case "START_DATE_TOO_OLD":
      // DURING LAST_30_DAYS on change_event, 2026-10-23: the window starts at midnight 30 days back, just past the limit.
      return "change_event reaches back 30 days to the second (change_status 90), and DURING LAST_30_DAYS starts just past that. "
        + "Start a day inside the limit with explicit dates: WHERE change_event.change_date_time >= 'YYYY-MM-DD' (29 days ago) "
        + "AND change_event.change_date_time <= 'YYYY-MM-DD' … LIMIT 1000.";
    case "MISALIGNED_DATE_FOR_FILTER":
      return "keep segments.week/month/quarter in SELECT but filter on segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD' instead: rows "
        + "still come back per week/month/quarter. (Filtering segments.week itself needs a Monday; segments.month the 1st.)";
    case "EXPECTED_FILTER_ON_A_SINGLE_DAY":
      return "click_view needs one day: segments.date = 'YYYY-MM-DD'. Query each day separately.";
    case "EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE":
      return "add that field to SELECT. Every field used in WHERE or ORDER BY must also be selected.";
    case "INVALID_VALUE_WITH_DURING_OPERATOR":
      return `DURING accepts only ${DURING_LITERALS}. For any other window use segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD'.`;
    case "PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE":
      return /impression_share/.test(message)
        ? "budget- and rank-lost impression share exist only on campaign: run a separate query FROM campaign for them."
        : null;
    case "PROHIBITED_RESOURCE_TYPE_IN_SELECT_CLAUSE":
      if (/'CAMPAIGN_BUDGET'/.test(message)) {
        return "campaign_budget fields can only be selected FROM campaign or FROM campaign_budget: drop them here and get budgets in a "
          + "separate query, e.g. SELECT campaign.id, campaign_budget.amount_micros FROM campaign.";
      }
      return null;
    case "PROHIBITED_SEGMENT_IN_SELECT_OR_WHERE_CLAUSE":
      if (/segments\.geo_target_/.test(message)) {
        return "location segments come FROM geographic_view (or user_location_view), which can also select campaign and ad_group fields: "
          + "SELECT campaign.name, segments.geo_target_city, metrics.clicks FROM geographic_view WHERE segments.date DURING LAST_30_DAYS. "
          + "They return geoTargetConstants/ID; get names with SELECT geo_target_constant.canonical_name FROM geo_target_constant "
          + "WHERE geo_target_constant.resource_name IN ('geoTargetConstants/ID', …).";
      }
      return null;
    case "BAD_ENUM_CONSTANT":
      if (/'(AFFILIATE_)?LOCATION'/.test(message)) {
        return "location assets aren't a field_type: they're asset sets. SELECT campaign.name, asset_set.name, asset_set.type FROM campaign_asset_set "
          + "(asset_set.type LOCATION_SYNC is the Business Profile link; affiliate locations are asset_set.location_set.location_ownership_type AFFILIATE).";
      }
      return null;
    case "MUTATE_NOT_ALLOWED":
      // Field "type" is the item's own type locking it: for a conversion action, a Google-managed one (2026-10-26).
      if (/(^|\.)type$/.test(field)) return "this item's type is managed by Google, so the API can't change its settings. For a conversion action, "
        + "check it with SELECT conversion_action.name, conversion_action.type FROM conversion_action; count with a different action (propose "
        + "create_conversion_action; for calls, source AD_CALL), or change it in Google Ads (Goals → Conversions) if Google allows it there.";
      return "Google doesn't allow this change through the API (some legacy or system-managed items are locked, and some campaign types "
        + "can't be created). Do it in Google Ads. For a locked shared bid strategy, set_bidding_strategy can still move campaigns off it.";
    case "UNRECOGNIZED_FIELD":
      if (/conversion_action\.(tracking_status|last_received|last_conversion)/.test(message)) {
        return "whether a conversion action is recording is in metrics, FROM conversion_action: metrics.conversion_last_received_request_date_time "
          + "and metrics.conversion_last_conversion_date (a 1969/1970 date means never). The account-wide setting is "
          + "customer.conversion_tracking_setting.conversion_tracking_status.";
      }
      if (/maximize_clicks/.test(message)) {
        return "Maximize clicks is target_spend in the API: campaign.target_spend.cpc_bid_ceiling_micros (bidding_strategy_type TARGET_SPEND), "
          + "or bidding_strategy.target_spend.cpc_bid_ceiling_micros for a shared strategy.";
      }
      if (/campaign\.url_expansion_opt_out/.test(message)) {
        return "Final URL expansion moved to SELECT campaign.asset_automation_settings (selected whole): it's the entry whose "
          + "asset_automation_type is FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION, with asset_automation_status OPTED_IN or OPTED_OUT.";
      }
      if (/'metrics\.video_view(s|_rate)'/.test(message)) {
        return "metrics.video_views was renamed metrics.video_trueview_views (video_view_rate is now video_trueview_view_rate).";
      }
      if (/'recommendation\.impact\./.test(message)) {
        return "recommendation.impact is selected whole: SELECT recommendation.impact (its base_metrics and potential_metrics come back inside it).";
      }
      return null;
    case "BAD_FIELD_NAME":
      return /'\('/.test(message) ? NO_OR : null;
    case "UNEXPECTED_INPUT":
      return /unexpected input (OR\b|[()])/i.test(message) ? NO_OR : null;
    case "PROHIBITED_SEGMENT_WITH_METRIC_IN_SELECT_OR_WHERE_CLAUSE":
      return "Google can't split the metrics it names by that segment. Drop them from this query and get them in a second one without the segment: "
        + "e.g. conversions by segments.conversion_action_name in one, cost per campaign in another.";
    case "REQUIRES_FILTER_BY_SINGLE_RESOURCE": {
      // Google names the fields and the id, but not the two steps. The model dropped one field at a time, kept
      // segments.date in SELECT, and fell back to a view that has no Performance Max terms (prod, 2026-10-27).
      const m = /^(.+?) can only be selected when filtering by a single '([a-z_.]+)'/.exec(message);
      if (!m) return null;
      const fields = m[1]!.replace(/"/g, "").split(",").map((s) => s.trim()).join(", ");
      return `take ${fields} out of SELECT (a date range can stay in WHERE) and run it to list each ${m[2]}; then select them `
        + `again in one query per ${m[2]}, with WHERE ${m[2]} = that value.`;
    }
    case "DUPLICATE_ASSET":
      return "two texts in one ad or asset group are the same to Google, which ignores spacing but not capitals. Make every headline and "
        + "description different, and propose again.";
    case "EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED":
      return "Google refuses every change to this account until each of its campaigns declares whether it contains EU political advertising. "
        + "Find them: SELECT campaign.id, campaign.name FROM campaign WHERE campaign.missing_eu_political_advertising_declaration = TRUE "
        + "AND campaign.status != 'REMOVED'. Ask the user whether any of them run EU political ads (it is their legal declaration; most "
        + "businesses answer no), propose set_eu_political_advertising for each in one proposal, apply it, then retry this change.";
    case "POLICY_FINDING":
      return "Google's ad policy check rejected the ad text, images or video. Change what any [policy …] above flags. Common causes: repeated punctuation (\"!!\"), "
        + "ALL CAPS, symbols or emoji used for emphasis, phone numbers in headlines, or a video or landing page that breaks policy. "
        + "Reword the ad and propose again; the full reasons show under Policy in Google Ads.";
    case "POLICY_ERROR":
      return /keyword\.text$/.test(field)
        ? "Google's policy check refused a keyword (the policy and the words it flagged are above). Drop or reword that keyword "
          + "and propose again. If it is compliant, add it in Google Ads, where an exemption can be requested."
        : null;
    case "IMMUTABLE_FIELD":
      return /counting_type$/.test(field)
        ? "Google fixes the counting of some conversion actions (imports such as GA4 or Firebase, and Google-managed actions). "
          + "Check it with SELECT conversion_action.name, conversion_action.type FROM conversion_action, and change the counting where "
          + "the action comes from (in GA4 for a GA4 import), or count with a different conversion action."
        : null;
    case "ASPECT_RATIO_NOT_ALLOWED":
      return "an image has the wrong shape for its slot: marketing images 1.91:1, square images and square logos 1:1, landscape logos 4:1.";
    case "INVALID_VALUE":
      return field === "geo_target_constants"
        ? "a location ID isn't a valid geo target. Look it up with run_gaql: SELECT geo_target_constant.id, geo_target_constant.canonical_name "
          + "FROM geo_target_constant WHERE geo_target_constant.name = 'Thailand'"
        : null;
    default:
      return null;
  }
}

export class AdsApiError extends Error {
  constructor(public status: number, public body: string) {
    super(AdsApiError.summarize(status, body));
  }
  /** Google's error bodies are deep; surface the part a human (or an AI) can act on. */
  static summarize(status: number, body: string): string {
    try {
      const j = JSON.parse(body);
      const e = Array.isArray(j) ? j[0]?.error : j.error;
      const details = e?.details?.flatMap((d: any) => d.errors ?? []) ?? [];
      const msgs = details.map((d: any) => {
        const code = d.errorCode ? Object.values(d.errorCode)[0] : "";
        const field = d.location?.fieldPathElements?.map((p: any) => p.fieldName).join(".");
        const fix = adsErrorFix(String(code), String(d.message ?? ""), field ?? "");
        // POLICY_ERROR's message only says "see PolicyViolationDetails"; the policy and flagged text are in there.
        const pv = d.details?.policyViolationDetails;
        const policy = pv ? `[policy ${pv.externalPolicyName ?? pv.key?.policyName}` + (pv.key?.violatingText ? ` flagged "${pv.key.violatingText}"` : "")
          + (pv.isExemptible ? ", exemptible" : "") + "]" : "";
        // POLICY_FINDING's topics and the text Google flagged are in PolicyFindingDetails. Without them the AI reworded
        // blind and got the same refusal twice (2026-10-22).
        const findings = (d.details?.policyFindingDetails?.policyTopicEntries ?? []).map((t: any) => {
          const texts = (t.evidences ?? []).flatMap((ev: any) => ev.textList?.texts ?? []);
          return `[policy ${t.topic}${t.type ? ` ${t.type}` : ""}${texts.length ? ` flagged ${texts.map((s: string) => `"${s}"`).join(", ")}` : ""}]`;
        }).join(" ");
        return [code, d.message, field ? `(field ${field})` : "", policy, findings, fix ? `→ ${fix}` : ""].filter(Boolean).join(" ");
      });
      // Google repeats one error per offending operation (seven identical DUPLICATE_ASSETs, 2026-10-22): once is enough.
      const distinct = [...new Set(msgs)];
      return `Google Ads API ${status}: ${distinct.length ? distinct.join("; ") : e?.message ?? body.slice(0, 300)}`;
    } catch {
      return `Google Ads API ${status}: ${body.slice(0, 300)}`;
    }
  }
}

/** One user's view of the Ads API. `accessToken` is a short-lived Google token. */
export class AdsClient {
  constructor(
    private accessToken: () => Promise<string>,
    private developerToken?: string,
    private f: FetchLike = fetch,
    private grantLink: () => string | null = () => null,
  ) {}

  private async headers(loginCustomerId?: string | null): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      ...(this.developerToken ? { "developer-token": this.developerToken } : {}),
      ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
    };
  }

  /** Response body as text; throws AdsApiError on a non-2xx. */
  private async body(res: Response): Promise<string> {
    const body = await res.text();
    if (scopeMissing(res.status, body)) throw new NotGrantedError("google-ads", this.grantLink());
    if (!res.ok) throw new AdsApiError(res.status, body);
    return body;
  }

  async listAccessibleCustomers(): Promise<string[]> {
    const res = await this.f(`${ADS_API}/customers:listAccessibleCustomers`, { headers: await this.headers() });
    return ((JSON.parse(await this.body(res)).resourceNames ?? []) as string[]).map((r) => r.split("/")[1]!);
  }

  async search(customerId: string, query: string, loginCustomerId?: string | null): Promise<any[]> {
    const res = await this.f(`${ADS_API}/customers/${customerId}/googleAds:searchStream`, {
      method: "POST",
      headers: await this.headers(loginCustomerId),
      body: JSON.stringify({ query }),
    });
    const batches = JSON.parse(await this.body(res)) as { results?: any[]; error?: { code?: number } }[];
    // A stream that fails partway still answers 200, with the error as its last element: never return a short list as if whole.
    const broken = batches.find((b) => b.error);
    if (broken) throw new AdsApiError(broken.error!.code ?? 500, JSON.stringify(broken));
    return batches.flatMap((b) => b.results ?? []);
  }

  /** Google's field catalog (GoogleAdsFieldService) for this API version: not tied to any account. */
  async searchFields(query: string): Promise<any[]> {
    const out: any[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.f(`${ADS_API}/googleAdsFields:search`, {
        method: "POST", headers: await this.headers(), body: JSON.stringify({ query, pageSize: 10000, ...(pageToken ? { pageToken } : {}) }),
      });
      const j = JSON.parse(await this.body(res));
      out.push(...(j.results ?? []));
      pageToken = j.nextPageToken;
    } while (pageToken && out.length < 50_000);
    return out;
  }

  /** Keyword Planner (KeywordPlanIdeaService). Read-only: needs Basic access or above on the developer token. */
  async keywordPlan(
    customerId: string, method: "generateKeywordIdeas" | "generateKeywordHistoricalMetrics", request: object, loginCustomerId?: string | null,
  ): Promise<{ results?: any[] }> {
    const res = await this.f(`${ADS_API}/customers/${customerId}:${method}`, {
      method: "POST",
      headers: await this.headers(loginCustomerId),
      body: JSON.stringify(request),
    });
    const body = await this.body(res);
    return body ? JSON.parse(body) : {};
  }

  /**
   * `service` is the REST collection, e.g. "campaignCriteria". Atomic unless partialFailure.
   * "googleAds" is the cross-service mutate: `operations` are MutateOperations (which may reference
   * each other by temporary negative ids), and its per-service results are flattened to the same
   * `{ resourceName }` shape, in order.
   */
  async mutate(
    customerId: string, service: string, operations: object[],
    opts: { validateOnly?: boolean; loginCustomerId?: string | null } = {},
  ): Promise<{ results: { resourceName?: string }[] }> {
    const cross = service === "googleAds";
    const res = await this.f(`${ADS_API}/customers/${customerId}/${service}:mutate`, {
      method: "POST",
      headers: await this.headers(opts.loginCustomerId),
      // campaignConversionGoals:mutate has no partialFailure field and 400s on it (it's atomic anyway).
      body: JSON.stringify({ [cross ? "mutateOperations" : "operations"]: operations, validateOnly: !!opts.validateOnly,
        ...(service === "campaignConversionGoals" ? {} : { partialFailure: false }) }),
    });
    const body = await this.body(res);
    const json = body ? JSON.parse(body) : {};
    if (!cross) return json.results ? json : { results: [] };
    return { results: (json.mutateOperationResponses ?? []).map((r: Record<string, { resourceName?: string }>) =>
      ({ resourceName: Object.values(r)[0]?.resourceName })) };
  }
}

const SEARCH_CONSOLE_API = "https://www.googleapis.com/webmasters/v3";
/** URL Inspection lives on the newer host; webmasters.readonly is enough for it. */
const URL_INSPECTION_API = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

export interface SearchAnalyticsRow { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }
export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions: string[];
  rowLimit: number;
  startRow?: number;
  /** "all" includes the last 2-3 days Google is still filling in; omitted means final data only. */
  dataState?: "all" | "final";
  dimensionFilterGroups?: { filters: { dimension: string; operator: string; expression: string }[] }[];
}
export interface Sitemap {
  path: string; lastSubmitted?: string; lastDownloaded?: string; isPending?: boolean; isSitemapsIndex?: boolean;
  warnings?: string; errors?: string; contents?: { type: string; submitted?: string }[];
}
/** The parts of urlInspection.index.inspect's `inspectionResult` the tools read. */
export interface UrlInspection {
  indexStatusResult?: {
    verdict?: string; coverageState?: string; lastCrawlTime?: string; robotsTxtState?: string; indexingState?: string;
    pageFetchState?: string; googleCanonical?: string; userCanonical?: string; crawledAs?: string; sitemap?: string[]; referringUrls?: string[];
  };
  richResultsResult?: { verdict?: string; detectedItems?: { richResultType: string; items?: { name?: string; issues?: { issueMessage: string; severity: string }[] }[] }[] };
}

/** One user's view of the Search Console API (read-only). */
export class SearchConsoleClient {
  constructor(private accessToken: () => Promise<string>, private grantLink: () => string | null = () => null, private f: FetchLike = fetch) {}

  private async get(path: string, init: RequestInit = {}): Promise<any> {
    const res = await this.f(path.startsWith("https://") ? path : `${SEARCH_CONSOLE_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
    });
    const body = await res.text();
    if (!res.ok) {
      if (scopeMissing(res.status, body)) throw new NotGrantedError("search-console", this.grantLink());
      let msg = body.slice(0, 300);
      try { msg = JSON.parse(body).error?.message ?? msg; } catch { /* not JSON */ }
      // AIs guess sc-domain:example.com when the user's property is https://www.example.com/ (or the reverse).
      const fix = res.status === 403 && /permission/i.test(msg)
        ? " → use a property exactly as search_console_sites lists it: sc-domain:example.com and https://www.example.com/ are different properties." : "";
      throw new Error(`Search Console API ${res.status}: ${msg}${fix}`);
    }
    return body ? JSON.parse(body) : {};
  }

  async sites(): Promise<{ siteUrl: string; permissionLevel: string }[]> {
    return (await this.get("/sites")).siteEntry ?? [];
  }

  async searchAnalytics(siteUrl: string, req: SearchAnalyticsRequest): Promise<SearchAnalyticsRow[]> {
    return (await this.get(`/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      { method: "POST", body: JSON.stringify({ type: "web", ...req }) })).rows ?? [];
  }

  /** Sitemaps submitted for the property, with Google's last fetch and its error/warning counts. Read-only. */
  async sitemaps(siteUrl: string): Promise<Sitemap[]> {
    return (await this.get(`/sites/${encodeURIComponent(siteUrl)}/sitemaps`)).sitemap ?? [];
  }

  /** Google's index record for one URL in the property, as of its last crawl. */
  async inspect(siteUrl: string, url: string): Promise<UrlInspection> {
    return (await this.get(URL_INSPECTION_API, { method: "POST", body: JSON.stringify({ inspectionUrl: url, siteUrl }) })).inspectionResult ?? {};
  }
}
