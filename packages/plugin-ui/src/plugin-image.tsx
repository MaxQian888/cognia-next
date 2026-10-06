"use client"

import { useEffect, useState, type ImgHTMLAttributes } from "react"

import { cn } from "./cn"

export interface PluginImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  src: string
  /** Resolve src relative to this installed plugin instead of the host page. */
  pluginId?: string
  title?: string
}

type PluginImageAssetResolver = (pluginId: string, relativePath: string) => Promise<string>
let resolvePluginImageAsset: PluginImageAssetResolver | undefined

/** Host port; the author package remains independent of host stores and native APIs. */
export function bindPluginImageAssetResolver(resolver: PluginImageAssetResolver): void {
  resolvePluginImageAsset = resolver
}

/** Safe themed image preview; load failures collapse without leaking host UI internals. */
export function PluginImage({
  src,
  pluginId,
  alt = "",
  title,
  className,
  onError,
  ...props
}: PluginImageProps) {
  const [resolved, setResolved] = useState<{ key: string; url: string } | null>(null)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const key = JSON.stringify([pluginId, src])
  useEffect(() => {
    if (!pluginId || !resolvePluginImageAsset) return
    let cancelled = false
    resolvePluginImageAsset(pluginId, src).then(
      (url) => {
        if (!cancelled) setResolved({ key, url })
      },
      () => {
        if (!cancelled) setFailedSource(key)
      }
    )
    return () => {
      cancelled = true
    }
  }, [key, pluginId, src])
  const imageSrc = pluginId ? (resolved?.key === key ? resolved.url : undefined) : src
  if (failedSource === key || !imageSrc) return null
  return (
    // eslint-disable-next-line @next/next/no-img-element -- plugin media has no stable dimensions
    <img
      data-slot="plugin-image"
      src={imageSrc}
      alt={alt}
      title={title}
      loading="lazy"
      decoding="async"
      className={cn("max-h-80 w-auto max-w-full rounded-md border object-contain", className)}
      {...props}
      onError={(event) => {
        setFailedSource(key)
        onError?.(event)
      }}
    />
  )
}
