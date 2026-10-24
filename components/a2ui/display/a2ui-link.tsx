"use client"

/**
 * A2UI Link Component
 * Renders a clickable link
 *
 * The `href` is model-written, so it goes through the A2UI URL policy
 * (`lib/a2ui/url-policy.ts`, ADR-0240): web pages open through `ExternalLink`
 * (the OS browser under Tauri, the in-app sheet on mobile, a new tab on web),
 * mail links stay plain anchors, and any other target is dropped so the link
 * renders as text (or as its action button) instead of navigating the app.
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { ExternalLink as ExternalLinkIcon } from "lucide-react"
import { ExternalLink } from "@/components/shared/external-link"
import { isWebHref, safeA2UIHref } from "@/lib/a2ui/url-policy"
import type { A2UIComponentProps, A2UILinkComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"

export const A2UILink = memo(function A2UILink({
  component,
  onAction,
}: A2UIComponentProps<A2UILinkComponent>) {
  const { resolveString } = useA2UIData()

  const text = resolveString(component.text, "")
  const href = safeA2UIHref(component.href)
  const web = href !== null && isWebHref(href)
  const external = component.external ?? web

  const handleClick = (e: React.MouseEvent) => {
    if (component.action) {
      e.preventDefault()
      onAction(component.action, href ? { href } : {})
    }
  }

  const linkClassName = cn(
    "inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline",
    component.disabled && "opacity-50 pointer-events-none",
    component.className
  )
  const content = (
    <>
      {text}
      {external && <ExternalLinkIcon className="h-3 w-3" />}
    </>
  )

  if (!href) {
    if (component.action) {
      return (
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            component.disabled && "opacity-50 cursor-not-allowed",
            component.className
          )}
          style={component.style as React.CSSProperties}
          onClick={handleClick}
          disabled={component.disabled as boolean}
        >
          {content}
        </button>
      )
    }
    return (
      <span
        data-a2ui-link-blocked={component.href ? "" : undefined}
        className={cn("inline-flex items-center gap-1", component.className)}
        style={component.style as React.CSSProperties}
      >
        {text}
      </span>
    )
  }

  if (web) {
    return (
      <ExternalLink
        href={href}
        className={linkClassName}
        style={component.style as React.CSSProperties}
        onClick={component.action ? handleClick : undefined}
      >
        {content}
      </ExternalLink>
    )
  }

  return (
    <a
      href={href}
      className={linkClassName}
      style={component.style as React.CSSProperties}
      onClick={component.action ? handleClick : undefined}
    >
      {content}
    </a>
  )
})
