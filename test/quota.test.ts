import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCursorQuota } from "../src/quota.js";

test("normalizes Cursor's two quota groups from dashboard usage", () => {
  const result = normalizeCursorQuota(
    "account-1",
    {
      billingCycleStart: "1785111465000",
      billingCycleEnd: "1787789865000",
      planUsage: {
        autoPercentUsed: 20.69777777777778,
        apiPercentUsed: 100,
        totalPercentUsed: 100,
      },
    },
    {
      billingCycleStart: "2026-07-27T00:17:45Z",
      billingCycleEnd: "2026-08-27T00:17:45Z",
      membershipType: "pro",
    },
  );
  assert.equal(result.source, "dashboard+usage-summary");
  assert.deepEqual(result.subscription, { provider: "cursor", plan: "pro" });
  assert.deepEqual(result.quota.map((row) => row.key), ["cursor-native", "other-models"]);
  assert.deepEqual(result.quota.map((row) => row.label), ["cursor-native", "other-models"]);
  assert.deepEqual(result.quota.map((row) => row.groupLabel), ["cursor-native", "other-models"]);
  assert.equal(result.quota[0]?.usedPercent, 20.69777777777778);
  assert.ok(Math.abs((result.quota[0]?.remainingFraction ?? 0) - 0.7930222222222222) < 1e-12);
  assert.equal(result.quota[0]?.limitReached, false);
  assert.equal(result.quota[1]?.usedPercent, 100);
  assert.equal(result.quota[1]?.remainingFraction, 0);
  assert.equal(result.quota[1]?.allowed, false);
  assert.equal(result.quota[1]?.limitReached, true);
  assert.equal(result.quota[0]?.window?.seconds, 31 * 24 * 60 * 60);
  assert.equal(result.quota[0]?.resetAt, "2026-08-27T00:17:45.000Z");
});

test("falls back to Cursor's own display percentages for Enterprise payloads", () => {
  const result = normalizeCursorQuota("account-2", undefined, {
    billingCycleStart: "2026-08-01T00:00:00Z",
    billingCycleEnd: "2026-09-01T00:00:00Z",
    membershipType: "enterprise",
    autoModelSelectedDisplayMessage: "You've used 0% of your included total usage",
    namedModelSelectedDisplayMessage: "You've used 0% of your included API usage",
    individualUsage: { overall: { enabled: false } },
  });
  assert.equal(result.source, "usage-summary");
  assert.equal(result.subscription?.plan, "enterprise");
  assert.equal(result.quota[0]?.usedPercent, 0);
  assert.equal(result.quota[1]?.usedPercent, 0);
  assert.equal(result.quota[0]?.remainingFraction, 1);
  assert.equal(result.quota[1]?.remainingFraction, 1);
});

test("does not substitute combined total usage for either quota group", () => {
  const result = normalizeCursorQuota("account", { planUsage: { totalPercentUsed: 75 } });
  assert.equal(result.quota[0]?.usedPercent, undefined);
  assert.equal(result.quota[1]?.usedPercent, undefined);
});

test("fails only when both Cursor quota sources are unavailable", () => {
  assert.throws(() => normalizeCursorQuota("account"), /quota endpoints are unavailable/);
});
