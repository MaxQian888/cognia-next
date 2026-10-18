"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { BrandIcon } from "@/components/icons/brand-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Spinner } from "@/components/ui/spinner"
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
import { isTauri } from "@/lib/tauri"
import {
  beginSiwcLogin,
  cancelSiwcLogin,
  deleteSiwcConnection,
  listSiwcConnections,
  listSiwcModels,
  pollSiwcLogin,
  refreshSiwcConnection,
  signOutSiwcConnection,
} from "@/lib/subscription/siwc/transport"
import {
  configureSiwcAppServerConnection,
  configureSiwcChatConnection,
} from "@/lib/subscription/siwc/execution"
import { useAccountStore } from "@/stores/account/account-store"
import type { SiwcConnectionSummary, SiwcModel } from "@/types/subscription/siwc"

/** Separate from legacy subscription rows, active pointers, and backup/sync. */
export function SiwcConnections() {
  const t = useTranslations("siwc")
  const localAccountId = useAccountStore((state) => state.unlockedAccountId)
  const [scopeEpoch, setScopeEpoch] = useState(0)
  useEffect(
    () =>
      useAccountStore.subscribe((state, previous) => {
        // React can batch A → B → A into one render; equality of the final ID is insufficient.
        if (state.unlockedAccountId !== previous.unlockedAccountId)
          setScopeEpoch((value) => value + 1)
      }),
    []
  )
  if (!isTauri()) return <p className="text-xs text-muted-foreground">{t("desktopOnly")}</p>
  if (!localAccountId) return <p className="text-xs text-muted-foreground">{t("locked")}</p>
  // Account-scoped state is destroyed synchronously on lock/switch, before old IPC completes.
  return (
    <SiwcConnectionPanel key={`${localAccountId}:${scopeEpoch}`} localAccountId={localAccountId} />
  )
}

function SiwcConnectionPanel({ localAccountId }: { localAccountId: string }) {
  const t = useTranslations("siwc")
  const [connections, setConnections] = useState<SiwcConnectionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [error, setError] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [retryConnectionId, setRetryConnectionId] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<SiwcConnectionSummary | null>(null)
  const [catalogs, setCatalogs] = useState<Record<string, SiwcModel[]>>({})
  const [models, setModels] = useState<Record<string, string>>({})
  const generation = useRef(0)
  const alive = useRef(false)
  const operation = useRef(false)
  const attempt = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const current = (version: number) =>
    alive.current &&
    generation.current === version &&
    useAccountStore.getState().unlockedAccountId === localAccountId

  useEffect(() => {
    alive.current = true
    const version = generation.current
    void listSiwcConnections()
      .then((rows) => {
        if (current(version)) {
          setConnections(rows)
          setError(false)
        }
      })
      .catch(() => {
        if (current(version)) setError(true)
      })
      .finally(() => {
        if (current(version)) setLoading(false)
      })
    return () => {
      alive.current = false
      // This is an operation counter, not a DOM node ref captured by the effect.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++
      if (timer.current) clearTimeout(timer.current)
      if (attempt.current)
        void cancelSiwcLogin(attempt.current, localAccountId).catch(() => undefined)
      attempt.current = null
    }
    // The enclosing key owns this scope; no account from a later render is captured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localAccountId])

  const beginOperation = () => {
    if (operation.current || useAccountStore.getState().unlockedAccountId !== localAccountId)
      return null
    operation.current = true
    const version = ++generation.current
    setBusy(true)
    setLoading(false)
    setError(false)
    setNotice(null)
    return version
  }
  const finishOperation = (version: number) => {
    if (!current(version)) return
    operation.current = false
    setBusy(false)
  }
  const reload = async (version: number) => {
    const rows = await listSiwcConnections()
    if (current(version)) setConnections(rows)
  }
  const run = async (work: (version: number) => Promise<void>) => {
    const version = beginOperation()
    if (version === null) return
    try {
      await work(version)
    } catch {
      if (current(version)) setError(true)
    } finally {
      finishOperation(version)
    }
  }
  const cancelLogin = () => {
    const version = ++generation.current
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const attemptId = attempt.current
    attempt.current = null
    operation.current = false
    setBusy(false)
    setLoggingIn(false)
    if (attemptId)
      void cancelSiwcLogin(attemptId, localAccountId).catch(() => {
        // Cancellation is generation-fenced natively even if the callback races IPC.
        if (current(version)) setError(true)
      })
  }
  const login = async (connectionId?: string) => {
    const version = beginOperation()
    if (version === null) return
    setLoggingIn(true)
    try {
      const result = await beginSiwcLogin(connectionId)
      if (!current(version)) {
        await cancelSiwcLogin(result.attemptId, localAccountId).catch(() => undefined)
        return
      }
      attempt.current = result.attemptId
      setRetryConnectionId(null)
      const poll = async (): Promise<void> => {
        try {
          const progress = await pollSiwcLogin(result.attemptId)
          if (!current(version)) return
          if (progress.status === "pending") {
            timer.current = setTimeout(() => void poll(), 1000)
            return
          }
          attempt.current = null
          setLoggingIn(false)
          if (progress.status === "complete") {
            await reload(version)
            if (current(version)) setNotice("signedIn")
          } else if (progress.status === "error") {
            setError(true)
            setRetryConnectionId(progress.retryConnectionId ?? null)
          }
          finishOperation(version)
        } catch {
          if (current(version)) {
            setError(true)
            setLoggingIn(false)
            const attemptId = attempt.current
            attempt.current = null
            if (attemptId) void cancelSiwcLogin(attemptId, localAccountId).catch(() => undefined)
            finishOperation(version)
          }
        }
      }
      await poll()
    } catch {
      if (current(version)) {
        setError(true)
        setLoggingIn(false)
        finishOperation(version)
      }
    }
  }

  return (
    <Card aria-label={t("title")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <BrandIcon id="codex" size={20} />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t("isolation")}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || loading} onClick={() => void login()}>
            <span aria-hidden="true">
              <BrandIcon id="openai" size={16} />
            </span>
            {t("add")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || loading}
            onClick={() => void run(reload)}
          >
            {t("reload")}
          </Button>
          {loggingIn && (
            <Button size="sm" variant="outline" onClick={cancelLogin}>
              {t("cancel")}
            </Button>
          )}
        </div>
        {(loading || busy) && (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            {t(loggingIn ? "waiting" : "loading")}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {t("operationFailed")}
          </p>
        )}
        {retryConnectionId && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void login(retryConnectionId)}
          >
            {t("retrySignIn")}
          </Button>
        )}
        {notice && (
          <p role="status" className="text-xs text-muted-foreground">
            {t(notice)}
          </p>
        )}
        {!loading && connections.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        )}
        {connections.map((connection) => {
          const usable = connection.status === "connected" && connection.planPermission
          const catalog = catalogs[connection.id]
          const selectedModel = models[connection.id] ?? ""
          const validModel = catalog?.some((model) => model.slug === selectedModel) ?? false
          return (
            <article
              key={connection.id}
              aria-label={t("registration", { id: connection.id })}
              className="space-y-3 rounded-lg border p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">
                    {connection.label || connection.email || t("unnamed")}
                  </p>
                  {connection.email && (
                    <p className="text-xs text-muted-foreground">{connection.email}</p>
                  )}
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {connection.id}
                  </p>
                </div>
                <Badge variant="secondary">{t(`status.${connection.status}`)}</Badge>
              </div>
              {!connection.planPermission && (
                <p className="text-xs text-muted-foreground">{t("planUnavailable")}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || loading}
                  onClick={() => void login(connection.id)}
                >
                  {t("reauthenticate")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || loading || !usable}
                  onClick={() =>
                    void run(async (version) => {
                      const renewed = await refreshSiwcConnection(connection.id)
                      if (current(version))
                        setConnections((rows) =>
                          rows.map((row) => (row.id === renewed.id ? renewed : row))
                        )
                    })
                  }
                >
                  {t("refresh")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || loading || connection.status === "signed_out"}
                  onClick={() =>
                    void run(async (version) => {
                      const result = await signOutSiwcConnection(connection.id)
                      if (!current(version)) return
                      setConnections((rows) =>
                        rows.map((row) =>
                          row.id === connection.id
                            ? { ...row, status: "signed_out", planPermission: false }
                            : row
                        )
                      )
                      setCatalogs((value) => {
                        const next = { ...value }
                        delete next[connection.id]
                        return next
                      })
                      setNotice(
                        result.revocation === "confirmed" ? "signedOut" : "revocationUnconfirmed"
                      )
                    })
                  }
                >
                  {t("signOut")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || loading || connection.status !== "signed_out"}
                  onClick={() => setRemoveTarget(connection)}
                >
                  {t("remove")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || loading || !usable}
                  onClick={() =>
                    void run(async (version) => {
                      const fetched = await listSiwcModels(connection.id)
                      if (current(version)) {
                        setCatalogs((value) => ({
                          ...value,
                          [connection.id]: fetched.filter((model) => model.visibility === "list"),
                        }))
                        setModels((value) => ({ ...value, [connection.id]: "" }))
                      }
                    })
                  }
                >
                  {t("models")}
                </Button>
              </div>
              {connection.status !== "signed_out" && (
                <p className="text-xs text-muted-foreground">{t("removeAfterSignOut")}</p>
              )}
              {catalog && usable && (
                <div className="space-y-2">
                  <Label htmlFor={`siwc-model-${connection.id}`}>{t("model")}</Label>
                  <NativeSelect
                    id={`siwc-model-${connection.id}`}
                    value={selectedModel}
                    disabled={busy}
                    onChange={(event) =>
                      setModels((value) => ({ ...value, [connection.id]: event.target.value }))
                    }
                  >
                    <NativeSelectOption value="">{t("chooseModel")}</NativeSelectOption>
                    {catalog.map((model) => (
                      <NativeSelectOption key={model.slug} value={model.slug}>
                        {model.displayName || model.slug}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  {catalog.length === 0 && (
                    <p className="text-xs text-muted-foreground">{t("noModels")}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={busy || !validModel}
                      onClick={() =>
                        void run(async (version) => {
                          await configureSiwcChatConnection(connection, selectedModel)
                          if (current(version)) setNotice("chatConfigured")
                        })
                      }
                    >
                      {t("enableChat")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !validModel}
                      onClick={() =>
                        void run(async (version) => {
                          await configureSiwcAppServerConnection(connection, selectedModel)
                          if (current(version)) setNotice("agentConfigured")
                        })
                      }
                    >
                      {t("enableAgent")}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("selectionHelp")}</p>
                </div>
              )}
            </article>
          )
        })}
      </CardContent>
      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("removeDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                const target = removeTarget
                if (!target) return
                void run(async (version) => {
                  await deleteSiwcConnection(target.id)
                  if (current(version)) {
                    setConnections((rows) => rows.filter((row) => row.id !== target.id))
                    setRemoveTarget(null)
                  }
                })
              }}
            >
              {t("removeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
