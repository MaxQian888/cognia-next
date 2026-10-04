"use client"

/**
 * The browser/mobile counterpart of `LanDiscoveryPanel`.
 *
 * mDNS needs a multicast socket, which a tab does not have, so the desktop's
 * `_cognia._tcp` sweep is simply unavailable off Tauri. What a tab *can* do is
 * probe its own machine's loopback browser-access listener, and
 * `lib/connectivity/loopback-discovery.ts` already implements exactly that,
 * including the `no-cors` retry that separates "a host refused this origin"
 * from "nothing is listening". It was written for this case and until now had
 * only two callers (the LAN scanner and `/pair`).
 *
 * The three outcomes are kept distinct on purpose. `blocked` is the one that
 * matters: it names the exact origin to allowlist on the other machine, which
 * is the difference between an actionable message and "no hosts found".
 *
 * A found host is NOT something the form can pair with by address. Pairing
 * redeems a signed one-shot `cgnp<N>|…` invitation (`decodePairPayload`), and
 * a bare URL is not one: this panel used to offer "Use this address", which
 * put `http://127.0.0.1:27891` into the invitation field and made every submit
 * fail as `wrong_format`. What the user actually needs from a found host is the
 * invitation, so the panel now hands over the command that mints one aimed at
 * the address it just found. `--advertise-url` matters: without it
 * `cognia-server pair` encodes `https://127.0.0.1:27890`, which a tab can
 * neither pin nor validate (see `HEADLESS_PAIR_COMMANDS`).
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CopyIcon, RadarIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  discoverLoopbackHost,
  type LoopbackProbeOutcome,
} from "@/lib/connectivity/loopback-discovery"
import { writeClipboardText } from "@/lib/tauri/clipboard"

export interface LoopbackDiscoveryPanelProps {
  /** Test seam. Defaults to the real loopback probe. */
  discover?: typeof discoverLoopbackHost
}

/**
 * The command that mints an invitation this tab can redeem from the host at
 * `baseUrl`. Exported so the test pins the exact string the user will run.
 */
export function loopbackPairCommand(baseUrl: string): string {
  return `cognia-server pair --device-name browser --advertise-url ${baseUrl}`
}

type CopyState = "idle" | "copied" | "failed"

export function LoopbackDiscoveryPanel({
  discover = discoverLoopbackHost,
}: LoopbackDiscoveryPanelProps) {
  const t = useTranslations("settings.remoteHosts.add.loopback")
  const [outcome, setOutcome] = useState<LoopbackProbeOutcome | null>(null)
  const [probing, setProbing] = useState(false)
  const [copy, setCopy] = useState<CopyState>("idle")
  const abortRef = useRef<AbortController | null>(null)

  // A probe that outlives the panel would set state on an unmounted tree and,
  // worse, keep two loopback fetches racing if the user reopens the sheet.
  useEffect(() => () => abortRef.current?.abort(), [])

  const onProbe = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setProbing(true)
    setCopy("idle")
    try {
      setOutcome(await discover({ signal: controller.signal }))
    } finally {
      if (!controller.signal.aborted) setProbing(false)
    }
  }, [discover])

  const onCopyCommand = useCallback(async (command: string) => {
    try {
      await writeClipboardText(command)
      setCopy("copied")
    } catch {
      // A browser without clipboard-write permission refuses. The command is
      // on screen in full, so the failure line says to copy it by hand rather
      // than leaving a button that silently did nothing.
      setCopy("failed")
    }
  }, [])

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="loopback-discovery-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t("title")}</span>
        <Button variant="outline" size="sm" onClick={onProbe} disabled={probing}>
          <RadarIcon aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          {probing ? t("probing") : t("probe")}
        </Button>
      </div>

      {outcome?.kind === "found" ? (
        <div className="space-y-1.5" data-testid="loopback-found">
          <p className="text-xs text-success">
            {t("found", { version: outcome.health.version, url: outcome.baseUrl })}
          </p>
          <p className="text-xs text-muted-foreground">{t("foundHint")}</p>
          <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
            {/* Wraps rather than scrolls: a command cut mid-flag reads as
                complete and does not parse (see `HeadlessInvitationHelp`). */}
            <code
              className="min-w-0 flex-1 break-all font-mono text-[11px]"
              data-testid="loopback-pair-command"
            >
              {loopbackPairCommand(outcome.baseUrl)}
            </code>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("copyCommand")}
              title={t("copyCommand")}
              onClick={() => void onCopyCommand(loopbackPairCommand(outcome.baseUrl))}
              data-testid="loopback-copy-command"
            >
              {copy === "copied" ? (
                <CheckIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <CopyIcon className="size-3.5" aria-hidden="true" />
              )}
            </Button>
          </div>
          {copy === "copied" ? (
            <p role="status" className="text-xs text-muted-foreground">
              {t("commandCopied")}
            </p>
          ) : copy === "failed" ? (
            <p role="status" className="text-xs text-warning">
              {t("copyFailed")}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Something answered, but this tab's origin is not on the host's
          allowlist. Naming the origin verbatim is the whole point: it is the
          exact string the user has to paste on the other machine. */}
      {outcome?.kind === "blocked" ? (
        <div className="space-y-0.5" data-testid="loopback-blocked">
          <p className="text-xs text-warning">{t("blocked", { url: outcome.baseUrl })}</p>
          <p className="text-xs text-muted-foreground">
            {t("blockedHint", { origin: outcome.origin })}
          </p>
        </div>
      ) : null}

      {outcome?.kind === "absent" ? (
        <div className="space-y-0.5" data-testid="loopback-absent">
          <p className="text-xs text-muted-foreground">{t("absent")}</p>
          <p className="text-xs text-muted-foreground">{t("absentHint")}</p>
        </div>
      ) : null}
    </div>
  )
}
