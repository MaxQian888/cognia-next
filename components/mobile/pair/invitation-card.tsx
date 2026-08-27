"use client"

/**
 * What an accepted `cgnp3` invitation looks like once it has been read.
 *
 * # The blob is not the content
 *
 * A `cgnp3` payload is ~800 characters of base64url. Rendered in a `min-h-24`
 * monospace textarea it was the single largest element on `/pair` — thirteen
 * lines of noise nobody reads, nobody types, and nobody can verify by eye,
 * occupying the position the page's actual subject should hold. Everything a
 * person needs from it is already decoded before the field is even submitted:
 * which Host it points at, what version that Host is, and how long it stays
 * redeemable. That is what this card shows.
 *
 * The raw string stays reachable *and editable* — a support conversation
 * genuinely needs it, and a user who pasted the wrong thing has to be able to
 * fix it — but behind a disclosure, which is the correct weight for a value
 * whose only other consumer is a machine. The field is `forceMount`ed rather
 * than unmounted with the disclosure: it is the form's controlled input, and a
 * control that disappears from the tree when a chevron is closed is a control
 * whose value the form no longer owns.
 *
 * # Why it carries the tone
 *
 * The old screen rendered the green "Invitation ready for …" summary from the
 * decoded payload alone, unconditionally. So a failed attempt showed a green
 * "ready" line, a red "your account is locked" panel and an amber "this
 * invitation is spent" banner at the same time, all describing the same
 * invitation. The three states are mutually exclusive; one element owns them.
 */

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDownIcon,
  KeyRoundIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { PairPayload } from "@/lib/qr/pair-payload"

/**
 * `ready` — decoded and redeemable. `spent` — the Host consumed it, so no
 * amount of retrying can work. `failed` — the attempt failed for a reason that
 * leaves it redeemable.
 */
export type InvitationTone = "ready" | "spent" | "failed"

export interface InvitationCardProps {
  invitation: PairPayload
  /**
   * The editable raw-payload field, rendered inside the disclosure and kept
   * mounted whether it is open or not.
   */
  children?: ReactNode
  tone?: InvitationTone
  /** Clear the field so a fresh invitation can be pasted. */
  onClear?: () => void
  disabled?: boolean
  className?: string
}

/** Host and port — the part of a base URL a person actually recognises. */
export function displayPairHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

const TONE_CLASS: Record<InvitationTone, string> = {
  ready: "border-brand-action/45 bg-brand-action/5",
  spent: "border-amber-500/45 bg-amber-500/5",
  failed: "border-destructive/40 bg-destructive/5",
}

const TONE_ICON_CLASS: Record<InvitationTone, string> = {
  ready: "text-brand-action",
  spent: "text-amber-600 dark:text-amber-400",
  failed: "text-destructive",
}

export function InvitationCard({
  invitation,
  children,
  tone = "ready",
  onClear,
  disabled = false,
  className,
}: InvitationCardProps) {
  const t = useTranslations("mobile.pair.invitationCard")
  const [rawOpen, setRawOpen] = useState(false)

  const Icon = tone === "ready" ? ShieldCheckIcon : tone === "spent" ? KeyRoundIcon : ShieldXIcon

  return (
    <div
      className={cn("rounded-xl border p-4", TONE_CLASS[tone], className)}
      data-testid="pair-invitation-card"
      data-tone={tone}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={cn("mt-0.5 size-4 shrink-0", TONE_ICON_CLASS[tone])}
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-sm font-medium" data-testid="pair-invitation-host">
            {displayPairHost(invitation.baseUrl)}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(`state.${tone}`, {
              version: invitation.serverVersion,
              expiresAt: new Date(invitation.expiresAt),
            })}
          </p>
        </div>
        {onClear ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="-mt-1 -mr-1 shrink-0"
            onClick={onClear}
            disabled={disabled}
            data-testid="pair-clear-payload"
          >
            <XIcon className="size-3.5" aria-hidden="true" />
            {t("replace")}
          </Button>
        ) : null}
      </div>

      <Collapsible open={rawOpen} onOpenChange={setRawOpen} className="mt-1">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="-ml-2 text-muted-foreground"
            data-testid="pair-invitation-raw-toggle"
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", rawOpen && "rotate-180")}
              aria-hidden="true"
            />
            {t("showRaw")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent forceMount hidden={!rawOpen}>
          <div className="mt-1.5" data-testid="pair-invitation-raw">
            {children}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
