/**
 * The only part of the image engine that touches a canvas: bytes in, pixels
 * out, and back again.
 *
 * Everything else in `lib/images/` is pure arithmetic on a `PixelBuffer`, so
 * this module is the whole browser dependency. Keeping the boundary this thin
 * is what lets the maths be unit-tested in the node Jest project while the
 * codec is exercised in jsdom or in a real shell.
 *
 * `OffscreenCanvas` is preferred and `HTMLCanvasElement` is the fallback. Both
 * exist in the shells this app ships to, but not in every one of them at the
 * same version, and a WebView that exposes `OffscreenCanvas` without a working
 * `convertToBlob` is a real configuration.
 */

import { maskToProviderBuffer } from "./mask"
import { hasTransparency, type PixelBuffer } from "./pixel-buffer"

/** Encodings the workbench will write. */
export type ImageEncodeFormat = "png" | "jpeg" | "webp"

export const IMAGE_ENCODE_FORMATS: readonly ImageEncodeFormat[] = ["png", "jpeg", "webp"] as const

/**
 * Quality for the lossy default. 0.92 is where WebP stops being visibly worse
 * than the source for photographic content while still being a fraction of a
 * PNG of the same frame.
 */
export const DEFAULT_ENCODE_QUALITY = 0.92

export type ImageDecodeFailureReason =
  /** The bytes are not an image this runtime can decode. */
  | "decode"
  /**
   * The pixels exist on screen but cannot be read back, because the image came
   * from another origin that did not grant CORS. Distinct from `decode`
   * because it is not a broken image: viewing and downloading still work, only
   * editing is impossible, and the UI has to say so rather than show an error.
   */
  | "cors"
  /** No canvas in this runtime at all (node, or a stripped WebView). */
  | "unsupported"

export class ImageDecodeError extends Error {
  readonly reason: ImageDecodeFailureReason

  constructor(reason: ImageDecodeFailureReason, message: string) {
    super(message)
    this.name = "ImageDecodeError"
    this.reason = reason
  }
}

interface Surface {
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  toBlob: (type: string, quality?: number) => Promise<Blob>
}

/** True when this runtime can rasterize at all. */
export function canRasterize(): boolean {
  return typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined"
}

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (context) {
      return {
        context,
        toBlob: (type, quality) => canvas.convertToBlob({ type, quality }),
      }
    }
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (context) {
      return {
        context,
        toBlob: (type, quality) =>
          new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (blob) =>
                blob
                  ? resolve(blob)
                  : reject(new ImageDecodeError("unsupported", `canvas cannot encode ${type}`)),
              type,
              quality
            )
          }),
      }
    }
  }
  throw new ImageDecodeError("unsupported", "no 2D canvas available in this runtime")
}

interface BitmapLike {
  width: number
  height: number
  close?: () => void
}

async function decodeBitmap(blob: Blob): Promise<CanvasImageSource & BitmapLike> {
  if (typeof createImageBitmap === "function") {
    try {
      return (await createImageBitmap(blob)) as CanvasImageSource & BitmapLike
    } catch {
      // Some WebViews expose createImageBitmap but reject formats their <img>
      // decoder handles perfectly well. Fall through rather than give up.
    }
  }
  if (typeof Image === "undefined" || typeof URL?.createObjectURL !== "function") {
    throw new ImageDecodeError("unsupported", "no image decoder available in this runtime")
  }
  const url = URL.createObjectURL(blob)
  try {
    return await loadImageElement(url, false)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function loadImageElement(
  src: string,
  crossOrigin: boolean
): Promise<HTMLImageElement & BitmapLike> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    if (crossOrigin) image.crossOrigin = "anonymous"
    image.onload = () => resolve(image as HTMLImageElement & BitmapLike)
    image.onerror = () => reject(new ImageDecodeError("decode", `failed to load image: ${src}`))
    image.src = src
  })
}

function drawToBuffer(source: CanvasImageSource, width: number, height: number): PixelBuffer {
  const surface = createSurface(width, height)
  surface.context.drawImage(source, 0, 0)
  try {
    const imageData = surface.context.getImageData(0, 0, width, height)
    return { data: imageData.data, width: imageData.width, height: imageData.height }
  } catch (error) {
    // A tainted canvas throws SecurityError here and nowhere earlier. This is
    // the single point where "we can show it but never edit it" is discovered.
    if (error instanceof DOMException && error.name === "SecurityError") {
      throw new ImageDecodeError("cors", "image pixels are cross-origin and cannot be read back")
    }
    throw error
  }
}

/** Decode a blob into editable pixels. */
export async function decodeBlobToPixelBuffer(blob: Blob): Promise<PixelBuffer> {
  const bitmap = await decodeBitmap(blob)
  try {
    return drawToBuffer(bitmap, bitmap.width, bitmap.height)
  } finally {
    bitmap.close?.()
  }
}

/**
 * Decode from a URL, including a remote one.
 *
 * `crossOrigin = "anonymous"` is requested so a server that sends the CORS
 * header yields readable pixels. When it does not, the load itself may fail, or
 * the read-back may throw. Both arrive here as an `ImageDecodeError` whose
 * reason the caller can turn into an honest message.
 */
export async function decodeUrlToPixelBuffer(url: string): Promise<PixelBuffer> {
  if (!canRasterize()) {
    throw new ImageDecodeError("unsupported", "no 2D canvas available in this runtime")
  }
  let image: (HTMLImageElement & BitmapLike) | null = null
  try {
    image = await loadImageElement(url, true)
  } catch {
    // Retrying without the CORS request is what distinguishes "the image is
    // broken" from "the image loads but its pixels are not ours to read". The
    // second attempt paints, and the read-back below is what reports it.
    image = await loadImageElement(url, false)
  }
  return drawToBuffer(image, image.naturalWidth || image.width, image.naturalHeight || image.height)
}

/** Pick the format that will not lose anything the buffer is carrying. */
export function chooseEncodeFormat(
  buffer: PixelBuffer,
  preferred?: ImageEncodeFormat
): ImageEncodeFormat {
  if (preferred === "png") return "png"
  // Transparency survives only in PNG among the three, so an alpha-carrying
  // result overrides the caller's preference rather than silently flattening.
  if (hasTransparency(buffer)) return "png"
  return preferred ?? "webp"
}

export interface EncodedImage {
  bytes: Uint8Array
  mediaType: string
}

/**
 * Encode pixels back to bytes.
 *
 * The returned media type describes the returned bytes, not what was asked
 * for: a runtime with no WebP encoder silently hands back a PNG from
 * `toBlob("image/webp")`, and a caller that trusted its own request would
 * label those bytes wrongly forever, in a content-addressed store.
 */
export async function encodePixelBuffer(
  buffer: PixelBuffer,
  {
    format,
    quality = DEFAULT_ENCODE_QUALITY,
  }: { format?: ImageEncodeFormat; quality?: number } = {}
): Promise<EncodedImage> {
  const chosen = chooseEncodeFormat(buffer, format)
  const blob = await pixelBufferToBlob(buffer, chosen, quality)
  const arrayBuffer = await blob.arrayBuffer()
  return { bytes: new Uint8Array(arrayBuffer), mediaType: blob.type || `image/${chosen}` }
}

/**
 * Encode an in-app mask into the PNG the provider expects.
 *
 * Always PNG, never the WebP default: the endpoint reads the alpha channel to
 * decide what to edit, and the format negotiation that makes sense for a photo
 * makes none for a mask. `maskToProviderBuffer` performs the inversion, and
 * `lib/images/mask.ts` explains why the convention flips here.
 */
export async function encodeProviderMask(mask: PixelBuffer): Promise<EncodedImage> {
  const blob = await pixelBufferToBlob(maskToProviderBuffer(mask), "png")
  const arrayBuffer = await blob.arrayBuffer()
  return { bytes: new Uint8Array(arrayBuffer), mediaType: "image/png" }
}

/** Encode to a `Blob`, for callers that want to hand it straight to an upload. */
export async function pixelBufferToBlob(
  buffer: PixelBuffer,
  format: ImageEncodeFormat = "png",
  quality: number = DEFAULT_ENCODE_QUALITY
): Promise<Blob> {
  const surface = createSurface(buffer.width, buffer.height)
  surface.context.putImageData(toImageData(buffer), 0, 0)
  return surface.toBlob(`image/${format}`, format === "png" ? undefined : quality)
}

/**
 * Synchronous `data:` URL encoding, DOM only.
 *
 * Exists because `PluginMediaAPI.image.toDataUrl` published a synchronous
 * signature, and that contract is mirrored into the generated plugin SDK. Only
 * `HTMLCanvasElement.toDataURL` can do this without a promise, so this throws
 * in a worker or any runtime with no `document`.
 */
export function pixelBufferToDataUrlSync(
  buffer: PixelBuffer,
  format: ImageEncodeFormat = "png",
  quality: number = DEFAULT_ENCODE_QUALITY
): string {
  if (typeof document === "undefined") {
    throw new ImageDecodeError("unsupported", "synchronous data URL encoding needs a document")
  }
  const canvas = document.createElement("canvas")
  canvas.width = buffer.width
  canvas.height = buffer.height
  const context = canvas.getContext("2d")
  if (!context) {
    throw new ImageDecodeError("unsupported", "no 2D canvas available in this runtime")
  }
  context.putImageData(toImageData(buffer), 0, 0)
  return canvas.toDataURL(`image/${format}`, format === "png" ? undefined : quality)
}

/**
 * Wrap a `PixelBuffer` as a real `ImageData`.
 *
 * `putImageData` type-checks its argument at runtime in some engines, so the
 * structural buffer cannot always be passed straight through even though its
 * shape matches.
 */
export function toImageData(buffer: PixelBuffer): ImageData {
  if (typeof ImageData === "undefined") {
    throw new ImageDecodeError("unsupported", "ImageData is unavailable in this runtime")
  }
  return new ImageData(new Uint8ClampedArray(buffer.data), buffer.width, buffer.height)
}

/** Adopt a real `ImageData` as a `PixelBuffer` with no copy. */
export function fromImageData(imageData: ImageData): PixelBuffer {
  return { data: imageData.data, width: imageData.width, height: imageData.height }
}
