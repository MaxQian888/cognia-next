/**
 * The plugin contract's share of `lib/ai/media/video-jobs/params.ts`, which re-exports these.
 */
export interface VideoJobParams {
  durationSec?: number
  aspectRatio?: `${number}:${number}`
  resolution?: `${number}x${number}`
  seed?: number
  fps?: number
}
