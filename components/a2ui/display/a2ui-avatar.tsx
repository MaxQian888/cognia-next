"use client"

import React, { memo } from "react"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import type { A2UIComponentProps, A2UIBaseComponent, A2UIStringOrPath } from "@/types/a2ui/schema"
import { safeA2UIMediaSrc } from "@/lib/a2ui/url-policy"
import { useA2UIData } from "../a2ui-context"

export interface A2UIAvatarComponent extends A2UIBaseComponent {
  component: "Avatar"
  src?: A2UIStringOrPath
  alt?: string
  fallback?: string
  size?: "sm" | "md" | "lg"
}

export const A2UIAvatar = memo(function A2UIAvatar({
  component,
}: A2UIComponentProps<A2UIAvatarComponent>) {
  const { resolveString } = useA2UIData()
  // Model-written: only web, data:image, blob: and bundled sources load (ADR-0240).
  const src = component.src ? safeA2UIMediaSrc(resolveString(component.src)) : null

  return (
    <Avatar
      data-slot="a2ui-avatar"
      size={component.size === "lg" ? "lg" : component.size === "sm" ? "sm" : "default"}
      className={component.className}
      style={component.style as React.CSSProperties}
    >
      {src && <AvatarImage src={src} alt={component.alt || ""} />}
      <AvatarFallback>{component.fallback || "?"}</AvatarFallback>
    </Avatar>
  )
})
