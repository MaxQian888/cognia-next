"use client"

import {
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  copyCredential,
  deleteCredential,
  exportCredentials,
  listCredentials,
  revealCredential,
  type CredentialMeta,
} from "@/lib/browser/passwords"

import { BrowserCredentialFormDialog } from "./browser-credential-form-dialog"
import { BrowserPasswordImportDialog } from "./browser-password-import-dialog"
import { presenceFailure } from "./vault-errors"

type VaultCredential = CredentialMeta

/** How long a revealed password stays on screen before it is hidden again. */
const REVEAL_TIMEOUT_MS = 30_000

type LoadState = { kind: "loading" } | { kind: "ready" } | { kind: "failed" }

function matchesQuery(credential: VaultCredential, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  return (
    credential.origin.toLowerCase().includes(needle) ||
    credential.username.toLowerCase().includes(needle) ||
    (credential.note ?? "").toLowerCase().includes(needle)
  )
}

/**
 * The browser password vault (ADR-0201): list, search, add, edit, delete,
 * reveal, copy, export and import saved credentials.
 *
 * Only credential metadata lives in this component. A password reaches the
 * renderer in exactly two cases, both user-initiated: the user typing one into
 * the add/edit form, and an explicit reveal, which Rust gates behind OS user
 * presence and which this component hides again after 30 seconds. Copy and
 * export never return the value — Rust writes the clipboard / file itself.
 */
export function BrowserPasswordManager() {
  const t = useTranslations("browserVault")
  const format = useFormatter()
  const [credentials, setCredentials] = useState<VaultCredential[]>([])
  const [load, setLoad] = useState<LoadState>({ kind: "loading" })
  const [query, setQuery] = useState("")
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<VaultCredential | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<VaultCredential | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportConfirm, setExportConfirm] = useState(false)
  const hideTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const refresh = useCallback(() => {
    let current = true
    listCredentials()
      .then((next) => {
        if (!current) return
        setCredentials(next)
        setLoad({ kind: "ready" })
      })
      .catch(() => {
        if (current) setLoad({ kind: "failed" })
      })
    return () => {
      current = false
    }
  }, [])

  useEffect(() => refresh(), [refresh])

  useEffect(() => {
    const timers = hideTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const visible = useMemo(
    () =>
      credentials
        .filter((credential) => matchesQuery(credential, query.trim()))
        .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username)),
    [credentials, query]
  )

  const reportPresence = (error: unknown, fallback: string) => {
    const failure = presenceFailure(error)
    toast.error(failure ? t(`presence.${failure}`) : fallback)
  }

  const hide = (id: string) => {
    const timer = hideTimers.current.get(id)
    if (timer) clearTimeout(timer)
    hideTimers.current.delete(id)
    setRevealed((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  const reveal = async (credential: VaultCredential) => {
    setBusyId(credential.id)
    try {
      const { password } = await revealCredential(credential.id)
      setRevealed((current) => ({ ...current, [credential.id]: password }))
      const existing = hideTimers.current.get(credential.id)
      if (existing) clearTimeout(existing)
      hideTimers.current.set(
        credential.id,
        setTimeout(() => hide(credential.id), REVEAL_TIMEOUT_MS)
      )
    } catch (error) {
      reportPresence(error, t("common.failed"))
    } finally {
      setBusyId(null)
    }
  }

  const copy = async (credential: VaultCredential) => {
    setBusyId(credential.id)
    try {
      await copyCredential(credential.id)
      toast.success(t("passwords.copied"))
    } catch (error) {
      reportPresence(error, t("common.failed"))
    } finally {
      setBusyId(null)
    }
  }

  const confirmDelete = async () => {
    const target = pendingDelete
    if (!target) return
    setPendingDelete(null)
    try {
      await deleteCredential(target.id)
      hide(target.id)
      setCredentials((current) => current.filter((item) => item.id !== target.id))
      toast.success(t("passwords.deleted"))
    } catch {
      toast.error(t("common.failed"))
    }
  }

  const runExport = async () => {
    if (exporting) return
    setExporting(true)
    try {
      // Rust asks for OS user presence, then shows the save dialog itself;
      // `null` means the user cancelled the dialog.
      const result = await exportCredentials()
      if (!result) return
      toast.success(t("passwords.export.done"))
    } catch (error) {
      reportPresence(error, t("passwords.export.failed"))
    } finally {
      setExporting(false)
    }
  }

  const openAdd = () => {
    setEditing(null)
    setFormOpen(true)
  }

  const openEdit = (credential: VaultCredential) => {
    setEditing(credential)
    setFormOpen(true)
  }

  const onSaved = (saved: VaultCredential) => {
    hide(saved.id)
    setCredentials((current) => [...current.filter((item) => item.id !== saved.id), saved])
  }

  return (
    <section aria-labelledby="browser-password-manager-title" className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id="browser-password-manager-title" className="text-base font-semibold">
            {t("passwords.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("passwords.description")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={openAdd}>
            <PlusIcon />
            {t("passwords.add")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            <UploadIcon />
            {t("passwords.import.action")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={exporting || credentials.length === 0}
            onClick={() => setExportConfirm(true)}
          >
            {exporting ? <Spinner /> : <DownloadIcon />}
            {t("passwords.export.action")}
          </Button>
        </div>
      </header>

      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label={t("passwords.search")}
          placeholder={t("passwords.searchPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="pl-8"
        />
      </div>

      {load.kind === "loading" ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t("common.loading")}
        </p>
      ) : load.kind === "failed" ? (
        <div role="alert" className="flex items-center justify-between gap-2 text-sm">
          <span className="text-destructive">{t("passwords.loadFailed")}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setLoad({ kind: "loading" })
              refresh()
            }}
          >
            {t("common.retry")}
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {query.trim()
            ? t("passwords.emptySearch", { query: query.trim() })
            : t("passwords.empty")}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t("passwords.count", { count: credentials.length })}
          </p>
          <ul className="divide-y rounded-md border">
            {visible.map((credential) => {
              const shown = revealed[credential.id]
              const busy = busyId === credential.id
              const sourceKey = `passwords.source.${credential.source}`
              return (
                <li
                  key={credential.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-3"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 space-y-0.5">
                      <p className="truncate text-sm font-medium">{credential.origin}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        {credential.username}
                      </p>
                      <p
                        className="font-mono text-xs break-all"
                        data-testid={`credential-secret-${credential.id}`}
                      >
                        {shown ?? "••••••••"}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {credential.source && (
                          <Badge variant="secondary">
                            {t.has(sourceKey) ? t(sourceKey) : credential.source}
                          </Badge>
                        )}
                        {credential.lastUsedAt != null && (
                          <span>
                            {t("passwords.lastUsed", {
                              date: format.dateTime(new Date(credential.lastUsedAt), {
                                dateStyle: "medium",
                              }),
                            })}
                          </span>
                        )}
                        {credential.note && <span className="truncate">{credential.note}</span>}
                      </div>
                    </div>
                  </div>
                  <div
                    role="group"
                    aria-label={t("passwords.actions", { origin: credential.origin })}
                    className="flex items-center gap-1"
                  >
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={shown ? t("passwords.hide") : t("passwords.reveal")}
                      onClick={() => (shown ? hide(credential.id) : void reveal(credential))}
                    >
                      {shown ? <EyeOffIcon /> : <EyeIcon />}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t("passwords.copy")}
                      onClick={() => void copy(credential)}
                    >
                      <CopyIcon />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("passwords.edit")}
                      onClick={() => openEdit(credential)}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      aria-label={t("passwords.delete")}
                      onClick={() => setPendingDelete(credential)}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}

      <BrowserCredentialFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        credential={editing}
        onSaved={onSaved}
      />
      <BrowserPasswordImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => {
          refresh()
        }}
      />
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("passwords.deleteConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("passwords.deleteConfirm.description", {
                username: pendingDelete?.username ?? "",
                origin: pendingDelete?.origin ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {t("passwords.deleteConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={exportConfirm} onOpenChange={setExportConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("passwords.export.action")}</AlertDialogTitle>
            <AlertDialogDescription>{t("passwords.export.warning")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runExport()}>
              {t("passwords.export.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
