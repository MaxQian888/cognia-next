/**
 * Which staged files are moving pictures.
 *
 * Stated over metadata (a name and a declared media type) like
 * `isSupportedAttachmentDescriptor`, because a picked file's `type` is whatever
 * the OS reported — often empty for `.mkv` / `.mov` on Linux and inside some
 * WebViews — and the extension is then the only evidence there is.
 */

export interface MediaDescriptor {
  name: string
  mediaType: string
}

/** Extension → canonical media type, for files whose `type` came back empty. */
const VIDEO_EXTENSION_TYPES: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  qt: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  ogv: "video/ogg",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  ts: "video/mp2t",
  mts: "video/mp2t",
}

/** Media types a browser reports when it has no idea, which the extension may still resolve. */
const OPAQUE_MEDIA_TYPES = new Set(["", "application/octet-stream"])

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase()
}

/** The video media type of a descriptor, or null when it is not a video. */
export function videoMediaTypeOf(descriptor: MediaDescriptor): string | null {
  const declared = descriptor.mediaType.toLowerCase()
  if (declared.startsWith("video/")) return declared
  if (!OPAQUE_MEDIA_TYPES.has(declared)) return null
  // `.ts` is far more often TypeScript than an MPEG transport stream; only an
  // explicit `video/mp2t` type may claim it.
  const extension = extensionOf(descriptor.name)
  if (extension === "ts") return null
  return VIDEO_EXTENSION_TYPES[extension] ?? null
}

export function isVideoDescriptor(descriptor: MediaDescriptor): boolean {
  return videoMediaTypeOf(descriptor) !== null
}

export function isGifDescriptor(descriptor: MediaDescriptor): boolean {
  const declared = descriptor.mediaType.toLowerCase()
  if (declared === "image/gif") return true
  return OPAQUE_MEDIA_TYPES.has(declared) && extensionOf(descriptor.name) === "gif"
}

/**
 * A file the motion pipeline may claim: any video, or a GIF. Whether a GIF is
 * actually animated is only known once its bytes are parsed — a still GIF
 * leaves the pipeline and is sent as the plain image it is.
 */
export function isMotionDescriptor(descriptor: MediaDescriptor): boolean {
  return isVideoDescriptor(descriptor) || isGifDescriptor(descriptor)
}
