"use client"

// Setting up and removing quick-unlock methods.
//
// Enrollment always takes the account PASSWORD, even on runtimes where the
// backend could technically proceed without it. Adding a PIN mints a new way
// into the account, and the bar for that has to be proof of the factor it is
// being layered onto, not merely "this machine is currently unlocked". A
// signed-in laptop left on a desk should not be enough for a passer-by to add
// their own PIN.
//
// Confirmation is required for a PIN and a pattern, and for the ordinary
// reason: neither is echoed back, so a typo at enrollment would be discovered
// only at the next lock, by which point the correct value is unknowable.

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckIcon,
  FingerprintIcon,
  GridIcon,
  KeyRoundIcon,
  PlusIcon,
  TrashIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import {
  canonicalizePattern,
  canonicalizePin,
  validatePattern,
  validatePin,
} from "@/lib/accounts/quick-unlock/secret-policy"
import {
  canonicalizePasskeySecret,
  enrollPasskey,
  isPasskeySupported,
} from "@/lib/accounts/quick-unlock/passkey"
import {
  isEnrollmentUsable,
  QUICK_UNLOCK_METHODS,
  type QuickUnlockEnrollment,
  type QuickUnlockMethod,
} from "@/lib/accounts/quick-unlock/types"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import { PinPad } from "./pin-pad"
import { PatternGrid } from "./pattern-grid"

export interface QuickUnlockSettingsProps {
  account: LocalAccountRecord
  onEnroll: (args: {
    accountId: string
    method: QuickUnlockMethod
    canonicalSecret: string
    password: string
    verifier?: Record<string, unknown>
  }) => Promise<void>
  onRemove: (accountId: string, method: QuickUnlockMethod) => Promise<void>
  onClearLockout: (accountId: string, method: QuickUnlockMethod, password: string) => Promise<void>
}

const METHOD_ICON: Record<QuickUnlockMethod, typeof KeyRoundIcon> = {
  pin: KeyRoundIcon,
  pattern: GridIcon,
  passkey: FingerprintIcon,
}

type Draft =
  | { kind: "idle" }
  | { kind: "pin"; first: string | null }
  | { kind: "pattern"; first: number[] | null }
  | { kind: "passkey" }

export function QuickUnlockSettings({
  account,
  onEnroll,
  onRemove,
  onClearLockout,
}: QuickUnlockSettingsProps) {
  const t = useTranslations("account.quickUnlock.settings")
  const tMethod = useTranslations("account.quickUnlock.method")
  const tPolicy = useTranslations("account.quickUnlock.policy")

  const enrolled = account.quickUnlock ?? []
  const [draft, setDraft] = useState<Draft>({ kind: "idle" })
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Passkey is HIDDEN rather than disabled where the platform has no WebAuthn
  // at all, because there is nothing the user could do to make it appear. A
  // disabled control implies a fix exists.
  const available = QUICK_UNLOCK_METHODS.filter(
    (method) => method !== "passkey" || isPasskeySupported()
  )

  const reset = () => {
    setDraft({ kind: "idle" })
    setError(null)
  }

  const commit = async (
    method: QuickUnlockMethod,
    canonicalSecret: string,
    verifier?: Record<string, unknown>
  ) => {
    setBusy(true)
    setError(null)
    try {
      await onEnroll({ accountId: account.id, method, canonicalSecret, password, verifier })
      setPassword("")
      reset()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("enrollFailed"))
    } finally {
      setBusy(false)
    }
  }

  const submitPin = (pin: string) => {
    if (draft.kind !== "pin") return
    if (draft.first === null) {
      const verdict = validatePin(pin)
      if (!verdict.ok) {
        setError(tPolicy(verdict.reason))
        return
      }
      setError(null)
      setDraft({ kind: "pin", first: pin.trim() })
      return
    }
    if (draft.first !== pin.trim()) {
      setError(t("pinMismatch"))
      setDraft({ kind: "pin", first: null })
      return
    }
    void commit("pin", canonicalizePin(pin))
  }

  const submitPattern = (nodes: number[]) => {
    if (draft.kind !== "pattern") return
    if (draft.first === null) {
      const verdict = validatePattern(nodes)
      if (!verdict.ok) {
        setError(tPolicy(verdict.reason))
        return
      }
      setError(null)
      setDraft({ kind: "pattern", first: nodes })
      return
    }
    if (draft.first.join("-") !== nodes.join("-")) {
      setError(t("patternMismatch"))
      setDraft({ kind: "pattern", first: null })
      return
    }
    void commit("pattern", canonicalizePattern(nodes))
  }

  const runPasskeyEnrollment = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await enrollPasskey({
        localAccountId: account.id,
        displayName: account.displayName,
      })
      if (!result.ok) {
        setError(t(`passkeyFailure.${result.reason}`))
        return
      }
      await commit("passkey", canonicalizePasskeySecret(result.value.secret), {
        credentialId: result.value.enrollment.credentialId,
      })
    } catch {
      setError(t("enrollFailed"))
    } finally {
      setBusy(false)
    }
  }

  const passwordReady = password.length > 0

  return (
    <section className="space-y-3" data-testid="quick-unlock-settings">
      <div className="space-y-0.5">
        <Label className="text-sm">{t("title")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {enrolled.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("none")}</p>
      ) : (
        <div className="space-y-1">
          {enrolled.map((entry) => (
            <EnrolledRow
              key={entry.method}
              entry={entry}
              label={tMethod(entry.method)}
              busy={busy}
              lockedLabel={t("lockedOut")}
              activeLabel={t("active")}
              removeLabel={t("remove", { method: tMethod(entry.method) })}
              reenableLabel={t("reenable")}
              canReenable={passwordReady}
              onRemove={() => void onRemove(account.id, entry.method)}
              onClearLockout={() => void onClearLockout(account.id, entry.method, password)}
            />
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="quick-unlock-password" className="text-xs">
          {t("passwordLabel")}
        </Label>
        <Input
          id="quick-unlock-password"
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
          data-testid="quick-unlock-password"
        />
        <p className="text-xs text-muted-foreground">{t("passwordHint")}</p>
      </div>

      {draft.kind === "idle" ? (
        <div className="flex flex-wrap gap-2">
          {available.map((method) => {
            const Icon = METHOD_ICON[method]
            const already = enrolled.some((entry) => entry.method === method)
            return (
              <Button
                key={method}
                type="button"
                variant="outline"
                size="sm"
                disabled={!passwordReady || busy}
                onClick={() => {
                  setError(null)
                  setDraft(
                    method === "pin"
                      ? { kind: "pin", first: null }
                      : method === "pattern"
                        ? { kind: "pattern", first: null }
                        : { kind: "passkey" }
                  )
                }}
                data-testid={`quick-unlock-add-${method}`}
              >
                <Icon data-icon="inline-start" />
                {already
                  ? t("replace", { method: tMethod(method) })
                  : t("add", { method: tMethod(method) })}
              </Button>
            )
          })}
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border p-3" data-testid="quick-unlock-draft">
          <p className="text-xs text-muted-foreground" data-testid="quick-unlock-draft-step">
            {draft.kind === "pin"
              ? t(draft.first === null ? "pinEnter" : "pinConfirm")
              : draft.kind === "pattern"
                ? t(draft.first === null ? "patternDraw" : "patternConfirm")
                : t("passkeyPrompt")}
          </p>

          {draft.kind === "pin" && (
            <PinPad
              onSubmit={submitPin}
              disabled={busy}
              error={error}
              testIdPrefix="enroll-pin"
              submitLabel={t(draft.first === null ? "continue" : "confirm")}
            />
          )}

          {draft.kind === "pattern" && (
            <PatternGrid
              onSubmit={submitPattern}
              disabled={busy}
              error={error}
              testIdPrefix="enroll-pattern"
              submitLabel={t(draft.first === null ? "continue" : "confirm")}
            />
          )}

          {draft.kind === "passkey" && (
            <div className="space-y-2">
              <Button
                type="button"
                disabled={busy}
                onClick={() => void runPasskeyEnrollment()}
                data-testid="quick-unlock-enroll-passkey"
              >
                {busy ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <FingerprintIcon data-icon="inline-start" />
                )}
                {t("passkeyAction")}
              </Button>
              {error && (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={reset}
            data-testid="quick-unlock-cancel"
          >
            {t("cancel")}
          </Button>
        </div>
      )}

      {draft.kind === "idle" && error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

interface EnrolledRowProps {
  entry: QuickUnlockEnrollment
  label: string
  busy: boolean
  lockedLabel: string
  activeLabel: string
  removeLabel: string
  reenableLabel: string
  canReenable: boolean
  onRemove: () => void
  onClearLockout: () => void
}

function EnrolledRow({
  entry,
  label,
  busy,
  lockedLabel,
  activeLabel,
  removeLabel,
  reenableLabel,
  canReenable,
  onRemove,
  onClearLockout,
}: EnrolledRowProps) {
  const usable = isEnrollmentUsable(entry)
  const Icon = METHOD_ICON[entry.method]
  return (
    <Item size="sm" className="px-0" data-testid={`quick-unlock-row-${entry.method}`}>
      <ItemContent>
        <ItemTitle className="flex items-center gap-1.5 text-xs">
          <Icon className="size-3.5 shrink-0" />
          {label}
        </ItemTitle>
        <ItemDescription
          className={cn("text-[11px]", !usable && "text-destructive")}
          data-testid={`quick-unlock-status-${entry.method}`}
        >
          {usable ? (
            <span className="flex items-center gap-1">
              <CheckIcon className="size-3" />
              {activeLabel}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <TriangleAlertIcon className="size-3" />
              {lockedLabel}
            </span>
          )}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {!usable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !canReenable}
            onClick={onClearLockout}
            data-testid={`quick-unlock-reenable-${entry.method}`}
          >
            <PlusIcon data-icon="inline-start" />
            {reenableLabel}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onRemove}
          aria-label={removeLabel}
          data-testid={`quick-unlock-remove-${entry.method}`}
        >
          <TrashIcon className="size-3.5" />
        </Button>
      </ItemActions>
    </Item>
  )
}
