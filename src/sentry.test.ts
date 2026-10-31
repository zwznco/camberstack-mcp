import { describe, expect, it } from "vitest";
import { AdsApiError, MerchantApiError, NotGrantedError } from "./google.js";
import { PlanLimitError } from "./plans.js";
import { isUnexpected } from "./sentry.js";

describe("isUnexpected", () => {
  it("skips the errors we throw to tell the user something", () => {
    expect(isUnexpected(new Error("Give at least one seed keyword or a URL."))).toBe(false);
    expect(isUnexpected(Object.create(PlanLimitError.prototype))).toBe(false);
    expect(isUnexpected(Object.create(NotGrantedError.prototype))).toBe(false);
    expect(isUnexpected(new AdsApiError(400, "{}"))).toBe(false);
    expect(isUnexpected(new MerchantApiError("Merchant API 400: bad filter", 400))).toBe(false);
  });
  it("reports bugs and Google outages", () => {
    expect(isUnexpected(new TypeError("Cannot read properties of undefined"))).toBe(true);
    expect(isUnexpected(new AdsApiError(503, "{}"))).toBe(true);
    expect(isUnexpected(new MerchantApiError("Merchant API 503: down", 503))).toBe(true);
    expect(isUnexpected(new MerchantApiError("developer registration", 401, true))).toBe(true);
    expect(isUnexpected("thrown string")).toBe(true);
  });
});
