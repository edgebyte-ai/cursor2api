/**
 * Model catalogue.
 *
 * The list comes from upstream `agent.v1.AgentService/GetUsableModels` (198 entries
 * on a Pro account today) and is cached in-process. Client-visible names carry the
 * configured prefix, with one wrinkle: a handful of upstream ids already start with
 * `cursor-` (`cursor-grok-4.6-high`), so prefixing must not double up.
 */
import protobuf from "protobufjs";
import path from "node:path";
import type { Config, ModelMode } from "./config.js";
import { protoDir } from "./cursor/proto.js";
import { unaryCall } from "./cursor/unary.js";

const agentRoot = protobuf.loadSync(path.join(protoDir, "agent.proto"));
const GetUsableModelsRequest = agentRoot.lookupType("agent.v1.GetUsableModelsRequest");
const GetUsableModelsResponse = agentRoot.lookupType("agent.v1.GetUsableModelsResponse");

/** Used until the first successful upstream fetch, and if the RPC ever fails. */
export const FALLBACK_MODEL_IDS = [
  "auto",
  "claude-opus-5-thinking-high",
  "claude-sonnet-5-thinking-high",
  "claude-fable-5-thinking-high",
  "claude-opus-4-8-thinking-high",
  "composer-2.5",
  "gpt-5.6-sol-high",
  "gpt-5.6-luna-high",
  "gpt-5.3-codex",
  "gpt-5.2",
  "cursor-grok-4.6-high",
  "gemini-3.7-flash-high",
];

const CACHE_TTL_MS = 10 * 60 * 1000;

let cache: { ids: string[]; at: number } | null = null;

export function clientName(upstreamId: string, prefix: string): string {
  if (!prefix) return upstreamId;
  return upstreamId.startsWith(prefix) ? upstreamId : `${prefix}${upstreamId}`;
}

/**
 * Resolve a client-visible model name back to an upstream id. Falls back to the
 * name as given so a caller can always address a model the catalogue hasn't seen.
 */
export function upstreamId(name: string, prefix: string, known: readonly string[]): string {
  const trimmed = name.trim();
  if (known.includes(trimmed)) return trimmed;
  if (prefix && trimmed.startsWith(prefix)) {
    const stripped = trimmed.slice(prefix.length);
    if (known.includes(stripped)) return stripped;
    // Unknown to the catalogue: prefer the stripped form, since that is what a
    // prefixed client name means, unless stripping empties it.
    if (stripped) return stripped;
  }
  return trimmed;
}

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
const EFFORT_SET = new Set<string>(REASONING_EFFORTS);
const DEFAULT_EFFORT_ORDER: readonly ReasoningEffort[] = [
  "medium",
  "high",
  "low",
  "xhigh",
  "none",
  "minimal",
  "max",
];

export interface NormalizedModelFamily {
  id: string;
  variants: Map<ReasoningEffort, string>;
  fixedUpstreamId?: string;
  defaultEffort?: ReasoningEffort;
}

/** Remove one trailing modifier token that encodes reasoning effort, preserving thinking/fast. */
export function parseModelVariant(id: string): { familyId: string; effort?: ReasoningEffort } {
  const parts = id.split("-");
  let effortIndex = -1;
  for (let i = parts.length - 1; i >= Math.max(0, parts.length - 4); i--) {
    if (EFFORT_SET.has(parts[i]!)) {
      effortIndex = i;
      break;
    }
    if (parts[i] !== "thinking" && parts[i] !== "fast") break;
  }
  if (effortIndex < 0) return { familyId: id };
  const effort = parts[effortIndex] as ReasoningEffort;
  return { familyId: parts.filter((_, index) => index !== effortIndex).join("-"), effort };
}

function chooseDefaultEffort(
  variants: Map<ReasoningEffort, string>,
  preferred?: string,
): ReasoningEffort | undefined {
  if (preferred && EFFORT_SET.has(preferred) && variants.has(preferred as ReasoningEffort)) {
    return preferred as ReasoningEffort;
  }
  for (const effort of DEFAULT_EFFORT_ORDER) if (variants.has(effort)) return effort;
  return undefined;
}

export function normalizedModelFamilies(
  ids: readonly string[],
  preferredEffort?: string,
): Map<string, NormalizedModelFamily> {
  const families = new Map<string, NormalizedModelFamily>();
  for (const id of ids) {
    const parsed = parseModelVariant(id);
    let family = families.get(parsed.familyId);
    if (!family) {
      family = { id: parsed.familyId, variants: new Map() };
      families.set(parsed.familyId, family);
    }
    if (parsed.effort) {
      if (!family.variants.has(parsed.effort)) family.variants.set(parsed.effort, id);
    } else {
      family.fixedUpstreamId ??= id;
    }
  }
  for (const family of families.values()) {
    family.defaultEffort = chooseDefaultEffort(family.variants, preferredEffort);
  }
  return families;
}

export interface ModelResolution {
  upstreamId?: string;
  familyId?: string;
  effort?: ReasoningEffort;
  supportedEfforts?: ReasoningEffort[];
  error?: "unsupported_reasoning_effort" | "model_not_found";
}

function clientCandidates(name: string, prefix: string): string[] {
  const trimmed = name.trim();
  if (!prefix || !trimmed.startsWith(prefix)) return [trimmed];
  const stripped = trimmed.slice(prefix.length);
  return stripped && stripped !== trimmed ? [trimmed, stripped] : [trimmed];
}

export function resolveModel(
  name: string,
  config: Pick<Config, "modelPrefix" | "modelMode" | "defaultReasoningEffort">,
  known: readonly string[],
  requestedEffort?: string,
): ModelResolution {
  const candidates = clientCandidates(name, config.modelPrefix);
  if (config.modelMode !== "normalized") {
    for (const candidate of candidates) {
      if (known.includes(candidate)) return { upstreamId: candidate };
    }
  }

  const families = normalizedModelFamilies(known, config.defaultReasoningEffort);
  let family: NormalizedModelFamily | undefined;
  for (const candidate of candidates) {
    family = families.get(candidate);
    if (family) break;
  }
  if (!family) {
    if (config.modelMode === "normalized") return { error: "model_not_found" };
    return { upstreamId: upstreamId(name, config.modelPrefix, known) };
  }

  if (family.variants.size === 0) {
    return { upstreamId: family.fixedUpstreamId ?? family.id, familyId: family.id };
  }
  const supportedEfforts = REASONING_EFFORTS.filter((effort) => family!.variants.has(effort));
  const effort = requestedEffort?.trim().toLowerCase();
  if (effort && (!EFFORT_SET.has(effort) || !family.variants.has(effort as ReasoningEffort))) {
    return { familyId: family.id, supportedEfforts, error: "unsupported_reasoning_effort" };
  }
  const selected = (effort as ReasoningEffort | undefined) ?? family.defaultEffort;
  if (!selected) return { familyId: family.id, supportedEfforts, error: "model_not_found" };
  return {
    upstreamId: family.variants.get(selected),
    familyId: family.id,
    effort: selected,
    supportedEfforts,
  };
}

export async function listModelIds(token: string, config: Config): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.ids;
  try {
    const body = GetUsableModelsRequest.encode(GetUsableModelsRequest.create({})).finish();
    const res = await unaryCall("/agent.v1.AgentService/GetUsableModels", body, token, config);
    if (res.payload) {
      const decoded = GetUsableModelsResponse.toObject(GetUsableModelsResponse.decode(res.payload), {
        defaults: false,
        enums: String,
        longs: Number,
      }) as { models?: Array<{ modelId?: string }> };
      const ids = (decoded.models ?? [])
        .map((m) => m.modelId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (ids.length > 0) {
        cache = { ids, at: Date.now() };
        return ids;
      }
    }
  } catch {
    /* fall through to the static list */
  }
  const ids = cache?.ids ?? FALLBACK_MODEL_IDS;
  cache = { ids, at: Date.now() };
  return ids;
}

export interface OpenAIModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  reasoning_efforts?: ReasoningEffort[];
  default_reasoning_effort?: ReasoningEffort;
}

function addModelEntry(
  out: OpenAIModelEntry[],
  seen: Set<string>,
  id: string,
  prefix: string,
  created: number,
  family?: NormalizedModelFamily,
): void {
  const name = clientName(id, prefix);
  if (seen.has(name)) return;
  seen.add(name);
  const efforts = family
    ? REASONING_EFFORTS.filter((effort) => family.variants.has(effort))
    : [];
  out.push({
    id: name,
    object: "model",
    created,
    owned_by: "cursor",
    ...(efforts.length > 0 ? { reasoning_efforts: efforts } : {}),
    ...(family?.defaultEffort ? { default_reasoning_effort: family.defaultEffort } : {}),
  });
}

export function toModelList(
  ids: readonly string[],
  prefix: string,
  mode: ModelMode = "raw",
  preferredEffort?: string,
): OpenAIModelEntry[] {
  const created = Math.floor(Date.now() / 1000);
  const seen = new Set<string>();
  const out: OpenAIModelEntry[] = [];
  if (mode === "raw" || mode === "both") {
    for (const id of ids) addModelEntry(out, seen, id, prefix, created);
  }
  if (mode === "normalized" || mode === "both") {
    for (const family of normalizedModelFamilies(ids, preferredEffort).values()) {
      addModelEntry(out, seen, family.id, prefix, created, family);
    }
  }
  return out;
}
