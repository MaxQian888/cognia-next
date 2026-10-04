"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { isTauri } from "@/lib/tauri"
import {
  forgetSshHostKey,
  listSshHostKeys,
  type TrustedSshHostKey,
} from "@/lib/terminal/ssh-host-key"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"

type KeyListState =
  { kind: "loading" } | { kind: "error" } | { kind: "ready"; keys: TrustedSshHostKey[] }

function hostAddress(key: TrustedSshHostKey): string {
  return `${key.host.includes(":") ? `[${key.host}]` : key.host}:${key.port}`
}

/** Trust is owned by this desktop, independently of the selected Cognia host. */
export function SshTrustedHostKeys({ profiles }: { profiles: readonly SshHostProfile[] }) {
  const t = useTranslations("settings.terminal.ssh.trustedKeys")
  const desktop = isTauri()
  const [state, setState] = useState<KeyListState>({ kind: "loading" })
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState<TrustedSshHostKey | null>(null)
  const [forgetting, setForgetting] = useState(false)
  const [forgetFailed, setForgetFailed] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    void listSshHostKeys().then(
      (keys) => {
        if (!cancelled) setState({ kind: "ready", keys })
      },
      () => {
        if (!cancelled) setState({ kind: "error" })
      }
    )
    return () => {
      cancelled = true
    }
  }, [desktop, revision])

  function reload(): void {
    setState({ kind: "loading" })
    setRevision((value) => value + 1)
  }

  async function forget(): Promise<void> {
    if (!desktop || !pending || forgetting) return
    setForgetting(true)
    setForgetFailed(false)
    try {
      // Bind confirmation to the key shown, so a changed entry is not erased.
      await forgetSshHostKey(pending.host, pending.port, pending.fingerprint)
      setPending(null)
      reload()
    } catch {
      setForgetFailed(true)
    } finally {
      setForgetting(false)
    }
  }

  return (
    <section aria-label={t("title")} className="space-y-3 rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{t("title")}</h3>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        {desktop ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={reload}
            disabled={state.kind === "loading" || forgetting}
          >
            {t("refresh")}
          </Button>
        ) : null}
      </div>
      {!desktop ? (
        <p className="text-xs text-muted-foreground">{t("desktopOnly")}</p>
      ) : state.kind === "loading" ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("loading")}
        </p>
      ) : state.kind === "error" ? (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-destructive">
            {t("loadFailed")}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            {t("retry")}
          </Button>
        </div>
      ) : state.keys.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y">
          {state.keys.map((key) => {
            const address = hostAddress(key)
            const names = profiles
              .filter(
                (profile) =>
                  profile.host.trim().toLowerCase() === key.host.toLowerCase() &&
                  profile.port === key.port
              )
              .map((profile) => profile.name.trim() || profile.id)
            return (
              <li key={`${address}:${key.keyType}:${key.fingerprint}`} className="space-y-1.5 py-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="break-all font-mono text-xs">{address}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 text-xs"
                    aria-label={t("forgetEntry", { address, fingerprint: key.fingerprint })}
                    onClick={() => {
                      setForgetFailed(false)
                      setPending(key)
                    }}
                    disabled={forgetting}
                  >
                    {t("forget")}
                  </Button>
                </div>
                <dl className="space-y-1 text-xs">
                  <div className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">{t("keyType")}</dt>
                    <dd className="font-mono">{key.keyType}</dd>
                  </div>
                  <div className="space-y-0.5">
                    <dt className="text-muted-foreground">{t("fingerprint")}</dt>
                    <dd className="break-all font-mono">{key.fingerprint}</dd>
                  </div>
                </dl>
                <p className="break-words text-xs text-muted-foreground">
                  {names.length ? t("profiles", { names: names.join(", ") }) : t("noProfiles")}
                </p>
              </li>
            )
          })}
        </ul>
      )}
      <AlertDialog
        open={desktop && pending !== null}
        onOpenChange={(open) => {
          if (!open && !forgetting) setPending(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("confirm.title", { address: pending ? hostAddress(pending) : "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("confirm.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <p className="break-all font-mono text-xs">{pending?.fingerprint}</p>
          {forgetFailed ? (
            <p role="alert" className="text-xs text-destructive">
              {t("forgetFailed")}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forgetting}>{t("confirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={forgetting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault()
                void forget()
              }}
            >
              {forgetting ? t("forgetting") : t("confirm.action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
