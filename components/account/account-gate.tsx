"use client"

import type { FormEvent, ReactNode } from "react"
import { useId, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CopyIcon, DownloadIcon, LockKeyholeIcon, UserRoundPlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PageLoading } from "@/components/ui/loading-states"
import { isCapacitor } from "@/lib/tauri"
import { getPetWindowRole, isSecondaryOverlayRole } from "@/lib/pet/window-role"
import { downloadFile } from "@/lib/files/download"
import { PASSWORD_MIN_LENGTH } from "@/lib/accounts/password-policy"
import { selectActiveAccount, useAccountStore } from "@/stores/account/account-store"
import { useAutoLock } from "@/hooks/account/use-auto-lock"
import { useCopy } from "@/hooks/ui/use-copy"
import { PasswordStrengthMeter } from "./password-strength-meter"

export interface AccountGateProps {
  children: ReactNode
}

export function AccountGate({ children }: AccountGateProps) {
  const t = useTranslations("account.gate")
  const accounts = useAccountStore((state) => state.accounts)
  const loaded = useAccountStore((state) => state.loaded)
  const loading = useAccountStore((state) => state.loading)
  const locked = useAccountStore((state) => state.locked)
  const storeError = useAccountStore((state) => state.error)
  const pendingRecoveryKey = useAccountStore((state) => state.pendingRecoveryKey)
  const createAccount = useAccountStore((state) => state.createAccount)
  const unlockAccount = useAccountStore((state) => state.unlockAccount)
  const acknowledgeRecoveryKey = useAccountStore((state) => state.acknowledgeRecoveryKey)
  const activeAccount = useAccountStore(selectActiveAccount)

  const displayNameId = useId()
  const passwordId = useId()
  const [displayName, setDisplayName] = useState("")
  const [password, setPassword] = useState("")
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [recoverySaved, setRecoverySaved] = useState(false)
  const { copied, isCopying, copy } = useCopy({ scope: "account recovery key" })

  const targetAccount = useMemo(
    () => activeAccount ?? accounts[0] ?? null,
    [accounts, activeAccount]
  )
  const visibleError = actionError ?? storeError

  // Idle auto-lock (Settings → Account → Security). Inert until the user sets a
  // non-zero timeout; lives here because the gate wraps the whole desktop app.
  useAutoLock()

  if (!loaded || loading) {
    // The boot screen's `accounts` step names this wait; the heading stays the
    // shared "Preparing your workspace" so the hand-over to the next owner
    // (recovery / onboarding gates, then the shell) reads as one screen.
    return <PageLoading variant="workspace" milestone="accounts" allowReload />
  }

  // Native mobile retains the established runtime chooser / pairing gate.
  // Ordinary browsers use the same local account gate as desktop, backed by
  // the Web Crypto PBKDF2 verifier instead of a Tauri command.
  if (isCapacitor()) {
    return <>{children}</>
  }

  if (pendingRecoveryKey) {
    const recoverySavedId = `${passwordId}-recovery-saved`
    return (
      <GateShell>
        <section
          aria-label={t("recoveryForm")}
          data-testid="account-vault-recovery"
          className="flex w-full max-w-lg flex-col gap-4"
        >
          <div>
            <h1 className="text-lg font-semibold">{t("recoveryTitle")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("recoveryDescription")}</p>
          </div>
          <code className="select-all break-all rounded-md border bg-muted p-4 font-mono text-sm">
            {pendingRecoveryKey}
          </code>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              disabled={submitting || isCopying}
              onClick={() => void copy(pendingRecoveryKey)}
            >
              {copied ? (
                <CheckIcon data-icon="inline-start" />
              ) : (
                <CopyIcon data-icon="inline-start" />
              )}
              <span aria-live="polite">{t(copied ? "recoveryCopied" : "recoveryCopy")}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => downloadRecoveryKey(pendingRecoveryKey)}
            >
              <DownloadIcon data-icon="inline-start" />
              {t("recoveryDownload")}
            </Button>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id={recoverySavedId}
              checked={recoverySaved}
              disabled={submitting}
              onCheckedChange={(checked) => setRecoverySaved(checked === true)}
            />
            <Label htmlFor={recoverySavedId}>{t("recoverySaved")}</Label>
          </div>
          <Button
            type="button"
            data-testid="account-vault-recovery-continue"
            disabled={submitting || !recoverySaved}
            onClick={() => acknowledgeRecoveryKey()}
          >
            {t("recoveryContinue")}
          </Button>
        </section>
      </GateShell>
    )
  }

  // The desktop-pet overlay / popup windows load this same root layout but are
  // presentation-only companions (they read pet state from Dexie and award no
  // XP). Gating them behind the account lock is both wrong — an opaque
  // lock/create form fills what must be a transparent paint-through window —
  // and pointless. Pass through so the sprite always paints. Placed after the
  // `loaded` gate for the same server/first-client hydration agreement as the
  // `isTauri()` passthrough above (role reads Tauri internals post-hydration).
  const petRole = getPetWindowRole()
  if (isSecondaryOverlayRole(petRole)) {
    return <>{children}</>
  }

  if (accounts.length === 0) {
    const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (password.length < PASSWORD_MIN_LENGTH) {
        setActionError(t("passwordTooShort", { min: PASSWORD_MIN_LENGTH }))
        return
      }
      setSubmitting(true)
      setActionError(null)
      try {
        await createAccount({
          displayName,
          password,
        })
        setPassword("")
      } catch (error) {
        setActionError(toErrorMessage(error, t("operationFailed")))
      } finally {
        setSubmitting(false)
      }
    }

    return (
      <GateShell>
        <form
          aria-label={t("firstRunForm")}
          className="flex w-full max-w-sm flex-col gap-4"
          onSubmit={(event) => void handleCreate(event)}
        >
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <UserRoundPlusIcon className="size-5" aria-hidden="true" />
            </div>
            <h1 className="text-lg font-semibold">{t("firstRunTitle")}</h1>
          </div>
          <FieldBlock>
            <Label htmlFor={displayNameId}>{t("displayNameLabel")}</Label>
            <Input
              id={displayNameId}
              value={displayName}
              placeholder={t("displayNamePlaceholder")}
              autoComplete="name"
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </FieldBlock>
          <FieldBlock>
            <Label htmlFor={passwordId}>{t("passwordLabel")}</Label>
            <Input
              id={passwordId}
              value={password}
              placeholder={t("passwordPlaceholder")}
              type="password"
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
            />
            <PasswordStrengthMeter password={password} />
          </FieldBlock>
          {visibleError && <ErrorText>{visibleError}</ErrorText>}
          <Button type="submit" disabled={submitting}>
            {t("createAccount")}
          </Button>
        </form>
      </GateShell>
    )
  }

  if (locked || !targetAccount) {
    const handleUnlock = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!targetAccount) return
      setSubmitting(true)
      setActionError(null)
      try {
        await unlockAccount(targetAccount.id, password)
        setPassword("")
      } catch (error) {
        setActionError(toErrorMessage(error, t("operationFailed")))
      } finally {
        setSubmitting(false)
      }
    }

    return (
      <GateShell>
        <form
          aria-label={t("unlockForm")}
          className="flex w-full max-w-sm flex-col gap-4"
          onSubmit={(event) => void handleUnlock(event)}
        >
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <LockKeyholeIcon className="size-5" aria-hidden="true" />
            </div>
            <h1 className="text-lg font-semibold">
              {t("unlockTitle", { name: targetAccount?.displayName ?? t("unknownAccount") })}
            </h1>
          </div>
          <FieldBlock>
            <Label htmlFor={passwordId}>{t("passwordLabel")}</Label>
            <Input
              id={passwordId}
              value={password}
              placeholder={t("passwordPlaceholder")}
              type="password"
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </FieldBlock>
          {visibleError && <ErrorText>{visibleError}</ErrorText>}
          <Button type="submit" disabled={submitting || !targetAccount}>
            {t("unlockAccount")}
          </Button>
        </form>
      </GateShell>
    )
  }

  return <>{children}</>
}

function GateShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      {children}
    </main>
  )
}

function FieldBlock({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2">{children}</div>
}

function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive"
    >
      {children}
    </p>
  )
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return fallback
}

function downloadRecoveryKey(recoveryKey: string): void {
  downloadFile("cognia-recovery-key.txt", `${recoveryKey}\n`, "text/plain;charset=utf-8")
}

export default AccountGate
