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

import { requestBrowserUrl } from "@/lib/browser/open-url-request"
import { isCapacitor } from "@/lib/platform/detect"
import { isTauri } from "@/lib/tauri"
import { openExternal } from "@/lib/tauri/opener"

export interface ExternalLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string
  /**
   * Offer this link to an embedded browser pane before the OS browser.
   *
   * The rule is the composer's (`components/chat/composer.tsx`): a pane the
   * user can actually see, or that can reveal itself, CLAIMS the URL and the
   * click stops there. An unclaimed request falls through to exactly what this
   * component did before, on every shell. The fallback is therefore not a
   * special case but the default path, so a surface with no browser pane on
   * screen behaves identically whether or not it passes this.
   *
   * It is opt-in rather than automatic because "read this page next to the
   * conversation" is a property of the *surface* the link sits on, not of the
   * link. A help link in Settings belongs in the real browser even while a
   * dock elsewhere in the app happens to hold a browser panel.
   */
  preferEmbedded?: boolean
}

export const ExternalLink = forwardRef<HTMLAnchorElement, ExternalLinkProps>(function ExternalLink(
  { href, onClick, rel, target, children, preferEmbedded, ...rest },
  ref
) {
  const isExternalHttpLink = /^https?:\/\//i.test(href)

  return (
    <a
      ref={ref}
      href={href}
      target={target ?? (isExternalHttpLink ? "_blank" : undefined)}
      rel={rel ?? (isExternalHttpLink ? "noopener noreferrer" : undefined)}
      onClick={(e) => {
        onClick?.(e)
        // Respect a caller that already handled the click (e.g. an A2UI
        // action that calls preventDefault).
        if (e.defaultPrevented) return
        if (!isExternalHttpLink) return
        // A modified click is the user asking their own browser for something
        // specific: a new tab, a new window, a download, "copy link". Routing
        // that into a pane would take the gesture away, so the modifier skips
        // the EMBEDDED round — and only that round.
        //
        // It must not skip the native fallback too. Under Tauri and Capacitor
        // there is no second tab to open into and `target="_blank"` is exactly
        // the unreliable route this component exists to replace (see the file
        // header), so returning here left a ⌘-click doing nothing at all. The
        // OS browser is what "somewhere other than here" means on those
        // shells; on plain web the modifier keeps working natively because
        // neither branch below claims the event.
        const modified = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0
        if (!modified && preferEmbedded && requestBrowserUrl(href)) {
          e.preventDefault()
          return
        }
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
