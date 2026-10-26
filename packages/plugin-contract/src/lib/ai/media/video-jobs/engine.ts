/**
 * The plugin contract's share of `lib/ai/media/video-jobs/engine.ts`, which re-exports these.
 */
import type { ProviderSettingsSnapshot } from "../../provider-consumption"
import type { VideoJobOrigin } from "./types"
import type { VideoJobParams } from "./params"
import type { experimental_startVideo } from "ai"

/** A start frame as a caller supplies it. */
export type VideoJobStartFrameInput =
  | { kind: "media"; ref: string }
  | { kind: "session-asset"; assetId: string }
  | { kind: "bytes"; data: Uint8Array; mediaType: string }

export interface StartVideoJobInput {
  prompt: string
  startFrame?: VideoJobStartFrameInput
  providerId?: string
  model?: string
  params?: VideoJobParams
  /**
   * Vendor options passed straight to the start call. Not persisted: they
   * shape the generation, and a status check never needs them.
   */
  providerOptions?: Parameters<typeof experimental_startVideo>[0]["providerOptions"]
  origin: VideoJobOrigin
  projectId?: string
  /** Use this snapshot instead of `deps.getSnapshot()` (executor requests). */
  snapshot?: ProviderSettingsSnapshot
  abortSignal?: AbortSignal
}
