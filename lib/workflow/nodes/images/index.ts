/**
 * Image action nodes: `action.image.{info,transform,adjust,convert}`
 * (ADR-0168's engine, driven from a graph).
 *
 * Built on `lib/images/` only: pure pixel functions plus the one canvas
 * boundary in `codec.ts`. Deliberately NOT on `lib/plugin/api/media-api.ts`,
 * whose image helpers are inlined next to provider generation and a settings
 * store, so importing it would pull both into every executor graph.
 *
 * `requires: ["webview"]`. `canRasterize()` needs `OffscreenCanvas` or a
 * `document`, and the headless brain shims neither, so decode and encode are
 * impossible there and the pure middle is unreachable without them. `webview`
 * is on tauri, mobile and web and absent from the server-backed baseline,
 * which is exactly the membership wanted: the brain fails at t=0 with a named
 * capability instead of throwing an unsupported-decode error inside a step.
 *
 * Resize, crop, rotate and flip collapse into one `transform` because
 * `transformBuffer` already takes all four in one pass. Four nodes would mean
 * four decode/encode round trips, which on a JPEG chain is four lossy
 * re-encodes for a result the author asked for once.
 */

import { applyAdjustments, type ImageAdjustments } from "@/lib/images/adjust"
import { encodePixelBuffer, type ImageEncodeFormat } from "@/lib/images/codec"
import { hasTransparency, type PixelBuffer } from "@/lib/images/pixel-buffer"
import { transformBuffer, type TransformOptions } from "@/lib/images/transform"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { storeWorkflowBlob } from "@/lib/workflow/blobs/store"
import type { StepExecutionContext } from "@/types/workflow/visual"
import { registerNodeExecutor } from "../registry"
import { nonRetryable } from "../shared/executor-support"
import { resolveImageSource } from "../shared/image-source"

const ADJUSTMENT_KEYS: ReadonlyArray<keyof ImageAdjustments> = [
  "brightness",
  "contrast",
  "exposure",
  "saturation",
  "vibrance",
  "temperature",
  "tint",
  "hue",
  "gamma",
  "blur",
  "sharpen",
]

function params(ctx: StepExecutionContext): Record<string, unknown> {
  return ctx.params as Record<string, unknown>
}

function num(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key]
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function bool(p: Record<string, unknown>, key: string): boolean | undefined {
  return typeof p[key] === "boolean" ? (p[key] as boolean) : undefined
}

/**
 * Encode a result and park it in the run-scoped blob store.
 *
 * The bytes never ride in the step output: `appendEvent` writes a payload
 * verbatim and the Runs UI live-queries it. The output carries a `blobRef`
 * that every image node, and `ocr.extract`, already know how to read.
 */
async function emitBuffer(
  ctx: StepExecutionContext,
  buffer: PixelBuffer,
  p: Record<string, unknown>
) {
  const requested = typeof p.format === "string" ? (p.format as ImageEncodeFormat) : undefined
  const quality = num(p, "quality")
  const encoded = await encodePixelBuffer(buffer, {
    format: requested,
    // The engine takes 0 to 1. The node's param is the 0 to 100 an author
    // expects to type.
    ...(quality !== undefined ? { quality: Math.min(Math.max(quality, 0), 100) / 100 } : {}),
  })

  const accountId = getActiveAccountId()
  if (!accountId) {
    throw nonRetryable(
      "action.image: no unlocked account, so there is nowhere to put the result. " +
        "Image nodes need an account to encrypt run artifacts with."
    )
  }
  const handle = await storeWorkflowBlob({
    accountId,
    runId: ctx.runId,
    stepId: ctx.stepId,
    bytes: encoded.bytes,
    // What the bytes ARE, which is not always what was asked for: a runtime
    // with no WebP encoder hands back a PNG, and an alpha-carrying buffer
    // overrides the request outright.
    mediaType: encoded.mediaType,
    width: buffer.width,
    height: buffer.height,
  })
  return { ...handle, requestedFormat: requested ?? null }
}

registerNodeExecutor({
  kind: "action.image.info",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const { buffer, sourceMediaType } = await resolveImageSource(params(ctx), "action.image.info")
    return {
      output: {
        width: buffer.width,
        height: buffer.height,
        aspectRatio: buffer.height === 0 ? 0 : buffer.width / buffer.height,
        hasTransparency: hasTransparency(buffer),
        sourceMediaType: sourceMediaType ?? null,
        pixelCount: buffer.width * buffer.height,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.image.transform",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const options: TransformOptions = {}
    const rotate = num(p, "rotate")
    if (rotate !== undefined) options.rotate = rotate
    const scale = num(p, "scale")
    if (scale !== undefined) options.scale = scale
    const flipHorizontal = bool(p, "flipHorizontal")
    if (flipHorizontal !== undefined) options.flipHorizontal = flipHorizontal
    const flipVertical = bool(p, "flipVertical")
    if (flipVertical !== undefined) options.flipVertical = flipVertical

    const cropX = num(p, "cropX")
    const cropY = num(p, "cropY")
    const cropWidth = num(p, "cropWidth")
    const cropHeight = num(p, "cropHeight")
    if (cropWidth !== undefined && cropHeight !== undefined) {
      options.cropRegion = { x: cropX ?? 0, y: cropY ?? 0, width: cropWidth, height: cropHeight }
    } else if (cropX !== undefined || cropY !== undefined) {
      throw nonRetryable(
        "action.image.transform: a crop needs cropWidth and cropHeight, not just an origin"
      )
    }

    if (Object.keys(options).length === 0) {
      throw nonRetryable(
        "action.image.transform requires at least one of rotate, scale, flipHorizontal, " +
          "flipVertical or a crop"
      )
    }

    const { buffer } = await resolveImageSource(p, "action.image.transform")
    // One pass. Four separate nodes would be four decode and encode round trips.
    const out = transformBuffer(buffer, options)
    return {
      output: {
        ...(await emitBuffer(ctx, out, p)),
        sourceWidth: buffer.width,
        sourceHeight: buffer.height,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.image.adjust",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const adjustments: ImageAdjustments = {}
    for (const key of ADJUSTMENT_KEYS) {
      const value = num(p, key)
      if (value !== undefined) adjustments[key] = value
    }
    if (Object.keys(adjustments).length === 0) {
      throw nonRetryable(
        `action.image.adjust requires at least one of ${ADJUSTMENT_KEYS.join(", ")}`
      )
    }

    const { buffer } = await resolveImageSource(p, "action.image.adjust")
    const out = applyAdjustments(buffer, adjustments)
    return { output: { ...(await emitBuffer(ctx, out, p)), applied: Object.keys(adjustments) } }
  },
})

registerNodeExecutor({
  kind: "action.image.convert",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { buffer, sourceMediaType } = await resolveImageSource(p, "action.image.convert")
    return {
      output: { ...(await emitBuffer(ctx, buffer, p)), sourceMediaType: sourceMediaType ?? null },
    }
  },
})
