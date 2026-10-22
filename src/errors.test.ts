import { describe, expect, it } from "vitest";
import { AdsApiError, AdsClient } from "./google.js";
import { expandDuring, missingSelectFields, renameFields } from "./session.js";

/** Google's error body for one GAQL error, as the REST API returns it. */
const body = (code: Record<string, string>, message: string, field?: string) => JSON.stringify({
  error: { details: [{ errors: [{ errorCode: code, message,
    ...(field ? { location: { fieldPathElements: [{ fieldName: field }] } } : {}) }] }] },
});

describe("AdsApiError fix hints", () => {
  // Each case is an error users actually hit (tool_calls.error), with its message as Google sent it.
  it.each([
    [{ queryError: "INVALID_VALUE_WITH_DURING_OPERATOR" }, "Invalid date literal supplied for DURING operator: LAST_90_DAYS.", undefined, "BETWEEN"],
    [{ queryError: "PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE" }, "Cannot select or filter on the following metrics: 'search_budget_lost_impression_share'", undefined, "FROM campaign"],
    [{ queryError: "UNRECOGNIZED_FIELD" }, "Unrecognized fields in the query: 'recommendation.impact.base_metrics.clicks', 'recommendation.impact.potential_metrics.clicks'.", undefined, "SELECT recommendation.impact"],
    [{ queryError: "UNRECOGNIZED_FIELD" }, "Unrecognized field in the query: 'campaign.maximize_clicks.cpc_bid_ceiling_micros'.", undefined, "campaign.target_spend.cpc_bid_ceiling_micros"],
    [{ mutateError: "MUTATE_NOT_ALLOWED" }, "Mutates are not allowed for the requested resource.", "operations", "set_bidding_strategy can still move campaigns off it"],
    [{ queryError: "BAD_FIELD_NAME" }, "Error in WHERE clause: invalid field name '('.", undefined, "no parentheses or OR"],
    [{ queryError: "EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE" }, "The following field must be present in SELECT clause: 'campaign.id'.", undefined, "add that field to SELECT"],
    [{ queryError: "EXPECTED_FILTERS_ON_DATE_RANGE" }, "Expects filters on the following field to limit a finite date range: 'segments.date'.", undefined, "finite range"],
    [{ fieldError: "INVALID_VALUE" }, "The input has an invalid value.", "geo_target_constants", "FROM geo_target_constant"],
    [{ queryError: "PROHIBITED_RESOURCE_TYPE_IN_SELECT_CLAUSE" }, "Cannot select fields from the following resource: 'CAMPAIGN_BUDGET', since the resource is incompatible with the resource in FROM clause.", undefined, "FROM campaign_budget"],
    [{ policyFindingError: "POLICY_FINDING" }, "The resource has been disapproved since the policy summary includes policy topics of type PROHIBITED.", "ad", "repeated punctuation"],
    [{ policyViolationError: "POLICY_ERROR" }, "A policy was violated. See PolicyViolationDetails for more detail.", "mutate_operations.ad_group_criterion_operation.create.keyword.text", "Drop or reword that keyword"],
    [{ fieldError: "IMMUTABLE_FIELD" }, "The field attempted to be mutated is immutable.", "operations.update.counting_type", "conversion_action.type"],
    [{ queryError: "UNRECOGNIZED_FIELD" }, "Unrecognized fields in the query: 'conversion_action.tracking_status', 'conversion_action.last_received_request_time'.", undefined, "metrics.conversion_last_received_request_date_time"],
    [{ queryError: "UNRECOGNIZED_FIELD" }, "Unrecognized field in the query: 'campaign.url_expansion_opt_out'.", undefined, "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION"],
    [{ queryError: "PROHIBITED_SEGMENT_IN_SELECT_OR_WHERE_CLAUSE" }, "Cannot select or filter on the following segments: 'segments.geo_target_city'(could not support requested resources: 'CAMPAIGN'), since segment is incompatible with the resource in the FROM clause or other selected segmenting resources", undefined, "FROM geographic_view"],
    [{ queryError: "BAD_ENUM_CONSTANT" }, "Invalid enum values cannot be included in WHERE clause: 'LOCATION', 'AFFILIATE_LOCATION'.", undefined, "FROM campaign_asset_set"],
    [{ changeEventError: "CHANGE_DATE_RANGE_INFINITE" }, "The change_event request is missing filters on change_event.change_date_time or is filtering on change_event.change_date_time with an infinite range.", undefined, "both ends of the window"],
    [{ queryError: "UNRECOGNIZED_FIELD" }, "Unrecognized field in the query: 'metrics.video_views'.", undefined, "metrics.video_trueview_views"],
    [{ queryError: "UNEXPECTED_INPUT" }, "Error in query: unexpected input OR.", undefined, "no parentheses or OR"],
    [{ queryError: "PROHIBITED_SEGMENT_WITH_METRIC_IN_SELECT_OR_WHERE_CLAUSE" }, "Cannot select the following segments because at least one unsupported metric is found in SELECT or WHERE clause: 'segments.conversion_action_name'(unsupported metrics: 'cost_micros').", undefined, "second one without the segment"],
    [{ assetError: "DUPLICATE_ASSET" }, "Assets are duplicated across operations.", "mutate_operations.ad_group_ad_operation.create.ad.responsive_search_ad.headlines", "ignores spacing but not capitals"],
    [{ euPoliticalAdvertisingError: "EU_POLITICAL_ADVERTISING_DECLARATION_REQUIRED" }, "Mutates are generally not allowed if the customer contains non-exempt campaigns without the EU political advertising declaration.", undefined, "campaign.missing_eu_political_advertising_declaration = TRUE"],
    [{ dateError: "MISALIGNED_DATE_FOR_FILTER" }, "Dates in conditions should be the start of week/month/quarter if the filtered field is segments.week/segments.month/segments.quarter.", undefined, "filter on segments.date BETWEEN"],
    [{ imageError: "ASPECT_RATIO_NOT_ALLOWED" }, "The aspect ratio of the image does not match the expected aspect ratios provided in the asset spec.", "logo_images", "1.91:1"],
  ])("%j → hint", (code, message, field, hint) => {
    const e = new AdsApiError(400, body(code, message, field));
    expect(e.message).toContain(message);   // Google's own words stay
    expect(e.message).toContain(`→ `);
    expect(e.message).toContain(hint);
  });

  it("says a repeated error once", () => {
    const err = { errorCode: { assetError: "DUPLICATE_ASSET" }, message: "Assets are duplicated across operations.",
      location: { fieldPathElements: [{ fieldName: "headlines" }] } };
    const e = new AdsApiError(400, JSON.stringify({ error: { details: [{ errors: Array(7).fill(err) }] } }));
    expect(e.message.match(/DUPLICATE_ASSET/g)).toHaveLength(1);
  });

  it("names the policy and the flagged text from PolicyViolationDetails", () => {
    const e = new AdsApiError(400, JSON.stringify({ error: { details: [{ errors: [{
      errorCode: { policyViolationError: "POLICY_ERROR" }, message: "A policy was violated. See PolicyViolationDetails for more detail.",
      location: { fieldPathElements: [{ fieldName: "keyword" }, { fieldName: "text" }] },
      details: { policyViolationDetails: { externalPolicyName: "Alcohol", key: { policyName: "ALCOHOL", violatingText: "borrel" }, isExemptible: true } },
    }] }] } }));
    expect(e.message).toContain('[policy Alcohol flagged "borrel", exemptible]');
    expect(e.message).toContain("→ ");
  });

  it("names the policy topics and flagged text from PolicyFindingDetails", () => {
    const e = new AdsApiError(400, JSON.stringify({ error: { details: [{ errors: [{
      errorCode: { policyFindingError: "POLICY_FINDING" },
      message: "The resource has been disapproved since the policy summary includes policy topics of type PROHIBITED.",
      location: { fieldPathElements: [{ fieldName: "operations" }, { fieldName: "create" }, { fieldName: "ad" }] },
      details: { policyFindingDetails: { policyTopicEntries: [
        { topic: "PUNCTUATION", type: "PROHIBITED", evidences: [{ textList: { texts: ["¡¡Compra ya!!"] } }] },
        { topic: "DESTINATION_NOT_WORKING", type: "PROHIBITED" },
      ] } },
    }] }] } }));
    expect(e.message).toContain('[policy PUNCTUATION PROHIBITED flagged "¡¡Compra ya!!"] [policy DESTINATION_NOT_WORKING PROHIBITED]');
    expect(e.message).toContain("→ ");
  });

  // run_gaql adds the field catalog's finding for these (gaql.ts checkGaql); a generic guess here only contradicted it.
  it.each([
    [{ queryError: "UNRECOGNIZED_FIELD" }, "Unrecognized fields in the query: 'invoice.id', 'invoice.type'."],
    [{ queryError: "BAD_ENUM_CONSTANT" }, "Invalid enum value cannot be included in WHERE clause: 'ACTIVE'."],
    [{ queryError: "PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE" }, "Cannot select or filter on the following metrics: 'conversions'"],
    [{ queryError: "PROHIBITED_SEGMENT_IN_SELECT_OR_WHERE_CLAUSE" }, "Cannot select or filter on the following segments: 'segments.search_term'"],
    [{ queryError: "PROHIBITED_RESOURCE_TYPE_IN_SELECT_CLAUSE" }, "Cannot select fields from the following resource: 'AD_GROUP'"],
  ])("%j: no generic hint, the field catalog speaks", (code, message) => {
    expect(new AdsApiError(400, body(code, message)).message).not.toContain("→");
  });

  it("adds nothing for errors it has no fix for", () => {
    const e = new AdsApiError(403, body({ authorizationError: "USER_PERMISSION_DENIED" }, "User doesn't have permission."));
    expect(e.message).toBe("Google Ads API 403: USER_PERMISSION_DENIED User doesn't have permission.");
  });
});

describe("renameFields", () => {
  it("renames the dropped campaign date fields everywhere, and leaves the current ones alone", () => {
    const r = renameFields("SELECT campaign.id, campaign.start_date, campaign.end_date FROM campaign ORDER BY campaign.end_date");
    expect(r.query).toBe("SELECT campaign.id, campaign.start_date_time, campaign.end_date_time FROM campaign ORDER BY campaign.end_date_time");
    expect(r.renamed).toEqual(["campaign.start_date as campaign.start_date_time", "campaign.end_date as campaign.end_date_time"]);
    const ok = "SELECT campaign.start_date_time, campaign.end_date_time FROM campaign";
    expect(renameFields(ok)).toEqual({ query: ok, renamed: [] });
  });
});

describe("expandDuring", () => {
  it("runs an unsupported LAST_N_DAYS as explicit dates", () => {
    const { query, rewrote } = expandDuring("SELECT campaign.id FROM campaign WHERE segments.date DURING LAST_90_DAYS AND campaign.status = 'ENABLED'");
    expect(query).toMatch(/WHERE segments\.date BETWEEN '\d{4}-\d\d-\d\d' AND '\d{4}-\d\d-\d\d' AND campaign\.status = 'ENABLED'$/);
    const [, start, end] = /BETWEEN '([\d-]+)' AND '([\d-]+)'/.exec(query)!;
    expect((Date.parse(end) - Date.parse(start)) / 86_400_000).toBe(89);   // 90 days, inclusive
    expect(rewrote).toHaveLength(1);
  });

  it("leaves the windows Google supports alone", () => {
    const q = "SELECT metrics.clicks FROM campaign WHERE segments.date DURING last_30_days";
    expect(expandDuring(q)).toEqual({ query: q, rewrote: [] });
  });
});

describe("AdsClient.search", () => {
  const client = (batches: unknown[]) => new AdsClient(async () => "t", "dev",
    (async () => new Response(JSON.stringify(batches), { status: 200 })) as typeof fetch);

  it("joins the stream's batches", async () => {
    expect(await client([{ results: [1, 2] }, { results: [3] }]).search("1", "SELECT x")).toEqual([1, 2, 3]);
  });

  it("throws when the stream fails partway instead of returning a short list", async () => {
    const broken = client([{ results: [1] }, { error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE" } }]);
    await expect(broken.search("1", "SELECT x")).rejects.toThrow(/unavailable/i);
  });
});

describe("missingSelectFields", () => {
  it("reads the field Google wants selected, from each such error", () => {
    const two = JSON.stringify({ error: { details: [{ errors: [
      { errorCode: { queryError: "EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE" }, message: "The following field must be present in SELECT clause: 'campaign.status'." },
      { errorCode: { queryError: "EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE" }, message: "The following field must be present in SELECT clause: 'segments.device'." },
    ] }] } });
    expect(missingSelectFields(two)).toEqual(["campaign.status", "segments.device"]);
    // searchStream wraps it in an array.
    expect(missingSelectFields(`[${body({ queryError: "EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE" }, "The following field must be present in SELECT clause: 'ad_group.id'.")}]`)).toEqual(["ad_group.id"]);
  });

  it("ignores other errors and anything that isn't a field name", () => {
    expect(missingSelectFields(body({ queryError: "UNRECOGNIZED_FIELD" }, "Unrecognized field in the query: 'campaign.start_date'."))).toEqual([]);
    expect(missingSelectFields(body({ queryError: "EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE" }, "The following field must be present in SELECT clause: 'x FROM y'."))).toEqual([]);
    expect(missingSelectFields("not json")).toEqual([]);
  });
});

describe("sign-in scopes", () => {
  const creds = { clientId: "c", clientSecret: "s" };
  const scopes = (u: string) => new URL(u).searchParams.get("scope")!.split(" ");
  it("asks for Ads and Search Console, and Google Analytics only when passed (server.ts always passes it)", async () => {
    const { googleAuthUrl, GRANTS, ADS_SCOPE, ANALYTICS_EDIT_SCOPE } = await import("./google.js");
    expect(scopes(googleAuthUrl(creds, "https://x/cb", "st"))).toContain(ADS_SCOPE);
    expect(scopes(googleAuthUrl(creds, "https://x/cb", "st"))).not.toContain(ANALYTICS_EDIT_SCOPE);
    expect(scopes(googleAuthUrl(creds, "https://x/cb", "st", GRANTS.analytics.scopes))).toEqual(expect.arrayContaining([ADS_SCOPE, ...GRANTS.analytics.scopes]));
  });
});
