"use client"

/**
 * The lock screen.
 *
 * Split out of `AccountGate`, which was rendering four unrelated screens from
 * one function body and gave this one thirty lines: a heading, a bare password
 * field and a button that only ever went grey.
 *
 * What that omission cost is the reason this file is as long as it is. Unlocking
 * is not a toggle — it verifies a password (Argon2id on the desktop host,
 * PBKDF2 at 600k iterations on the main thread in a browser), prepares the
 * runtime target, then re-runs a FULL database boot, because `lock()` closed the
 * cached Dexie connection. Several seconds is normal; two of those steps can
 * block indefinitely on another window holding the database. With no pending
 * state at all, "still working", "wedged forever", "wrong password" and "the
 * keystroke never reached the form" were the same picture: a grey button.
 *
 * So every one of those is now a distinct, nameable state:
 *   - the field takes focus on mount, so keystrokes land somewhere;
 *   - submitting shows a spinner, a changed label and the live pipeline stage;
 *   - past `slowAfterMs` the screen says it is slow, past `stuckAfterMs` it says
 *     it is stuck and offers the only three things that help;
 *   - failures render from a translated error CODE, never a raw `Error.message`;
 *   - the recovery key finally has somewhere to be typed.
 */

import type { FormEvent, KeyboardEvent, ReactNode } from "react"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowLeftIcon,
  CheckIcon,
  ClipboardIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
import { Surface } from "@/components/surface/surface"
import { codeOf, type AccountUnlockErrorCode } from "@/lib/accounts/account-unlock-error"
import { PASSWORD_MIN_LENGTH } from "@/lib/accounts/password-policy"
import {
  subscribeUnlockProgress,
  unlockStagesFor,
  type AccountUnlockStage,
} from "@/lib/accounts/unlock-progress"
import {
  clearUnlockFailures,
  readUnlockThrottle,
  recordFailedUnlock,
  type UnlockThrottleStatus,
} from "@/lib/accounts/unlock-throttle"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import { cn } from "@/lib/utils"
import { useCopy } from "@/hooks/ui/use-copy"
import { PasswordStrengthMeter } from "./password-strength-meter"
import { QuickUnlockPanel } from "./quick-unlock/quick-unlock-panel"
import { LockScreenBackdrop } from "./lock-screen-backdrop"
import { DEFAULT_LOCK_SCREEN, type LockScreenSettings } from "@/types/appearance/lock-screen"
import { isEnrollmentUsable, type QuickUnlockMethod } from "@/lib/accounts/quick-unlock/types"
import type { QuickUnlockFailure } from "@/lib/accounts/quick-unlock/client"

/** The unlock is taking longer than a healthy run — say so, keep waiting. */
export const DEFAULT_SLOW_AFTER_MS = 8_000
/** Long enough that a healthy boot has never taken this — offer the exits. */
export const DEFAULT_STUCK_AFTER_MS = 30_000

const STAGE_LABEL_KEY: Record<Exclude<AccountUnlockStage, "ready" | "failed">, string> = {
  verifying: "stageVerifying",
  "preparing-runtime": "stagePreparingRuntime",
  "opening-database": "stageOpeningDatabase",
  activating: "stageActivating",
}

const ERROR_KEY: Record<AccountUnlockErrorCode, string> = {
  "invalid-password": "errorInvalidPassword",
  "password-required": "errorPasswordRequired",
  "invalid-recovery-key": "errorInvalidRecoveryKey",
  "vault-not-provisioned": "errorVaultNotProvisioned",
  "vault-incompatible": "errorVaultIncompatible",
  "storage-layout-unsupported": "errorStorageLayoutUnsupported",
  throttled: "errorThrottled",
  unknown: "errorUnknown",
}

export interface AccountLockScreenProps {
  accounts: LocalAccountRecord[]
  activeAccountId: string | null
  onUnlock: (accountId: string, password: string) => Promise<void>
  /**
   * Redeem a Browser Vault recovery key and set a new password. Absent on the
   * desktop host, which mints no recovery key — see `supportsRecoveryKey`.
   */
  onRecoveryUnlock: (accountId: string, recoveryKey: string, newPassword: string) => Promise<void>
  /**
   * True on Browser Vault runtimes. Gates the recovery entry point and the
   * stage ladder, which has one more step there. Not dormancy: the desktop
   * host stores no recovery wrap, so there is genuinely nothing to redeem.
   */
  supportsRecoveryKey: boolean
  /**
   * Delete the local database that boot refused, then reload.
   *
   * Only reachable from the `storage-layout-unsupported` panel. Retyping a
   * password can never clear that failure, so without this the user is simply
   * stuck on the lock screen with a correct password and no way in.
   */
  onResetLocalStorage?: () => Promise<void>
  /**
   * Open the account with an enrolled PIN, pattern or passkey.
   *
   * Absent where no runtime supports it. Resolves to the outcome rather than
   * throwing on a wrong secret, because the attempt count has to be persisted
   * either way.
   */
  onQuickUnlock?: (
    accountId: string,
    method: QuickUnlockMethod,
    canonicalSecret: string
  ) => Promise<{ ok: boolean; reason?: QuickUnlockFailure }>
  /**
   * Lock-screen appearance. Absent falls back to the historical plain look,
   * so a caller that does not pass it gets exactly what shipped before.
   */
  appearance?: LockScreenSettings
  /**
   * The wallpaper the app was last showing, for the `wallpaper` backdrop.
   * Comes from the boot-safe mirror, not from the locked settings row.
   */
  activeWallpaperId?: string | null
  slowAfterMs?: number
  stuckAfterMs?: number
}

type Mode = "password" | "recovery" | "quick"

export function AccountLockScreen({
  accounts,
  activeAccountId,
  onUnlock,
  onRecoveryUnlock,
  supportsRecoveryKey,
  onQuickUnlock,
  appearance,
  activeWallpaperId = null,
  slowAfterMs = DEFAULT_SLOW_AFTER_MS,
  onResetLocalStorage,
  stuckAfterMs = DEFAULT_STUCK_AFTER_MS,
}: AccountLockScreenProps) {
  const t = useTranslations("account.gate")
  const passwordId = useId()
  const recoveryKeyId = useId()
  const newPasswordId = useId()
  const confirmPasswordId = useId()
  const accountPickerId = useId()
  const passwordRef = useRef<HTMLInputElement>(null)

  const [selectedId, setSelectedId] = useState<string | null>(
    () => activeAccountId ?? accounts[0]?.id ?? null
  )
  // Quick unlock is the DEFAULT surface where one is enrolled and usable, and
  // the password is one click away from it. Landing on the password field when
  // the user set up a PIN would make the PIN pointless.
  const quickEnrollments = (
    accounts.find((candidate) => candidate.id === (activeAccountId ?? accounts[0]?.id))
      ?.quickUnlock ?? []
  ).filter(() => onQuickUnlock !== undefined)
  const lockAppearance: LockScreenSettings = { ...DEFAULT_LOCK_SCREEN, ...(appearance ?? {}) }
  const [mode, setMode] = useState<Mode>(() =>
    quickEnrollments.some(isEnrollmentUsable) ? "quick" : "password"
  )
  const [password, setPassword] = useState("")
  const [recoveryKey, setRecoveryKey] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [reveal, setReveal] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [stage, setStage] = useState<AccountUnlockStage | null>(null)
  const [errorCode, setErrorCode] = useState<AccountUnlockErrorCode | null>(null)
  const [resetting, setResetting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const { copied, copy } = useCopy({ scope: "account unlock diagnostics" })

  // Abandoning a wedged attempt cannot cancel the promise behind it — nothing in
  // the pipeline is abortable. The token lets a resumed-from-the-dead attempt
  // resolve into the void instead of overwriting a newer one's state.
  const attemptRef = useRef(0)

  const account = useMemo(
    () => accounts.find((candidate) => candidate.id === selectedId) ?? accounts[0] ?? null,
    [accounts, selectedId]
  )
  const accountId = account?.id ?? null

  const [throttle, setThrottle] = useState<UnlockThrottleStatus>(() =>
    accountId ? readUnlockThrottle(accountId) : EMPTY_THROTTLE
  )

  // Reset on account change, during render rather than in an effect: an effect
  // would paint one frame of the previous account's cooldown and error before
  // correcting itself. React's own "adjust state when a prop changes" pattern.
  const [throttleAccountId, setThrottleAccountId] = useState(accountId)
  if (accountId !== throttleAccountId) {
    setThrottleAccountId(accountId)
    setThrottle(accountId ? readUnlockThrottle(accountId) : EMPTY_THROTTLE)
    setErrorCode(null)
    setLocalError(null)
  }

  useEffect(() => {
    if (submitting) return
    passwordRef.current?.focus()
  }, [submitting, mode])

  useEffect(() => subscribeUnlockProgress(({ stage: next }) => setStage(next)), [])

  // One clock drives both the elapsed readout and the cooldown countdown, so a
  // second of wall time never advances one and not the other. The interval only
  // stamps `now`; both readouts are derived, so nothing here writes state
  // synchronously from an effect body.
  const ticking = submitting || throttle.blocked
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [ticking])

  const elapsedMs = submitting && startedAt > 0 ? Math.max(0, now - startedAt) : 0
  const cooldownStatus = useMemo(
    () => (accountId ? projectCooldown(throttle, now) : EMPTY_THROTTLE),
    [accountId, throttle, now]
  )

  const stages = useMemo(() => unlockStagesFor(supportsRecoveryKey), [supportsRecoveryKey])
  const stageIndex = stage ? stages.indexOf(stage) : -1
  const slow = submitting && elapsedMs >= slowAfterMs
  const stuck = submitting && elapsedMs >= stuckAfterMs
  const blocked = cooldownStatus.blocked

  const run = useCallback(async (work: () => Promise<void>, targetAccountId: string) => {
    const attempt = attemptRef.current + 1
    attemptRef.current = attempt
    const now = Date.now()
    setStartedAt(now)
    setNow(now)
    setSubmitting(true)
    setStage(null)
    setErrorCode(null)
    setLocalError(null)
    try {
      await work()
      if (attemptRef.current !== attempt) return
      clearUnlockFailures(targetAccountId)
      setThrottle(EMPTY_THROTTLE)
      setPassword("")
      setRecoveryKey("")
      setNewPassword("")
      setConfirmPassword("")
    } catch (error) {
      if (attemptRef.current !== attempt) return
      const code = codeOf(error)
      setErrorCode(code)
      // Only a rejected credential counts against the allowance. A database
      // that would not open is not a failed guess, and charging it would lock
      // the user out of their own machine for a bug on our side.
      if (code === "invalid-password" || code === "invalid-recovery-key") {
        setThrottle(recordFailedUnlock(targetAccountId))
      }
    } finally {
      if (attemptRef.current === attempt) {
        setSubmitting(false)
        setStage(null)
      }
    }
  }, [])

  const handlePasswordSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!accountId || submitting || blocked) return
    void run(() => onUnlock(accountId, password), accountId)
  }

  const handleRecoverySubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!accountId || submitting) return
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setLocalError(t("passwordTooShort", { min: PASSWORD_MIN_LENGTH }))
      return
    }
    if (newPassword !== confirmPassword) {
      setLocalError(t("passwordMismatch"))
      return
    }
    void run(() => onRecoveryUnlock(accountId, recoveryKey, newPassword), accountId)
  }

  const abandon = () => {
    attemptRef.current += 1
    setSubmitting(false)
    setStage(null)
  }

  const copyDiagnostics = () => {
    void copy(
      [
        `stage=${stage ?? "unknown"}`,
        `elapsedMs=${Math.round(elapsedMs)}`,
        `runtime=${supportsRecoveryKey ? "browser-vault" : "desktop-host"}`,
        `mode=${mode}`,
        `errorCode=${errorCode ?? "none"}`,
      ].join(" ")
    )
  }

  const trackCapsLock = (event: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(event.getModifierState("CapsLock"))
  }

  const visibleError = localError ?? (errorCode ? t(ERROR_KEY[errorCode]) : null)
  // A refused storage layout is not a credential problem, so the password form
  // is the wrong affordance entirely: the panel below replaces it.
  const layoutUnsupported = errorCode === "storage-layout-unsupported"

  return (
    <section
      aria-label={mode === "recovery" ? t("recoveryUnlockForm") : t("unlockForm")}
      data-testid="account-lock-screen"
      className="flex w-full max-w-sm flex-col gap-4"
    >
      <LockScreenBackdrop settings={lockAppearance} activeWallpaperId={activeWallpaperId} />

      <header className="flex flex-col items-center gap-2 text-center">
        {lockAppearance.showAvatar && (
          <div className="relative">
            <AvatarBadge
              subject={{
                name: account?.displayName ?? t("unknownAccount"),
                avatarImageUrl: account?.avatarDataUrl,
              }}
              size={52}
              textClassName="text-base font-medium"
            />
            <Surface
              aria-hidden="true"
              className="absolute -right-0.5 -bottom-0.5 flex size-5 items-center justify-center rounded-full border"
            >
              <LockKeyholeIcon className="size-3 text-muted-foreground" />
            </Surface>
          </div>
        )}
        <h1 className="text-lg font-semibold">
          {t("unlockTitle", { name: account?.displayName ?? t("unknownAccount") })}
        </h1>
        <p className="text-xs text-muted-foreground">
          {t(supportsRecoveryKey ? "runtimeBadgeBrowser" : "runtimeBadgeDesktop")}
        </p>
      </header>

      {accounts.length > 1 && (
        <FieldBlock>
          <Label htmlFor={accountPickerId}>{t("switchAccountLabel")}</Label>
          <NativeSelect
            id={accountPickerId}
            value={accountId ?? ""}
            disabled={submitting}
            data-testid="account-lock-screen-picker"
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {accounts.map((candidate) => (
              <NativeSelectOption key={candidate.id} value={candidate.id}>
                {candidate.displayName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </FieldBlock>
      )}

      {mode === "quick" && onQuickUnlock && accountId ? (
        <QuickUnlockPanel
          accountId={accountId}
          enrollments={accounts.find((candidate) => candidate.id === accountId)?.quickUnlock ?? []}
          disabled={submitting}
          onQuickUnlock={(method, canonicalSecret) =>
            onQuickUnlock(accountId, method, canonicalSecret)
          }
          onUsePassword={() => setMode("password")}
        />
      ) : mode === "password" ? (
        <form
          className="flex flex-col gap-4"
          hidden={layoutUnsupported}
          onSubmit={handlePasswordSubmit}
        >
          <FieldBlock>
            <Label htmlFor={passwordId}>{t("passwordLabel")}</Label>
            <div className="relative">
              <Input
                id={passwordId}
                ref={passwordRef}
                value={password}
                placeholder={t("passwordPlaceholder")}
                type={reveal ? "text" : "password"}
                autoComplete="current-password"
                autoFocus
                disabled={submitting}
                className="pe-10"
                onKeyDown={trackCapsLock}
                onKeyUp={trackCapsLock}
                onBlur={() => setCapsLock(false)}
                onChange={(event) => setPassword(event.target.value)}
              />
              <RevealToggle
                revealed={reveal}
                disabled={submitting}
                label={t(reveal ? "hidePassword" : "revealPassword")}
                onToggle={() => setReveal((value) => !value)}
              />
            </div>
            {capsLock && (
              <p className="text-xs text-amber-600 dark:text-amber-500" role="status">
                {t("capsLockOn")}
              </p>
            )}
          </FieldBlock>

          {!submitting && visibleError && (
            <ErrorText>
              {visibleError}
              {cooldownStatus.remainingAttempts > 0 && errorCode === "invalid-password" && (
                <span className="mt-1 block font-normal opacity-90">
                  {t("attemptsRemaining", { count: cooldownStatus.remainingAttempts })}
                </span>
              )}
            </ErrorText>
          )}

          {blocked && (
            <Alert
              variant="destructive"
              role="status"
              data-testid="account-lock-screen-cooldown"
              className="border-destructive/30"
            >
              <AlertDescription className="text-destructive">
                {t("cooldown", { seconds: Math.ceil(cooldownStatus.cooldownMsRemaining / 1000) })}
              </AlertDescription>
            </Alert>
          )}

          <Button
            type="submit"
            aria-busy={submitting}
            disabled={submitting || blocked || !account}
            data-testid="account-lock-screen-submit"
          >
            {submitting ? (
              <>
                <Spinner className="size-4" />
                {t("unlocking")}
              </>
            ) : (
              t("unlockAccount")
            )}
          </Button>
        </form>
      ) : (
        <form
          className="flex flex-col gap-4"
          hidden={layoutUnsupported}
          onSubmit={handleRecoverySubmit}
        >
          <p className="text-sm text-muted-foreground">{t("recoveryUnlockDescription")}</p>
          <FieldBlock>
            <Label htmlFor={recoveryKeyId}>{t("recoveryKeyLabel")}</Label>
            <Input
              id={recoveryKeyId}
              ref={passwordRef}
              value={recoveryKey}
              placeholder={t("recoveryKeyPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              className="font-mono"
              onChange={(event) => setRecoveryKey(event.target.value)}
            />
          </FieldBlock>
          <FieldBlock>
            <Label htmlFor={newPasswordId}>{t("newPasswordLabel")}</Label>
            <Input
              id={newPasswordId}
              value={newPassword}
              placeholder={t("newPasswordPlaceholder")}
              type="password"
              autoComplete="new-password"
              disabled={submitting}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <PasswordStrengthMeter password={newPassword} />
          </FieldBlock>
          <FieldBlock>
            <Label htmlFor={confirmPasswordId}>{t("confirmPasswordLabel")}</Label>
            <Input
              id={confirmPasswordId}
              value={confirmPassword}
              placeholder={t("confirmPasswordPlaceholder")}
              type="password"
              autoComplete="new-password"
              disabled={submitting}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </FieldBlock>
          {!submitting && visibleError && <ErrorText>{visibleError}</ErrorText>}
          <Button
            type="submit"
            aria-busy={submitting}
            disabled={submitting || !account}
            data-testid="account-lock-screen-recovery-submit"
          >
            {submitting ? (
              <>
                <Spinner className="size-4" />
                {t("unlocking")}
              </>
            ) : (
              t("recoveryUnlockAction")
            )}
          </Button>
        </form>
      )}

      {submitting && (
        <ol
          data-testid="account-lock-screen-stages"
          aria-live="polite"
          className="flex flex-col gap-1 rounded-md border p-3 text-xs"
        >
          {stages.map((entry, index) => {
            const done = stageIndex > index
            const active = stageIndex === index
            return (
              <li
                key={entry}
                data-stage={entry}
                data-state={done ? "done" : active ? "active" : "pending"}
                className={cn(
                  "flex items-center gap-2",
                  done && "text-muted-foreground",
                  active && "text-foreground",
                  !done && !active && "text-muted-foreground/60"
                )}
              >
                {done ? (
                  <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
                ) : active ? (
                  <Spinner className="size-3.5 shrink-0" />
                ) : (
                  <span
                    aria-hidden="true"
                    className="size-3.5 shrink-0 rounded-full border border-current"
                  />
                )}
                {t(STAGE_LABEL_KEY[entry as keyof typeof STAGE_LABEL_KEY])}
              </li>
            )
          })}
        </ol>
      )}

      {layoutUnsupported && onResetLocalStorage && (
        <Alert
          role="alert"
          data-testid="account-lock-screen-storage-layout"
          className="border-destructive/40"
        >
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle className="text-xs">{t("storageLayoutTitle")}</AlertTitle>
          <AlertDescription className="text-xs">
            <p>{t("storageLayoutBody")}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={resetting}
                aria-busy={resetting}
                data-testid="account-lock-screen-storage-reset"
                onClick={() => {
                  if (!window.confirm(t("storageLayoutResetConfirm"))) return
                  setResetting(true)
                  void onResetLocalStorage().catch(() => setResetting(false))
                }}
              >
                {t(resetting ? "storageLayoutResetting" : "storageLayoutReset")}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {slow && (
        <Alert
          role="status"
          data-testid="account-lock-screen-watchdog"
          data-severity={stuck ? "stuck" : "slow"}
          className="border-amber-500/40 text-amber-700 dark:text-amber-500"
        >
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle className="text-xs">
            {t(stuck ? "stuckTitle" : "slowTitle", { seconds: Math.round(elapsedMs / 1000) })}
          </AlertTitle>
          <AlertDescription className="text-xs text-amber-700/90 dark:text-amber-500/90">
            <p>{t(stuck ? "stuckBody" : "slowBody")}</p>
            {stuck && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button type="button" size="sm" variant="outline" onClick={abandon}>
                  <ArrowLeftIcon data-icon="inline-start" />
                  {t("abandonAttempt")}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={copyDiagnostics}>
                  {copied ? (
                    <CheckIcon data-icon="inline-start" />
                  ) : (
                    <ClipboardIcon data-icon="inline-start" />
                  )}
                  {t(copied ? "diagnosticsCopied" : "copyDiagnostics")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => window.location.reload()}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  {t("reloadWindow")}
                </Button>
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}

      {supportsRecoveryKey && !submitting && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-center"
          data-testid="account-lock-screen-recovery-toggle"
          onClick={() => {
            setMode((current) => (current === "password" ? "recovery" : "password"))
            setErrorCode(null)
            setLocalError(null)
          }}
        >
          {mode === "password" ? (
            <>
              <KeyRoundIcon data-icon="inline-start" />
              {t("useRecoveryKey")}
            </>
          ) : (
            <>
              <ArrowLeftIcon data-icon="inline-start" />
              {t("backToPassword")}
            </>
          )}
        </Button>
      )}
    </section>
  )
}

const EMPTY_THROTTLE: UnlockThrottleStatus = {
  failures: 0,
  remainingAttempts: 5,
  cooldownUntil: 0,
  cooldownMsRemaining: 0,
  blocked: false,
}

/** Recompute the countdown against the ticking clock without re-reading storage. */
function projectCooldown(status: UnlockThrottleStatus, now: number): UnlockThrottleStatus {
  if (status.cooldownUntil <= 0) return status
  const cooldownMsRemaining = Math.max(0, status.cooldownUntil - now)
  return {
    ...status,
    cooldownMsRemaining,
    blocked: cooldownMsRemaining > 0,
  }
}

function RevealToggle({
  revealed,
  disabled,
  label,
  onToggle,
}: {
  revealed: boolean
  disabled: boolean
  label: string
  onToggle: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      aria-pressed={revealed}
      disabled={disabled}
      className="absolute end-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground"
      onClick={onToggle}
    >
      {revealed ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
    </Button>
  )
}

function FieldBlock({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2">{children}</div>
}

function ErrorText({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" className="border-destructive/30">
      <AlertDescription className="text-destructive">{children}</AlertDescription>
    </Alert>
  )
}

export default AccountLockScreen
