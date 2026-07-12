"use client"

/**
 * External (http/https) link that opens correctly across all three shells.
 *
 * A plain `<a target="_blank">` is unreliable inside the Capacitor WebView —
 * Android blocks new-window creation and WKWebView is inconsistent, so the
 * link either no-ops or hijacks the app's own WebView — and it does nothing
 * useful under Tauri either. This component keeps the native `target="_blank"`
 * behavior for plain web, but on Capacitor/Tauri intercepts the click and
 * routes http(s) URLs through {@link openExternal} (in-app browser sheet on
 * mobile, the OS default browser on desktop).
 *
 * Reuse this anywhere a chat message, A2UI surface, source citation, or card
 * renders a user-facing outbound link instead of hand-rolling the same
 * `onClick` interception (previously duplicated in `markdown-renderer`).
 * Non-http(s) hrefs (mailto:, tel:, in-app anchors) are left untouched.
 */

import { forwardRef } from "react"

import { isCapacitor } from "@/lib/platform/detect"
import { isTauri } from "@/lib/tauri"
import { openExternal } from "@/lib/tauri/opener"

export interface ExternalLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string
}

export const ExternalLink = forwardRef<HTMLAnchorElement, ExternalLinkProps>(function ExternalLink(
  { href, onClick, rel, target, children, ...rest },
  ref
) {
  return (
    <a
      ref={ref}
      href={href}
      target={target ?? "_blank"}
      rel={rel ?? "noopener noreferrer"}
      onClick={(e) => {
        onClick?.(e)
        // Respect a caller that already handled the click (e.g. an A2UI
        // action that calls preventDefault).
        if (e.defaultPrevented) return
        if (!href || !/^https?:\/\//i.test(href)) return
        if (isCapacitor() || isTauri()) {
          e.preventDefault()
          void openExternal(href)
        }
      }}
      {...rest}
    >
      {children}
    </a>
  )
})
