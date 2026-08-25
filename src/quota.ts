import type { Config } from "./config.js";
import { h2Request } from "./cursor/h2.js";

type UnknownRecord = Record<string, unknown>;

export interface CursorQuotaRow {
  key: "cursor-native" | "other-models";
  label: string;
  scope: "quota_group";
  metric: "cursor-native" | "other-models";
  groupKey: "cursor-native" | "other-models";
  groupLabel: string;
  usedPercent?: number;
  remainingFraction?: number;
  allowed?: boolean;
  limitReached?: boolean;
  window?: { seconds: number };
  resetAt?: string;
  resetAfterSeconds?: number;
}

export interface CursorQuotaResponse {
  id: string;
  quota: CursorQuotaRow[];
  subscription?: { provider: "cursor"; plan: string };
  source: "dashboard+usage-summary" | "dashboard" | "usage-summary";
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function finite(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const raw = typeof value === "number" ? value : value.trim();
  if (raw === "") return undefined;
  const numeric = Number(raw);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(String(raw));
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function percentageFromMessage(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/\bused\s+([0-9]+(?:\.[0-9]+)?)%/i);
  return match ? finite(match[1]) : undefined;
}

function jwtUserID(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    if (typeof payload.sub !== "string" || !payload.sub.trim()) return undefined;
    return payload.sub.split("|").pop()?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  config: Config,
  body?: Uint8Array,
): Promise<UnknownRecord | undefined> {
  try {
    const response = await h2Request({
      baseUrl,
      path,
      headers,
      body,
      proxyUrl: config.proxyUrl,
      timeoutMs: Math.min(config.requestTimeoutMs, 30_000),
    });
    if (response.status < 200 || response.status >= 300) return undefined;
    return record(JSON.parse(response.body.toString("utf8")));
  } catch {
    return undefined;
  }
}

export async function fetchCursorQuotaPayloads(
  token: string,
  config: Config,
): Promise<{ dashboard?: UnknownRecord; summary?: UnknownRecord }> {
  const dashboardPromise = jsonRequest(
    config.cursorBaseUrl,
    "/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    {
      ":method": "POST",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    config,
    Buffer.from("{}", "utf8"),
  );
  const userID = jwtUserID(token);
  const summaryPromise = userID
    ? jsonRequest(
        "https://cursor.com",
        "/api/usage-summary",
        {
          ":method": "GET",
          cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userID}::${token}`)}`,
          accept: "application/json",
        },
        config,
      )
    : Promise.resolve(undefined);
  const [dashboard, summary] = await Promise.all([dashboardPromise, summaryPromise]);
  return { dashboard, summary };
}

function quotaWindow(start: string | undefined, end: string | undefined): {
  window?: { seconds: number };
  resetAt?: string;
  resetAfterSeconds?: number;
} {
  const startMs = start ? Date.parse(start) : Number.NaN;
  const endMs = end ? Date.parse(end) : Number.NaN;
  const seconds = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, Math.round((endMs - startMs) / 1000))
    : undefined;
  const resetAfter = Number.isFinite(endMs)
    ? Math.max(0, Math.ceil((endMs - Date.now()) / 1000))
    : undefined;
  return {
    ...(seconds !== undefined ? { window: { seconds } } : {}),
    ...(end ? { resetAt: end } : {}),
    ...(resetAfter !== undefined ? { resetAfterSeconds: resetAfter } : {}),
  };
}

function quotaRow(
  key: CursorQuotaRow["key"],
  label: string,
  usedPercent: number | undefined,
  timing: ReturnType<typeof quotaWindow>,
): CursorQuotaRow {
  const clamped = usedPercent === undefined ? undefined : Math.max(0, Math.min(100, usedPercent));
  return {
    key,
    label,
    scope: "quota_group",
    metric: key,
    groupKey: key,
    groupLabel: label,
    ...(clamped !== undefined
      ? {
          usedPercent: clamped,
          remainingFraction: (100 - clamped) / 100,
          allowed: clamped < 100,
          limitReached: clamped >= 100,
        }
      : {}),
    ...timing,
  };
}

/** Merge Cursor's bearer-token dashboard response with its web usage summary. */
export function normalizeCursorQuota(
  id: string,
  dashboard?: UnknownRecord,
  summary?: UnknownRecord,
): CursorQuotaResponse {
  if (!dashboard && !summary) throw new Error("Cursor quota endpoints are unavailable");
  const planUsage = record(dashboard?.planUsage);
  const individualPlan = record(record(summary?.individualUsage)?.plan);
  const teamPlan = record(record(summary?.teamUsage)?.plan);
  const webPlan = individualPlan ?? teamPlan;

  const start = isoTime(summary?.billingCycleStart) ?? isoTime(dashboard?.billingCycleStart);
  const end = isoTime(summary?.billingCycleEnd) ?? isoTime(dashboard?.billingCycleEnd);
  const timing = quotaWindow(start, end);
  const cursorNative =
    finite(planUsage?.autoPercentUsed) ??
    finite(webPlan?.autoPercentUsed) ??
    percentageFromMessage(summary?.autoModelSelectedDisplayMessage);
  const otherModels =
    finite(planUsage?.apiPercentUsed) ??
    finite(webPlan?.apiPercentUsed) ??
    percentageFromMessage(summary?.namedModelSelectedDisplayMessage);
  const plan = typeof summary?.membershipType === "string" && summary.membershipType.trim()
    ? summary.membershipType.trim()
    : "unknown";
  const source = dashboard && summary
    ? "dashboard+usage-summary"
    : dashboard
      ? "dashboard"
      : "usage-summary";
  return {
    id,
    quota: [
      quotaRow("cursor-native", "cursor-native", cursorNative, timing),
      quotaRow("other-models", "other-models", otherModels, timing),
    ],
    subscription: { provider: "cursor", plan },
    source,
  };
}

export async function getCursorQuota(
  id: string,
  token: string,
  config: Config,
): Promise<CursorQuotaResponse> {
  const payloads = await fetchCursorQuotaPayloads(token, config);
  return normalizeCursorQuota(id, payloads.dashboard, payloads.summary);
}
