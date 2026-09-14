/**
 * May this turn carry the original video file?
 *
 * Native pass-through needs three things to line up, and each has been checked
 * against the code that would actually receive the bytes:
 *
 *  - the model declares `supportsVideo` (provider catalog / discovery);
 *  - the turn runs on the `ai-sdk` runtime — the Claude Agent SDK forwards
 *    content blocks to Anthropic, which has no video input, and an external
 *    agent has its own content contract;
 *  - the provider speaks the `google` protocol. `sidecar/dispatch/ai-sdk.mjs`
 *    turns a base64 `document` block into an AI SDK file part, and only
 *    `@ai-sdk/google` maps an arbitrary file media type to `inlineData`.
 *    `@ai-sdk/openai` throws on `video/*`, so an openai-compatible model that
 *    declares `supportsVideo` (Kimi, Qwen) still cannot be sent one this way.
 *
 * Everything that makes the resolved model uncertain or shared also closes the
 * gate: a team room (members run different models), a collaboration-shared
 * conversation (user parts are published to the server as they are, so the
 * file itself would be uploaded and stored), an IM platform
 * conversation (a person receives the files, not a model), standalone BYOK
 * mode (its engine builds prompts from transcript parts, where a video is only
 * a poster), and auto routing (the model is chosen after the composer has
 * already built the content).
 *
 * The verdict is advisory in the composer and authoritative in the controller;
 * see `route-guard.ts`.
 */

import {
  normalizeProtocol,
  resolveProviderProtocol,
} from "@/sidecar/dispatch/protocol-adapters/provider-protocol.mjs"
import type { AgentRuntimeAdapterId } from "@cognia/agent-config-types/agent-execution"
import { COMPOSER_MAX_ATTACHMENT_BYTES } from "../prepare"

/** Protocol families whose AI SDK provider accepts a video file part. */
export const NATIVE_VIDEO_PROTOCOLS: ReadonlySet<string> = new Set(["google"])

/** Decision D8: a native video is a composer attachment, held to the same ceiling. */
export const NATIVE_VIDEO_MAX_BYTES = COMPOSER_MAX_ATTACHMENT_BYTES

export type NativeVideoBlockReason =
  | "platform"
  | "team"
  | "shared"
  | "external-agent"
  | "standalone"
  | "auto-routing"
  | "runtime"
  | "protocol"
  | "model"
  | "too-large"

export interface VideoRouteFacts {
  providerId: string | null | undefined
  modelId: string | null | undefined
  runtimeAdapter: AgentRuntimeAdapterId | null | undefined
  /** The resolved protocol family, from {@link resolveVideoRouteProtocol}. */
  protocol: string | null | undefined
  supportsVideo: boolean
  platformBound?: boolean
  teamRoom?: boolean
  sharedCollaboration?: boolean
  externalAgent?: boolean
  standalone?: boolean
  autoRouting?: boolean
}

export type NativeVideoVerdict =
  { available: true } | { available: false; reason: NativeVideoBlockReason }

/**
 * The route half of the gate, in the order a user can act on: things they
 * cannot change in this conversation first, the model choice last.
 */
export function nativeVideoRouteVerdict(facts: VideoRouteFacts): NativeVideoVerdict {
  if (facts.platformBound) return { available: false, reason: "platform" }
  if (facts.teamRoom) return { available: false, reason: "team" }
  if (facts.sharedCollaboration) return { available: false, reason: "shared" }
  if (facts.externalAgent || facts.runtimeAdapter === "external") {
    return { available: false, reason: "external-agent" }
  }
  if (facts.standalone) return { available: false, reason: "standalone" }
  if (facts.autoRouting) return { available: false, reason: "auto-routing" }
  if (facts.runtimeAdapter !== "ai-sdk") return { available: false, reason: "runtime" }
  if (!facts.protocol || !NATIVE_VIDEO_PROTOCOLS.has(facts.protocol)) {
    return { available: false, reason: "protocol" }
  }
  if (!facts.supportsVideo) return { available: false, reason: "model" }
  return { available: true }
}

/** The full gate: the route, then the byte ceiling of the file that would be sent. */
export function nativeVideoVerdict(
  facts: VideoRouteFacts,
  sourceBytes: number
): NativeVideoVerdict {
  const route = nativeVideoRouteVerdict(facts)
  if (!route.available) return route
  if (!(sourceBytes > 0) || sourceBytes > NATIVE_VIDEO_MAX_BYTES) {
    return { available: false, reason: "too-large" }
  }
  return { available: true }
}

/**
 * The protocol family a provider id dispatches with. A custom provider carries
 * its own `apiProtocol`; a built-in one is looked up in the sidecar's table,
 * the same table dispatch uses, so the two cannot disagree.
 */
export function resolveVideoRouteProtocol(
  providerId: string | null | undefined,
  modelId: string | null | undefined,
  customProviders?: ReadonlyArray<{ id: string; apiProtocol?: string }>
): string | null {
  if (!providerId) return null
  const custom = customProviders?.find((provider) => provider.id === providerId)
  if (custom) return custom.apiProtocol ? normalizeProtocol(custom.apiProtocol) : null
  const builtIn = resolveProviderProtocol(providerId, modelId ?? undefined)
  return builtIn ? normalizeProtocol(builtIn) : null
}
