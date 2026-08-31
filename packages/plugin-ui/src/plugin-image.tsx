"use client"

import { useState, type ImgHTMLAttributes } from "react"

import { cn } from "./cn"

export interface PluginImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  src: string
  title?: string
}

/** Safe themed image preview; load failures collapse without leaking host UI internals. */
export function PluginImage({
  src,
  alt = "",
  title,
  className,
  onError,
  ...props
}: PluginImageProps) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    // eslint-disable-next-line @next/next/no-img-element -- plugin media has no stable dimensions
    <img
      data-slot="plugin-image"
      src={src}
      alt={alt}
      title={title}
      loading="lazy"
      decoding="async"
      className={cn("max-h-80 w-auto max-w-full rounded-md border object-contain", className)}
      {...props}
      onError={(event) => {
        setFailed(true)
        onError?.(event)
      }}
    />
  )
}
