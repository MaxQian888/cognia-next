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
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { isDeviceManagedAccount } from "@/lib/accounts/desktop-local-account"
import type { AutoUnlockFailure, UnlockAccountOptions } from "@/stores/account/account-store"
import { cn } from "@/lib/utils"
import { useCopy } from "@/hooks/ui/use-copy"
import { usePlatform } from "@/hooks/use-platform"
import { isMobile } from "@/lib/capacitor/_shared"
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

const AUTO_UNLOCK_FAILURE_KEY: Record<AutoUnlockFailure["reason"], string> = {
  "secret-store-unavailable": "autoUnlockFailedStore",
  "secret-missing": "autoUnlockFailedMissing",
  "secret-rejected": "autoUnlockFailedRejected",
  "unlock-failed": "autoUnlockFailedOther",
}

const ERROR_KEY: Record<AccountUnlockErrorCode, string> = {
  "invalid-password": "errorInvalidPassword",
  "password-required": "errorPasswordRequired",
  "invalid-recovery-key": "errorInvalidRecoveryKey",
  "vault-not-provisioned": "errorVaultNotProvisioned",
  "vault-incompatible": "errorVaultIncompatible",
  "storage-layout-unsupported": "errorStorageLayoutUnsupported",
  throttled: "errorThrottled",
  "secret-store-unavailable": "errorSecretStoreUnavailable",
  unknown: "errorUnknown",
}

export interface AccountLockScreenProps {
  accounts: LocalAccountRecord[]
  activeAccountId: string | null
  onUnlock: (
    localAccountId: string,
    password: string,
    options?: UnlockAccountOptions
  ) => Promise<void>
  /**
   * True where a profile can keep its password in the native secret store and
   * open without a prompt (the desktop shell). Shows the "unlock automatically
   * on this device" choice under the password.
   */
  supportsRememberOnDevice?: boolean
  /** Why boot could not open a remembered profile by itself, if it tried. */
  autoUnlockFailure?: AutoUnlockFailure | null
  /**
   * Redeem a Browser Vault recovery key and set a new password. Absent on the
   * desktop host, which mints no recovery key — see `supportsRecoveryKey`.
   */
  onRecoveryUnlock: (
    localAccountId: string,
    recoveryKey: string,
    newPassword: string
  ) => Promise<void>
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
    localAccountId: string,
    method: QuickUnlockMethod,
    canonicalSecret: string,
    signal?: AbortSignal
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
  supportsRememberOnDevice = false,
  autoUnlockFailure = null,
  onQuickUnlock,
  appearance,
  activeWallpaperId = null,
  slowAfterMs = DEFAULT_SLOW_AFTER_MS,
  onResetLocalStorage,
  stuckAfterMs = DEFAULT_STUCK_AFTER_MS,
}: AccountLockScreenProps) {
  const t = useTranslations("account.gate")
  const tQuick = useTranslations("account.quickUnlock")
  const mobile = isMobile()
  const passwordId = useId()
  const recoveryKeyId = useId()
  const newPasswordId = useId()
  const confirmPasswordId = useId()
  const accountPickerId = useId()
  const rememberId = useId()
  const passwordRef = useRef<HTMLInputElement>(null)

  const [selectedId, setSelectedId] = useState<string | null>(
    () => activeAccountId ?? accounts[0]?.id ?? null
  )
  // Quick unlock is the DEFAULT surface where one is enrolled and usable, and
  // the password is one click away from it. Landing on the password field when
  // the user set up a PIN would make the PIN pointless.
  const quickEnrollments = (
    accounts.find((candidate) => candidate.id === selectedId)?.quickUnlock ?? []
  ).filter(
    (entry) =>
      onQuickUnlock !== undefined &&
      (entry.method === "biometric" ? mobile : entry.method !== "passkey" || !mobile)
  )
  const lockAppearance: LockScreenSettings = { ...DEFAULT_LOCK_SCREEN, ...(appearance ?? {}) }
  const [mode, setMode] = useState<Mode>(() =>
    quickEnrollments.some(isEnrollmentUsable) ? "quick" : "password"
  )
  const [autoPromptBiometric, setAutoPromptBiometric] = useState(true)
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
  const localAccountId = account?.id ?? null
  const displayName = account?.displayName ?? t("unknownAccount")
  // The device-managed workspace has no password anyone typed: the secret
  // store opens it, so the form asks for nothing and just opens it.
  const deviceManaged = isDeviceManagedAccount(account)
  const offerRemember = supportsRememberOnDevice && !deviceManaged && account !== null
  const [rememberOnDevice, setRememberOnDevice] = useState(() => account?.rememberOnDevice === true)

  const [throttle, setThrottle] = useState<UnlockThrottleStatus>(() =>
    localAccountId ? readUnlockThrottle(localAccountId) : EMPTY_THROTTLE
  )

  // Reset on account change, during render rather than in an effect: an effect
  // would paint one frame of the previous account's cooldown and error before
  // correcting itself. React's own "adjust state when a prop changes" pattern.
  const [throttleAccountId, setThrottleAccountId] = useState(localAccountId)
  if (localAccountId !== throttleAccountId) {
    setThrottleAccountId(localAccountId)
    setThrottle(localAccountId ? readUnlockThrottle(localAccountId) : EMPTY_THROTTLE)
    setErrorCode(null)
    setLocalError(null)
    setRememberOnDevice(account?.rememberOnDevice === true)
    setMode(quickEnrollments.some(isEnrollmentUsable) ? "quick" : "password")
    setAutoPromptBiometric(true)
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
    () => (localAccountId ? projectCooldown(throttle, now) : EMPTY_THROTTLE),
    [localAccountId, throttle, now]
  )

  const stages = useMemo(() => unlockStagesFor(supportsRecoveryKey), [supportsRecoveryKey])
  // Which store holds the credential, named for the shell it runs in: the
  // Browser Vault on the web, the OS keychain on the desktop, the platform's
  // secure storage in the mobile app (which has no desktop keychain at all).
  const platform = usePlatform()
  const runtimeBadgeKey = supportsRecoveryKey
    ? "runtimeBadgeBrowser"
    : platform === "mobile"
      ? "runtimeBadgeMobile"
      : "runtimeBadgeDesktop"
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
    if (!localAccountId || submitting || blocked) return
    // Read the field the user actually sees. An Android IME can commit text
    // without a React change event, so state alone lost what was typed (the
    // "first attempt says Enter your password" report) until the next keystroke.
    const submittedPassword = readField(event.currentTarget, "password", password)
    setPassword(submittedPassword)
    // Only a CHANGED choice is sent. Re-sending an unchanged "on" would
    // rewrite the stored secret on every unlock, and after a boot that could
    // not read the store it would fail an unlock the password alone passes.
    const rememberChanged =
      offerRemember && rememberOnDevice !== (account?.rememberOnDevice === true)
    void run(
      () =>
        rememberChanged
          ? onUnlock(localAccountId, submittedPassword, { rememberOnDevice })
          : onUnlock(localAccountId, submittedPassword),
      localAccountId
    )
  }

  const handleRecoverySubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!localAccountId || submitting) return
    const form = event.currentTarget
    const submittedKey = readField(form, "recoveryKey", recoveryKey)
    const submittedNew = readField(form, "newPassword", newPassword)
    const submittedConfirm = readField(form, "confirmPassword", confirmPassword)
    setRecoveryKey(submittedKey)
    setNewPassword(submittedNew)
    setConfirmPassword(submittedConfirm)
    if (submittedNew.length < PASSWORD_MIN_LENGTH) {
      setLocalError(t("passwordTooShort", { min: PASSWORD_MIN_LENGTH }))
      return
    }
    if (submittedNew !== submittedConfirm) {
      setLocalError(t("passwordMismatch"))
      return
    }
    void run(() => onRecoveryUnlock(localAccountId, submittedKey, submittedNew), localAccountId)
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
      className="flex w-full max-w-sm flex-col gap-6"
    >
      <LockScreenBackdrop settings={lockAppearance} activeWallpaperId={activeWallpaperId} />

      <header className="flex flex-col items-center gap-4 text-center">
        {lockAppearance.showAvatar && (
          <div className="relative">
            <AvatarBadge
              subject={{ name: displayName, avatarImageUrl: account?.avatarDataUrl }}
              size={80}
              className="shadow-(--elevation-2) ring-4 ring-background"
              textClassName="text-3xl font-semibold"
            />
            <Surface
              aria-hidden="true"
              className="absolute -right-1 -bottom-1 flex size-7 items-center justify-center rounded-full border"
            >
              <LockKeyholeIcon className="size-3.5 text-muted-foreground" />
            </Surface>
          </div>
        )}
        <div className="flex w-full min-w-0 flex-col items-center gap-1">
          <p className="text-sm text-muted-foreground">{t("welcomeBack")}</p>
          {/* The visible heading is the name alone, at a size that reads as the
              point of the screen; the full "Unlock <name>" sentence stays the
              accessible name. Long names wrap (two lines, then ellipsis) and
              keep the whole name in the tooltip instead of being cut off. */}
          <h1
            className="line-clamp-2 w-full text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]"
            title={displayName}
            data-testid="account-lock-screen-name"
          >
            <span className="sr-only">{t("unlockTitle", { name: displayName })}</span>
            <span aria-hidden="true">{displayName}</span>
          </h1>
        </div>
        <p className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
          <ShieldCheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{t(runtimeBadgeKey)}</span>
        </p>
      </header>

      {accounts.length > 1 && (
        <FieldBlock>
          <Label htmlFor={accountPickerId}>{t("switchAccountLabel")}</Label>
          <NativeSelect
            id={accountPickerId}
            value={localAccountId ?? ""}
            disabled={submitting}
            className="h-11 rounded-xl"
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

      {autoUnlockFailure && autoUnlockFailure.accountId === localAccountId && !submitting && (
        <Alert role="status" data-testid="account-lock-screen-auto-unlock-failure">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>{t("autoUnlockFailedTitle")}</AlertTitle>
          <AlertDescription>
            {t(AUTO_UNLOCK_FAILURE_KEY[autoUnlockFailure.reason])}
            {autoUnlockFailure.message && (
              <span className="mt-1 block font-mono text-[11px] break-all opacity-80">
                {autoUnlockFailure.message}
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {mode === "quick" && onQuickUnlock && localAccountId ? (
        <QuickUnlockPanel
          localAccountId={localAccountId}
          enrollments={
            accounts.find((candidate) => candidate.id === localAccountId)?.quickUnlock ?? []
          }
          disabled={submitting}
          autoPromptBiometric={autoPromptBiometric}
          onQuickUnlock={(method, canonicalSecret, signal) =>
            signal
              ? onQuickUnlock(localAccountId, method, canonicalSecret, signal)
              : onQuickUnlock(localAccountId, method, canonicalSecret)
          }
          onUsePassword={() => {
            setAutoPromptBiometric(false)
            setMode("password")
          }}
        />
      ) : mode === "password" ? (
        <form
          className="flex flex-col gap-4"
          hidden={layoutUnsupported}
          onSubmit={handlePasswordSubmit}
        >
          <FieldBlock hidden={deviceManaged}>
            {/* The placeholder already says "Password"; a visible label above
                it only repeated the word. Kept for assistive tech. */}
            <Label htmlFor={passwordId} className="sr-only">
              {t("passwordLabel")}
            </Label>
            <div className="relative">
              <Input
                id={passwordId}
                ref={passwordRef}
                name="password"
                value={password}
                placeholder={t("passwordPlaceholder")}
                type={reveal ? "text" : "password"}
                autoComplete="current-password"
                autoFocus
                disabled={submitting}
                className={cn(LARGE_FIELD_CLASS, "pe-12")}
                onKeyDown={trackCapsLock}
                onKeyUp={trackCapsLock}
                onBlur={() => setCapsLock(false)}
                onInput={(event) => setPassword(event.currentTarget.value)}
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

          {deviceManaged && (
            <p className="text-sm text-muted-foreground" data-testid="account-lock-screen-device">
              {t("deviceWorkspaceHint")}
            </p>
          )}

          {offerRemember && (
            <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-muted/30 px-3.5 py-3">
              <Checkbox
                id={rememberId}
                checked={rememberOnDevice}
                disabled={submitting}
                className="mt-0.5"
                data-testid="account-lock-screen-remember"
                onCheckedChange={(checked) => setRememberOnDevice(checked === true)}
              />
              <div className="grid min-w-0 gap-1">
                <Label htmlFor={rememberId} className="leading-snug">
                  {t("rememberOnDeviceLabel")}
                </Label>
                <p className="text-xs leading-snug text-muted-foreground">
                  {t("rememberOnDeviceHelp")}
                </p>
              </div>
            </div>
          )}

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
            className={LARGE_BUTTON_CLASS}
            data-testid="account-lock-screen-submit"
          >
            {submitting ? (
              <>
                <Spinner className="size-4" />
                {t("unlocking")}
              </>
            ) : (
              t(deviceManaged ? "openLocalWorkspace" : "unlockAccount")
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
              name="recoveryKey"
              value={recoveryKey}
              placeholder={t("recoveryKeyPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              className={cn(LARGE_FIELD_CLASS, "font-mono")}
              onInput={(event) => setRecoveryKey(event.currentTarget.value)}
              onChange={(event) => setRecoveryKey(event.target.value)}
            />
          </FieldBlock>
          <FieldBlock>
            <Label htmlFor={newPasswordId}>{t("newPasswordLabel")}</Label>
            <Input
              id={newPasswordId}
              name="newPassword"
              value={newPassword}
              placeholder={t("newPasswordPlaceholder")}
              type="password"
              autoComplete="new-password"
              disabled={submitting}
              className={LARGE_FIELD_CLASS}
              onInput={(event) => setNewPassword(event.currentTarget.value)}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <PasswordStrengthMeter password={newPassword} />
          </FieldBlock>
          <FieldBlock>
            <Label htmlFor={confirmPasswordId}>{t("confirmPasswordLabel")}</Label>
            <Input
              id={confirmPasswordId}
              name="confirmPassword"
              value={confirmPassword}
              placeholder={t("confirmPasswordPlaceholder")}
              type="password"
              autoComplete="new-password"
              disabled={submitting}
              className={LARGE_FIELD_CLASS}
              onInput={(event) => setConfirmPassword(event.currentTarget.value)}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </FieldBlock>
          {!submitting && visibleError && <ErrorText>{visibleError}</ErrorText>}
          <Button
            type="submit"
            aria-busy={submitting}
            disabled={submitting || !account}
            className={LARGE_BUTTON_CLASS}
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
          className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/20 p-3.5 text-xs"
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

      {mode === "password" && !submitting && quickEnrollments.length > 0 && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setAutoPromptBiometric(false)
            setMode("quick")
          }}
          data-testid="account-lock-screen-use-quick"
        >
          {tQuick("panelLabel")}
        </Button>
      )}

      {supportsRecoveryKey && !submitting && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-center text-muted-foreground"
          data-testid="account-lock-screen-recovery-toggle"
          onClick={() => {
            setAutoPromptBiometric(false)
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

/**
 * Touch-sized controls: 48px tall, 16px text on phones. Below 16px iOS zooms
 * the page into a focused field, and a 36px target is easy to miss with a
 * thumb. From `md` up the type steps back down to the app's control size.
 */
const LARGE_FIELD_CLASS = "h-12 rounded-xl px-4 text-base md:text-sm"
const LARGE_BUTTON_CLASS = "h-12 w-full rounded-xl text-base font-medium md:text-sm"

/** The value the form control shows, falling back to state outside a real form. */
function readField(form: HTMLFormElement, name: string, fallback: string): string {
  const value = new FormData(form).get(name)
  return typeof value === "string" ? value : fallback
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
      className="absolute end-1.5 top-1/2 size-9 -translate-y-1/2 rounded-lg text-muted-foreground"
      onClick={onToggle}
    >
      {revealed ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
    </Button>
  )
}

function FieldBlock({ children, hidden }: { children: ReactNode; hidden?: boolean }) {
  return (
    <div className="flex flex-col gap-2" hidden={hidden}>
      {children}
    </div>
  )
}

function ErrorText({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" className="border-destructive/30">
      <AlertDescription className="text-destructive">{children}</AlertDescription>
    </Alert>
  )
}

export default AccountLockScreen
