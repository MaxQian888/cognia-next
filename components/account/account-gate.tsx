"use client"

import type { FormEvent, ReactNode } from "react"
import { useId, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { LockKeyholeIcon, UserRoundPlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { selectActiveAccount, useAccountStore } from "@/stores/account/account-store"

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
  const createAccount = useAccountStore((state) => state.createAccount)
  const unlockAccount = useAccountStore((state) => state.unlockAccount)
  const activeAccount = useAccountStore(selectActiveAccount)

  const displayNameId = useId()
  const passwordId = useId()
  const [displayName, setDisplayName] = useState("")
  const [password, setPassword] = useState("")
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const targetAccount = useMemo(
    () => activeAccount ?? accounts[0] ?? null,
    [accounts, activeAccount]
  )
  const visibleError = actionError ?? storeError

  if (!loaded || loading) {
    return <GateShell>{t("loading")}</GateShell>
  }

  if (accounts.length === 0) {
    const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
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

export default AccountGate
