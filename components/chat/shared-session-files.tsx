"use client"

/**
 * A shared conversation's files, as a member reaches them (ADR-0222 §6).
 *
 * The files stay on the device that holds them. When that device has shared
 * some with this conversation's members, they are listed here; browsing,
 * downloading and (where the share and the member's role allow) changing them
 * are requests the collaboration server relays to that device. While it is
 * offline a request waits up to two minutes and then says so.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import {
  ArrowUpIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"
import { toast } from "sonner"
import type { SessionRole } from "@cognia/agent-config-types"

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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import type { CollabClient, CollabFileGrant, CollabFileHost } from "@/lib/collab/client"
import {
  deleteMemberPath,
  isValidMemberName,
  joinMemberPath,
  listMemberFolder,
  makeMemberFolder,
  MAX_MEMBER_TRANSFER_BYTES,
  MemberFileError,
  parentMemberPath,
  readMemberFile,
  renameMemberPath,
  writeMemberFile,
  type MemberFileEntry,
  type SharedFilesTarget,
} from "@/lib/collab/file-requests"
import { downloadBlob } from "@/lib/files/download"

/** Refusal codes with their own sentence; anything else reads as `unknown`. */
const KNOWN_ERRORS = [
  "not_found",
  "permission",
  "not_admitted",
  "sensitive",
  "read_only",
  "grant_inactive",
  "grant_expired",
  "policy",
  "stale",
  "session_archived",
  "session_deleted",
  "mount_unavailable",
  "grant_root",
  "symlink",
  "invalid_path",
  "too_large",
  "is_folder",
  "not_a_folder",
  "exists",
  "not_empty",
  "cross_mount",
  "upload_mismatch",
  "withdrawn",
  "unavailable",
  "host_unavailable",
  "timeout",
  "no_file_host",
] as const

export interface SharedSessionFilesProps {
  client: Pick<
    CollabClient,
    | "listFileGrants"
    | "createFileRequest"
    | "getFileRequest"
    | "uploadFileRequestBytes"
    | "downloadFileRequestResult"
    | "unregisterFileHost"
  >
  orgId: string
  /** The conversation's id on the collaboration server. */
  sessionId: string
  /** The member's role: a viewer only ever reads. */
  role: SessionRole | null
  /**
   * The member may share this conversation's files (`files.share`), so may
   * also remove the device sharing them — the way to end a lost or
   * unreachable device's sharing from anywhere else.
   */
  canRemoveHost?: boolean
}

interface Browsing {
  grant: CollabFileGrant
  path: string
}

function errorCode(error: unknown): string {
  if (error instanceof MemberFileError) return error.code
  if (error && typeof error === "object" && "reason" in error) {
    const reason = (error as { reason?: unknown }).reason
    if (typeof reason === "string") return reason
  }
  return "unknown"
}

/** The folder a share is browsed from: its one folder, or the root that leads to its paths. */
function startPath(grant: CollabFileGrant): string {
  const [only] = grant.paths
  return grant.paths.length === 1 && only?.isDir ? only.path : "/"
}

export function SharedSessionFiles({
  client,
  orgId,
  sessionId,
  role,
  canRemoveHost = false,
}: SharedSessionFilesProps) {
  const t = useTranslations("chatCollaboration.files")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error" }
    | { kind: "ready"; host: CollabFileHost; grants: CollabFileGrant[] }
  >({ kind: "loading" })
  const [browsing, setBrowsing] = useState<Browsing | null>(null)
  const [listing, setListing] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; entries: MemberFileEntry[]; truncated: boolean }
    | { kind: "error"; code: string }
  >({ kind: "idle" })
  const [busy, setBusy] = useState(false)
  const [naming, setNaming] = useState<
    { kind: "folder" } | { kind: "rename"; entry: MemberFileEntry } | null
  >(null)
  const [name, setName] = useState("")
  const uploadRef = useRef<HTMLInputElement>(null)
  const target: SharedFilesTarget = { client, orgId, sessionId }

  const describe = (code: string) =>
    (KNOWN_ERRORS as readonly string[]).includes(code)
      ? t(`errors.${code}`)
      : t("errors.unknown", { code })

  // Bumped to read the shares again.
  const [reads, setReads] = useState(0)

  useEffect(() => {
    let cancelled = false
    client.listFileGrants(orgId, sessionId).then(
      (next) => {
        if (!cancelled) setState({ kind: "ready", host: next.host, grants: next.grants })
      },
      () => {
        if (!cancelled) setState({ kind: "error" })
      }
    )
    return () => {
      cancelled = true
    }
  }, [client, orgId, sessionId, reads])

  const list = useCallback(
    async (next: Browsing) => {
      setBrowsing(next)
      setListing({ kind: "loading" })
      try {
        const result = await listMemberFolder(
          { client, orgId, sessionId },
          next.grant.id,
          next.path
        )
        setListing({ kind: "ready", entries: result.entries, truncated: result.truncated })
      } catch (error) {
        setListing({ kind: "error", code: errorCode(error) })
      }
    },
    [client, orgId, sessionId]
  )

  const canWrite = (grant: CollabFileGrant) =>
    grant.permissions.includes("write") && role !== null && role !== "viewer"

  const run = async (work: () => Promise<void>, done: string) => {
    if (!browsing) return
    setBusy(true)
    try {
      await work()
      toast.success(done)
      await list(browsing)
    } catch (error) {
      toast.error(describe(errorCode(error)))
    } finally {
      setBusy(false)
    }
  }

  const download = async (entry: MemberFileEntry) => {
    if (!browsing) return
    setBusy(true)
    try {
      const blob = await readMemberFile(
        target,
        browsing.grant.id,
        joinMemberPath(browsing.path, entry.name)
      )
      await downloadBlob(blob, entry.name)
    } catch (error) {
      toast.error(describe(errorCode(error)))
    } finally {
      setBusy(false)
    }
  }

  const upload = async (file: File) => {
    if (!browsing) return
    if (file.size > MAX_MEMBER_TRANSFER_BYTES) {
      toast.error(describe("too_large"))
      return
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    await run(
      () =>
        writeMemberFile(target, browsing.grant.id, joinMemberPath(browsing.path, file.name), bytes),
      t("toast.uploaded", { name: file.name })
    )
  }

  const submitName = async () => {
    if (!browsing || !naming || !isValidMemberName(name.trim())) return
    const chosen = name.trim()
    const pending = naming
    setNaming(null)
    if (pending.kind === "folder") {
      await run(
        () => makeMemberFolder(target, browsing.grant.id, joinMemberPath(browsing.path, chosen)),
        t("toast.folderCreated", { name: chosen })
      )
    } else {
      await run(
        () =>
          renameMemberPath(
            target,
            browsing.grant.id,
            joinMemberPath(browsing.path, pending.entry.name),
            joinMemberPath(browsing.path, chosen)
          ),
        t("toast.renamed", { name: chosen })
      )
    }
  }

  const [removingHost, setRemovingHost] = useState(false)
  const removeHost = async () => {
    setBusy(true)
    try {
      await client.unregisterFileHost(orgId, sessionId)
      toast.success(t("removeHost.done"))
      setBrowsing(null)
      setListing({ kind: "idle" })
    } catch {
      toast.error(t("removeHost.failed"))
    } finally {
      setBusy(false)
      setReads((n) => n + 1)
    }
  }

  const host = state.kind === "ready" ? state.host : null

  return (
    <section className="space-y-3" aria-labelledby="shared-files-heading">
      <div className="flex items-center justify-between gap-2">
        <h3 id="shared-files-heading" className="text-sm font-semibold">
          {t("title")}
        </h3>
        <div className="flex items-center gap-1.5">
          {host?.registered ? (
            <Badge
              variant={host.online ? "secondary" : "outline"}
              data-testid="shared-files-host"
              title={host.hostLabel}
            >
              {host.hostLabel
                ? t(host.online ? "host.online" : "host.offline", { host: host.hostLabel })
                : t(host.online ? "host.onlineUnnamed" : "host.offlineUnnamed")}
            </Badge>
          ) : null}
          {host?.registered && canRemoveHost ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => setRemovingHost(true)}
            >
              {t("removeHost.action")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("refresh")}
            onClick={() => {
              setReads((n) => n + 1)
              if (browsing) void list(browsing)
            }}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {state.kind === "loading" ? (
        <Spinner className="size-4" />
      ) : state.kind === "error" ? (
        <p role="alert" className="text-xs text-destructive">
          {t("loadFailed")}
        </p>
      ) : !state.host.registered ? (
        <p className="text-xs text-muted-foreground">{t("noHost")}</p>
      ) : state.grants.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("nothingShared")}</p>
      ) : (
        <>
          {!state.host.online ? (
            <p
              className="text-xs text-amber-600 dark:text-amber-400"
              data-testid="shared-files-offline"
            >
              {t("offlineHint")}
            </p>
          ) : null}
          <ul className="space-y-2">
            {state.grants.map((grant) => (
              <li
                key={grant.id}
                className="space-y-1 rounded-lg border p-2"
                data-testid={`shared-files-grant-${grant.id}`}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {grant.label ?? t("untitled")}
                  </span>
                  <Button
                    size="sm"
                    variant={browsing?.grant.id === grant.id ? "secondary" : "outline"}
                    onClick={() => void list({ grant, path: startPath(grant) })}
                  >
                    {t("browse")}
                  </Button>
                </div>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {grant.paths.map((path) => path.path).join(", ")}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {[
                    t("permission.read"),
                    ...(grant.permissions.includes("download") ? [t("permission.download")] : []),
                    ...(canWrite(grant) ? [t("permission.write")] : []),
                  ].join(" · ")}
                  {" · "}
                  {t("expires", {
                    when: format.relativeTime(new Date(grant.expiresAt), now),
                  })}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}

      {browsing ? (
        <div className="space-y-2 rounded-lg border p-2" data-testid="shared-files-browser">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t("up")}
              disabled={busy || browsing.path === "/"}
              onClick={() => void list({ ...browsing, path: parentMemberPath(browsing.path) })}
            >
              <ArrowUpIcon className="size-3.5" />
            </Button>
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={browsing.path}>
              {browsing.path}
            </span>
            {canWrite(browsing.grant) ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t("newFolder")}
                  disabled={busy}
                  onClick={() => {
                    setName("")
                    setNaming({ kind: "folder" })
                  }}
                >
                  <FolderPlusIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t("upload")}
                  disabled={busy}
                  onClick={() => uploadRef.current?.click()}
                >
                  <UploadIcon className="size-3.5" />
                </Button>
                <input
                  ref={uploadRef}
                  type="file"
                  className="hidden"
                  aria-label={t("uploadInput")}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ""
                    if (file) void upload(file)
                  }}
                />
              </>
            ) : null}
          </div>
          {listing.kind === "loading" ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              {t("waiting")}
            </p>
          ) : listing.kind === "error" ? (
            <p role="alert" className="text-xs text-destructive">
              {describe(listing.code)}
            </p>
          ) : listing.kind === "ready" ? (
            listing.entries.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("emptyFolder")}</p>
            ) : (
              <ul className="space-y-0.5">
                {listing.entries.map((entry) => (
                  <li
                    key={entry.name}
                    className="flex items-center gap-1.5 rounded px-1 py-0.5 text-sm hover:bg-muted/50"
                    data-testid={`shared-files-entry-${entry.name}`}
                  >
                    {entry.isDir ? (
                      <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    ) : (
                      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    {entry.isDir ? (
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left hover:underline"
                        disabled={busy}
                        onClick={() =>
                          void list({
                            ...browsing,
                            path: joinMemberPath(browsing.path, entry.name),
                          })
                        }
                      >
                        {entry.name}
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    )}
                    {!entry.isDir && browsing.grant.permissions.includes("download") ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        aria-label={t("download", { name: entry.name })}
                        disabled={busy}
                        onClick={() => void download(entry)}
                      >
                        <DownloadIcon className="size-3" />
                      </Button>
                    ) : null}
                    {canWrite(browsing.grant) ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          aria-label={t("rename", { name: entry.name })}
                          disabled={busy}
                          onClick={() => {
                            setName(entry.name)
                            setNaming({ kind: "rename", entry })
                          }}
                        >
                          <PencilIcon className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          aria-label={t("delete", { name: entry.name })}
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () =>
                                deleteMemberPath(
                                  target,
                                  browsing.grant.id,
                                  joinMemberPath(browsing.path, entry.name)
                                ),
                              t("toast.deleted", { name: entry.name })
                            )
                          }
                        >
                          <Trash2Icon className="size-3" />
                        </Button>
                      </>
                    ) : null}
                  </li>
                ))}
                {listing.truncated ? (
                  <li className="text-[11px] text-muted-foreground">{t("truncated")}</li>
                ) : null}
              </ul>
            )
          ) : null}
        </div>
      ) : null}

      <AlertDialog open={removingHost} onOpenChange={setRemovingHost}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeHost.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("removeHost.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setRemovingHost(false)
                void removeHost()
              }}
            >
              {t("removeHost.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={naming !== null} onOpenChange={(open) => !open && setNaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {naming?.kind === "rename" ? t("renameTitle") : t("newFolderTitle")}
            </DialogTitle>
          </DialogHeader>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault()
              void submitName()
            }}
          >
            <Label htmlFor="shared-files-name">{t("name")}</Label>
            <Input
              id="shared-files-name"
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
            {name.trim() && !isValidMemberName(name.trim()) ? (
              <p className="text-xs text-destructive">{t("invalidName")}</p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNaming(null)}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={!isValidMemberName(name.trim())}>
                {naming?.kind === "rename" ? t("renameConfirm") : t("create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
