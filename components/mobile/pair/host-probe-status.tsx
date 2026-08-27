"use client"

/**
 * One line about the far end: is there a Host, and will it talk to this client?
 *
 * # Why the browser flow needs this at all
 *
 * `lib/connectivity/loopback-discovery.ts` was written specifically for a
 * browser tab — mDNS needs a multicast socket no browser API exposes, and the
 * `/24` sweep is seeded from WebRTC ICE candidates that modern browsers
 * anonymise to `<uuid>.local`, so the only thing a tab can discover is the
 * plaintext loopback listener on this machine. It was wired into `scanLan` and
 * rendered by the Discover step… which the web flow skipped outright
 * (`WEB_STEPS = ["pair", "paired"]`). The probe ran for nobody, and the one
 * message that names the exact origin to allowlist was unreachable from the
 * screen whose failures it explains.
 *
 * It comes back as a status line rather than a step. A browser has at most one
 * candidate, and finding it does not get you any closer to being paired — you
 * still need a fresh invitation from that Host. So the useful part is the
 * *fact*, standing next to the form, not a list to pick from.
 *
 * # `absent` is a claim, and it is earned
 *
 * The three outcomes are genuinely distinguishable, and saying so is the whole
 * point: a cross-origin `fetch` collapses "no CORS header", "untrusted
 * certificate" and "nothing listening" into one bare `TypeError`, and a
 * `mode: "no-cors"` retry that resolves opaquely is the one bit that separates
 * "it refused this browser" from "there is nothing there". Without that bit
 * this component would be stating an absence it never verified.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CopyIcon, Loader2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { cn } from "@/lib/utils"

import type { PairHostState } from "./pair-scene"

export interface HostProbeStatusProps {
  state: PairHostState
  /** Where the Host answered. Present for `reachable` and `blocked`. */
  baseUrl?: string
  /** Version reported by `/healthz`. Present for `reachable`. */
  serverVersion?: string
  /** This tab's own origin — the exact string to allowlist. `blocked` only. */
  origin?: string
  className?: string
}

const DOT_CLASS: Record<PairHostState, string> = {
  searching: "bg-muted-foreground/60",
  absent: "bg-muted-foreground/40",
  blocked: "bg-amber-500",
  reachable: "bg-brand-action",
}

function displayHost(baseUrl: string | undefined): string {
  if (!baseUrl) return ""
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export function HostProbeStatus({
  state,
  baseUrl,
  serverVersion,
  origin,
  className,
}: HostProbeStatusProps) {
  const t = useTranslations("mobile.pair.hostProbe")
  const [copied, setCopied] = useState(false)

  const onCopyOrigin = useCallback(async () => {
    if (!origin) return
    try {
      await writeClipboardText(origin)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }, [origin])

  return (
    <div
      className={cn("flex flex-col gap-1.5 text-xs", className)}
      data-testid="pair-host-probe"
      data-state={state}
      role="status"
      aria-live="polite"
    >
      <p className="flex items-center gap-2 leading-relaxed">
        {state === "searching" ? (
          <Loader2Icon
            className="size-3 shrink-0 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <span
            aria-hidden="true"
            className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[state])}
          />
        )}
        <span className={cn("min-w-0", state === "reachable" ? "text-foreground" : "text-muted-foreground")}>
          {t(state, { host: displayHost(baseUrl), version: serverVersion ?? "" })}
        </span>
      </p>

      {/* The exact allowlist string, copyable. A user retyping an origin by
          hand gets the port or the scheme wrong and the Host keeps refusing
          them for a reason the screen already knew. */}
      {state === "blocked" && origin ? (
        <div className="flex items-center gap-1.5 rounded-control bg-amber-500/10 px-2 py-1">
          <code
            className="min-w-0 flex-1 font-mono text-[11px] break-all"
            data-testid="pair-host-probe-origin"
          >
            {origin}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            onClick={() => void onCopyOrigin()}
            aria-label={copied ? t("originCopied") : t("copyOrigin")}
            data-testid="pair-host-probe-copy-origin"
          >
            {copied ? (
              <CheckIcon className="size-3.5" aria-hidden="true" />
            ) : (
              <CopyIcon className="size-3.5" aria-hidden="true" />
            )}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
