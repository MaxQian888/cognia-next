/** biome-ignore-all lint/nursery/useImageSize: "size will be handled by props" */

/**
 * Vendored from the AI Elements registry (https://elements.ai-sdk.dev/components/image)
 * into ai-elements/ — coverage- & i18n-excluded per CLAUDE.md.
 *
 * cognia modifications:
 *  1. Upstream `Image` only renders an AI-SDK `Experimental_GeneratedImage`
 *     (base64 + mediaType). cognia message parts carry image attachments as a
 *     ready `url` (data: URL from the Claude adapter / external agents, or a
 *     remote URL), so we add an optional `src` prop. When `src` is supplied it
 *     is used verbatim; otherwise the base64/mediaType pair is assembled into a
 *     data URL exactly like upstream. All other fields are optional so callers
 *     may pass just `{ src }`.
 *  2. Props extend `img` attributes. Upstream already spreads `...props` onto
 *     the element but typed them as `Partial<Experimental_GeneratedImage>`, so
 *     the load/error/interaction handlers `ImageBlock` needs could never be
 *     passed. Widening the type is what makes this the shared `<img>` primitive
 *     rather than a component with no call site.
 */

import { cn } from "@/lib/utils"
import type { ImgHTMLAttributes } from "react"
import type { Experimental_GeneratedImage } from "ai"

export type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> &
  Partial<Experimental_GeneratedImage> & {
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
