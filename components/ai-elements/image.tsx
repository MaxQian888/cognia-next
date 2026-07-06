/** biome-ignore-all lint/nursery/useImageSize: "size will be handled by props" */

/**
 * Vendored from the AI Elements registry (https://elements.ai-sdk.dev/components/image)
 * into ai-elements/ — coverage- & i18n-excluded per CLAUDE.md.
 *
 * cognia modification: upstream `Image` only renders an AI-SDK
 * `Experimental_GeneratedImage` (base64 + mediaType). cognia message parts
 * carry image attachments as a ready `url` (data: URL from the Claude adapter /
 * external agents, or a remote URL), so we add an optional `src` prop. When
 * `src` is supplied it is used verbatim; otherwise the base64/mediaType pair is
 * assembled into a data URL exactly like upstream. All other fields are
 * optional so callers may pass just `{ src }`.
 */

import { cn } from "@/lib/utils"
import type { Experimental_GeneratedImage } from "ai"

export type ImageProps = Partial<Experimental_GeneratedImage> & {
  className?: string
  alt?: string
  /** Ready-to-use image source (data: URL or remote URL). Wins over base64. */
  src?: string
}

export const Image = ({ base64, uint8Array, mediaType, src, ...props }: ImageProps) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img
    {...props}
    alt={props.alt}
    className={cn("h-auto max-w-full overflow-hidden rounded-md", props.className)}
    src={src ?? `data:${mediaType};base64,${base64}`}
  />
)
