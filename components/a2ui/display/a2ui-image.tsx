"use client"

/**
 * A2UI Image Component
 * Renders an image with fallback support
 */

import Image from "next/image"
import React, { useState, memo } from "react"
import { cn } from "@/lib/utils"
import { ImageIcon } from "lucide-react"
import type { A2UIComponentProps, A2UIImageComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"

const DEFAULT_IMAGE_WIDTH = 800
const DEFAULT_IMAGE_HEIGHT = 600

const toCssDimension = (value?: number | string) => {
  if (typeof value === "number") {
    return `${value}px`
  }
  return value
}

const isInlineSource = (value: string) => value.startsWith("data:") || value.startsWith("blob:")

export const A2UIImage = memo(function A2UIImage({
  component,
}: A2UIComponentProps<A2UIImageComponent>) {
  const { resolveString } = useA2UIData()
  const [hasError, setHasError] = useState(false)

  const src = resolveString(component.src, "")
  const alt = component.alt || ""
  const width = component.width
  const height = component.height
  const objectFit = component.objectFit || "cover"

  const resolvedWidth = typeof width === "number" ? width : DEFAULT_IMAGE_WIDTH
  const resolvedHeight = typeof height === "number" ? height : DEFAULT_IMAGE_HEIGHT

  const sharedStyle: React.CSSProperties = {
    ...(component.style as React.CSSProperties),
    ...(component.aspectRatio ? { aspectRatio: component.aspectRatio } : {}),
    ...(toCssDimension(width) ? { width: toCssDimension(width) } : {}),
    ...(toCssDimension(height) ? { height: toCssDimension(height) } : {}),
    objectFit,
  }

  const handleError = () => {
    setHasError(true)
  }

  if (hasError || !src) {
    if (component.fallback) {
      return (
        <Image
          src={component.fallback}
          alt={alt}
          width={resolvedWidth}
          height={resolvedHeight}
          className={cn("rounded-md", component.className)}
          style={sharedStyle}
          unoptimized={isInlineSource(component.fallback)}
        />
      )
    }

    return (
      <div
        className={cn("flex items-center justify-center bg-muted rounded-md", component.className)}
        style={sharedStyle}
      >
        <ImageIcon className="h-8 w-8 text-muted-foreground" />
      </div>
    )
  }

  return (
    <Image
      src={src}
      alt={alt}
      width={resolvedWidth}
      height={resolvedHeight}
      className={cn("rounded-md", component.className)}
      style={sharedStyle}
      onError={handleError}
      unoptimized={isInlineSource(src)}
    />
  )
})
