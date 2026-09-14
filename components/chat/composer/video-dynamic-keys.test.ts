/**
 * Catalogue coverage for the video pipeline's DYNAMIC translation keys.
 *
 * `lint:i18n` checks literal `t("a.b")` references and skips interpolated ones,
 * and every key below is built from an enum: a refusal reason, an engine, a
 * delivery. A member with no catalogue row passes every gate and renders the
 * raw key path on screen.
 *
 * Each list is typed against its union, and the `Covers` assertion fails the
 * TYPECHECK when the union grows without the list; the runtime assertions then
 * prove every key exists in both locales.
 */

import en from "@/i18n/messages/en/chat.json"
import zh from "@/i18n/messages/zh-CN/chat.json"

import type { RejectReason } from "@/lib/chat/attachments/dispatch"
import type { NativeVideoBlockReason } from "@/lib/chat/attachments/video/delivery-gate"
import type {
  MotionEngine,
  NativeVideoPrepareFailure,
} from "@/lib/chat/attachments/video/frame-source"
import type { VideoDelivery, VideoSamplingStrategy } from "@/lib/chat/attachments/video/settings"

/** Fails to compile when `Union` has a member `List` does not cover. */
type Covers<Union, List extends readonly Union[]> =
  Exclude<Union, List[number]> extends never ? true : never

const BLOCK_REASONS = [
  "platform",
  "team",
  "shared",
  "external-agent",
  "standalone",
  "auto-routing",
  "runtime",
  "protocol",
  "model",
  "too-large",
] as const
const _blockReasons: Covers<NativeVideoBlockReason, typeof BLOCK_REASONS> = true

const PREPARE_FAILURES = [
  "trim-unavailable",
  "ffmpeg-missing",
  "too-large",
  "format",
  "failed",
] as const
const _prepareFailures: Covers<NativeVideoPrepareFailure, typeof PREPARE_FAILURES> = true

const ENGINES = ["browser", "ffmpeg", "gif"] as const
const _engines: Covers<MotionEngine, typeof ENGINES> = true

const DELIVERIES = ["storyboard", "frames", "native"] as const
const _deliveries: Covers<VideoDelivery, typeof DELIVERIES> = true

const STRATEGIES = ["uniform", "scene"] as const
const _strategies: Covers<VideoSamplingStrategy, typeof STRATEGIES> = true

/** `attachment-preview.tsx`'s `REJECT_KEY` for the reasons the video path adds. */
const VIDEO_REJECT_KEYS = ["videoUndecodable", "videoTooLarge", "videoUnprocessed"] as const
const VIDEO_REJECT_REASONS = ["video-undecodable", "video-too-large", "video-unprocessed"] as const
const _videoRejects: Covers<
  Extract<RejectReason, `video-${string}`>,
  typeof VIDEO_REJECT_REASONS
> = true

void [
  _blockReasons,
  _prepareFailures,
  _engines,
  _deliveries,
  _strategies,
  _videoRejects,
  VIDEO_REJECT_REASONS,
]

function lookup(catalogue: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, segment) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[segment] : undefined,
      catalogue
    )
}

const VIDEO = "composer.attachments.video"

const KEYS = [
  ...BLOCK_REASONS.map((reason) => `${VIDEO}.nativeReason.${reason}`),
  ...PREPARE_FAILURES.map((failure) => `${VIDEO}.nativeFailure.${failure}`),
  ...ENGINES.map((engine) => `${VIDEO}.engine.${engine}`),
  ...DELIVERIES.flatMap((delivery) => [
    `${VIDEO}.delivery.${delivery}`,
    `${VIDEO}.delivery.${delivery}Hint`,
  ]),
  ...STRATEGIES.map((strategy) => `${VIDEO}.strategy.${strategy}`),
  ...VIDEO_REJECT_KEYS.map((key) => `composer.attachments.rejectReason.${key}`),
]

describe("video pipeline dynamic i18n keys", () => {
  it.each([
    ["en", en],
    ["zh-CN", zh],
  ])("resolves every key in %s", (_locale, catalogue) => {
    const missing = KEYS.filter((key) => typeof lookup(catalogue, key) !== "string")
    expect(missing).toEqual([])
    // Guards the walk itself: an empty list would also pass the check above.
    expect(KEYS.length).toBe(10 + 5 + 3 + 6 + 2 + 3)
  })
})
