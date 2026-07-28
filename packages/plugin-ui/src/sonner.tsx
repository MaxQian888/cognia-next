import * as React from "react"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, toast, type ToasterProps } from "sonner"

/**
 * Toast viewport. Mount **at most one** per document — Sonner is a singleton
 * and a second viewport competes for the same queue.
 *
 * Plugins should normally not render this at all: the host app already mounts a
 * `Toaster`, and `toast()` from this package addresses whichever one is live.
 * It is exported for plugins that own a detached surface (a popped-out window,
 * a webview) with no host viewport in it.
 *
 * Colours come from the host's `--popover` / `--border` / `--radius` tokens
 * rather than fixed values, so a toast raised by a plugin matches the app's
 * theme — including a theme the plugin has never heard of. The default
 * `theme="system"` follows the OS; pass the host's resolved theme when the app
 * lets the user override it.
 */
function Toaster({ theme = "system", ...props }: ToasterProps) {
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

/**
 * Raise a toast on the live viewport. Re-exported from `sonner` unchanged, so
 * `toast.success` / `.error` / `.promise` and the dismiss handle all behave as
 * documented upstream. The message is the caller's to localize.
 */
export { Toaster, toast }
