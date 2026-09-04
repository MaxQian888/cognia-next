"use client"

// The quick-unlock half of the lock screen.
//
// Owns method selection, the input surface for whichever method is chosen, and
// the failure messaging. The password form stays where it was and is always
// one click away, because the password is the only factor that stands alone
// and a lock screen that can strand you behind a forgotten PIN is a lock
// screen that has locked you out of your own machine.
//
// Locked-out methods are RENDERED, disabled, with the reason. Hiding them
// would collapse three different situations into one blank space: never
// enrolled, enrolled and available, and enrolled but disabled after too many
// attempts. The user needs to tell those apart.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { FingerprintIcon, GridIcon, KeyRoundIcon, LockKeyholeIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { canonicalizePattern, canonicalizePin } from "@/lib/accounts/quick-unlock/secret-policy"
import {
  canonicalizePasskeySecret,
  derivePasskeySecret,
  type PasskeyFailure,
} from "@/lib/accounts/quick-unlock/passkey"
import {
  attemptsRemaining,
  isEnrollmentUsable,
  type QuickUnlockEnrollment,
  type QuickUnlockMethod,
} from "@/lib/accounts/quick-unlock/types"
import type { QuickUnlockFailure } from "@/lib/accounts/quick-unlock/client"
import { PinPad } from "./pin-pad"
import { PatternGrid } from "./pattern-grid"

export interface QuickUnlockPanelProps {
  localAccountId: string
  enrollments: QuickUnlockEnrollment[]
  /** Resolves to whether the account opened. Never throws on a wrong secret. */
  onQuickUnlock: (
    method: QuickUnlockMethod,
    canonicalSecret: string
  ) => Promise<{ ok: boolean; reason?: QuickUnlockFailure }>
  /** Switches the lock screen back to the password form. */
  onUsePassword: () => void
  disabled?: boolean
}

const METHOD_ICON: Record<QuickUnlockMethod, typeof KeyRoundIcon> = {
  pin: KeyRoundIcon,
  pattern: GridIcon,
  passkey: FingerprintIcon,
}

export function QuickUnlockPanel({
  localAccountId,
  enrollments,
  onQuickUnlock,
  onUsePassword,
  disabled = false,
}: QuickUnlockPanelProps) {
  const t = useTranslations("account.quickUnlock")

  // Ordered so the method most likely to be wanted comes first, and a
  // locked-out one never becomes the default landing surface.
  const ordered = useMemo(
    () =>
      [...enrollments].sort((a, b) => {
        const usable = Number(isEnrollmentUsable(b)) - Number(isEnrollmentUsable(a))
        if (usable !== 0) return usable
        return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)
      }),
    [enrollments]
  )

  const [selected, setSelected] = useState<QuickUnlockMethod | null>(
    () => ordered.find(isEnrollmentUsable)?.method ?? ordered[0]?.method ?? null
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const active = ordered.find((entry) => entry.method === selected) ?? null
  const activeUsable = active !== null && isEnrollmentUsable(active)
  const inputsDisabled = disabled || busy || !activeUsable

  const submit = async (method: QuickUnlockMethod, canonicalSecret: string) => {
    setBusy(true)
    setError(null)
    try {
      const result = await onQuickUnlock(method, canonicalSecret)
      if (!result.ok) {
        setError(t(`failure.${result.reason ?? "wrong-secret"}`))
      }
    } catch {
      setError(t("failure.failed"))
    } finally {
      setBusy(false)
    }
  }

  const runPasskey = async () => {
    if (!active) return
    setBusy(true)
    setError(null)
    try {
      const credentialId = String(
        (active.verifier as { credentialId?: unknown }).credentialId ?? ""
      )
      if (!credentialId) {
        setError(t("failure.not-enrolled"))
        return
      }
      const derived = await derivePasskeySecret({ localAccountId, credentialId })
      if (!derived.ok) {
        // A cancelled prompt is not a failed credential, and saying otherwise
        // would tell a user their passkey is broken when they just changed
        // their mind.
        setError(t(`passkeyFailure.${derived.reason satisfies PasskeyFailure}`))
        return
      }
      const result = await onQuickUnlock("passkey", canonicalizePasskeySecret(derived.value))
      if (!result.ok) setError(t(`failure.${result.reason ?? "wrong-secret"}`))
    } catch {
      setError(t("failure.failed"))
    } finally {
      setBusy(false)
    }
  }

  if (ordered.length === 0) return null

  const remaining = active ? attemptsRemaining(active) : 0
  const hint = activeUsable && remaining <= 2 ? t("attemptsLeft", { count: remaining }) : undefined

  return (
    <section
      className="flex flex-col items-center gap-4"
      data-testid="quick-unlock-panel"
      aria-label={t("panelLabel")}
    >
      {ordered.length > 1 && (
        <div className="flex gap-1" role="tablist" aria-label={t("methodLabel")}>
          {ordered.map((entry) => {
            const Icon = METHOD_ICON[entry.method]
            const usable = isEnrollmentUsable(entry)
            return (
              <Button
                key={entry.method}
                type="button"
                role="tab"
                aria-selected={selected === entry.method}
                variant={selected === entry.method ? "secondary" : "ghost"}
                size="sm"
                disabled={disabled || busy}
                className={cn("gap-1.5", !usable && "opacity-60")}
                onClick={() => {
                  setSelected(entry.method)
                  setError(null)
                }}
                data-testid={`quick-unlock-tab-${entry.method}`}
              >
                <Icon className="size-3.5" />
                {t(`method.${entry.method}`)}
              </Button>
            )
          })}
        </div>
      )}

      {active && !activeUsable && (
        <p
          className="max-w-xs text-center text-xs text-destructive"
          role="alert"
          data-testid="quick-unlock-locked-out"
        >
          {t("lockedOut", { method: t(`method.${active.method}`) })}
        </p>
      )}

      {active?.method === "pin" && (
        <PinPad
          onSubmit={(pin) => void submit("pin", canonicalizePin(pin))}
          disabled={inputsDisabled}
          error={error}
          hint={hint}
        />
      )}

      {active?.method === "pattern" && (
        <PatternGrid
          onSubmit={(nodes) => void submit("pattern", canonicalizePattern(nodes))}
          disabled={inputsDisabled}
          error={error}
          hint={hint}
        />
      )}

      {active?.method === "passkey" && (
        <div className="flex flex-col items-center gap-3">
          <Button
            type="button"
            size="lg"
            disabled={inputsDisabled}
            onClick={() => void runPasskey()}
            data-testid="quick-unlock-passkey"
          >
            {busy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <FingerprintIcon data-icon="inline-start" />
            )}
            {t(busy ? "passkeyWaiting" : "passkeyAction")}
          </Button>
          {error ? (
            <p className="max-w-xs text-center text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : hint ? (
            <p className="text-xs text-muted-foreground">{hint}</p>
          ) : null}
        </div>
      )}

      <Button
        type="button"
        variant="link"
        size="sm"
        disabled={busy}
        onClick={onUsePassword}
        data-testid="quick-unlock-use-password"
      >
        <LockKeyholeIcon data-icon="inline-start" />
        {t("usePassword")}
      </Button>
    </section>
  )
}
