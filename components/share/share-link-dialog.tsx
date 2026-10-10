"use client"

// Reusable "Share via link" dialog. Given a `buildPayload` thunk (so the
// artifact is only rendered when the user commits), it creates a zero-knowledge
// share link and shows the URL with copy / QR / revoke. Used by chat export,
// workflow export, backup, and A2UI share entry points.
//
// With a `files` source (ADR-0222) it also lets the user carry files from the
// conversation's FileSpace. Every share goes through `createFileShare`, which
// checks the shared-conversation authorization, the effective file-sharing
// policy and the sensitive-file confirmations before anything is uploaded;
// the dialog shows the same policy up front by offering only the lifetimes it
// allows.

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { QRCodeSVG } from "qrcode.react"
import { ExternalLinkIcon, Link2Icon, ShieldOffIcon } from "lucide-react"
import type { ChatSession } from "@cognia/agent-config-types"
import { CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  revokeShareLink,
  ShareFilesTooLargeError,
  ShareFilesUploadError,
  ShareNotConfiguredError,
  SharePayloadTooLargeError,
  ShareRequestError,
  type CreateShareProgress,
  type ShareBuild,
} from "@/lib/share/client"
import { ShareFileChangedError } from "@/lib/share/blobs"
import { checkShareSelectionLimits } from "@/lib/share/file-selection"
import type { SharePayload } from "@/lib/share/types"
import type { CreatedShare } from "@/lib/share/client"
import {
  createFileShare,
  FileShareRefusedError,
  type FileShareRefusal,
} from "@/lib/filespace/share-files"
import {
  loadEffectiveFileSharingPolicy,
  type EffectiveFileSharingPolicy,
} from "@/lib/filespace/policy"
import { useShareFileSelection } from "@/hooks/share/use-share-file-selection"
import type { FileSpacePath } from "@/types/filespace"
import { PayloadView } from "@/components/share/payload-view"
import { ShareFilesField } from "@/components/share/share-files-field"
import { createLogger } from "@cognia/logging"

const log = createLogger("share-link")

type TtlOption = "30d" | "1h" | "24h" | "7d"
const TTL_SECONDS: Record<TtlOption, number> = {
  "30d": 2_592_000,
  "1h": 3600,
  "24h": 86_400,
  "7d": 604_800,
}
/** Shortest first, for picking the longest one a policy still allows. */
const TTL_ASCENDING: TtlOption[] = ["1h", "24h", "7d", "30d"]
const TTL_LABEL: Record<TtlOption, string> = {
  "30d": "ttl.d30",
  "1h": "ttl.h1",
  "24h": "ttl.h24",
  "7d": "ttl.d7",
}
type LimitMode = "unlimited" | "count" | "burn"

const REFUSAL_KEY: Record<FileShareRefusal, string> = {
  "public-snapshots-disabled": "files.refused.publicSnapshotsDisabled",
  "ttl-exceeds-policy": "files.refused.ttlExceedsPolicy",
  "shared-session-forbidden": "files.refused.sharedSessionForbidden",
  "shared-session-unavailable": "files.refused.sharedSessionUnavailable",
  "sensitive-not-confirmed": "files.refused.sensitiveNotConfirmed",
}

/** Where the dialog can take files from, and what the share is made from. */
export interface ShareLinkFilesSource {
  /** The conversation whose FileSpace the files come from. */
  session: Pick<ChatSession, "id" | "collaboration">
  /** Paths ticked when the dialog opens ("Share files…" from the Files panel). */
  initialSelection?: FileSpacePath[]
  /** The share is the files (a `file-bundle`): creating needs at least one. */
  required?: boolean
}

interface Props {
  buildPayload: () => SharePayload | ShareBuild | Promise<SharePayload | ShareBuild>
  /** Optional product-owned summary shown before publishing (for example, selected chats). */
  artifactSummary?: React.ReactNode
  /** Offer the conversation's files (ADR-0222). */
  files?: ShareLinkFilesSource
  trigger?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Invoked when the user clicks the "open settings" CTA in the unconfigured state. */
  onConfigure?: () => void
}

function asBuild(built: SharePayload | ShareBuild): ShareBuild {
  return "payload" in built ? built : { payload: built, attachments: [] }
}

export function ShareLinkDialog({
  buildPayload,
  artifactSummary,
  files,
  trigger,
  open,
  onOpenChange,
  onConfigure,
}: Props) {
  const t = useTranslations("share")
  // Callers either control `open` or hand over a trigger; track the
  // uncontrolled case too so open-time work (the file policy) runs for both.
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const isOpen = open ?? uncontrolledOpen
  const [ttl, setTtl] = useState<TtlOption>("7d")
  const [limitMode, setLimitMode] = useState<LimitMode>("unlimited")
  const [maxViews, setMaxViews] = useState(5)
  const [passphrase, setPassphrase] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notConfigured, setNotConfigured] = useState(false)
  const [created, setCreated] = useState<CreatedShare | null>(null)
  const [createdFiles, setCreatedFiles] = useState(0)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [revoked, setRevoked] = useState(false)
  const [preview, setPreview] = useState<SharePayload | null>(null)
  const [unavailableMedia, setUnavailableMedia] = useState(0)
  const [selected, setSelected] = useState<FileSpacePath[]>(() => files?.initialSelection ?? [])
  const [confirmedSensitive, setConfirmedSensitive] = useState<ReadonlySet<string>>(new Set())
  const [policy, setPolicy] = useState<EffectiveFileSharingPolicy | null>(null)
  const [progress, setProgress] = useState<CreateShareProgress | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const selection = useShareFileSelection(files?.session.id ?? null, selected)
  const candidates = selection.expanded?.files ?? []
  const included = candidates.filter((file) => !file.sensitive || confirmedSensitive.has(file.path))
  const violations = checkShareSelectionLimits(included)
  const carriesFiles = included.length > 0

  // The effective policy decides which lifetimes a file share may ask for.
  // Keyed by the conversation, not the `files` object, which callers build
  // inline on every render.
  const filesSessionId = files?.session.id
  useEffect(() => {
    if (!filesSessionId || !isOpen) return
    let current = true
    void loadEffectiveFileSharingPolicy().then(
      (loaded) => {
        if (current) setPolicy(loaded)
      },
      (err: unknown) => {
        log.warn("share-file-policy-unavailable", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    )
    return () => {
      current = false
    }
  }, [filesSessionId, isOpen])

  const ttlCeiling = carriesFiles && policy ? policy.policy.maxSnapshotTtlSeconds : Infinity
  const ttlOptions = TTL_ASCENDING.filter((option) => TTL_SECONDS[option] <= ttlCeiling)
  // A lifetime the policy no longer allows reads as the longest one it does.
  const effectiveTtl: TtlOption | null = ttlOptions.includes(ttl)
    ? ttl
    : (ttlOptions.at(-1) ?? null)
  const snapshotsForbidden = carriesFiles && policy?.policy.allowPublicSnapshots === false

  const canCreate =
    !busy &&
    !selection.pending &&
    violations.length === 0 &&
    !snapshotsForbidden &&
    effectiveTtl !== null &&
    !(files?.required && !carriesFiles)

  const reset = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setCreated(null)
    setCreatedFiles(0)
    setError(null)
    setNotConfigured(false)
    setCopied(false)
    setRevoked(false)
    setPassphrase("")
    setPreview(null)
    setUnavailableMedia(0)
    setProgress(null)
    setSelected(files?.initialSelection ?? [])
    setConfirmedSensitive(new Set())
  }

  // Build the payload and render it locally — no server round-trip — so the
  // owner can see exactly what recipients will get before publishing.
  const onPreview = async () => {
    setError(null)
    try {
      const build = asBuild(await buildPayload())
      setUnavailableMedia(build.unavailableMedia ?? 0)
      setPreview(build.payload)
    } catch (err) {
      log.error("share-preview-failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      setError(t("errorGeneric"))
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }

  const onToggle = (path: FileSpacePath, checked: boolean) => {
    setSelected((current) =>
      checked
        ? current.includes(path)
          ? current
          : [...current, path]
        : current.filter((candidate) => candidate !== path)
    )
  }

  const onConfirmSensitive = (path: FileSpacePath, confirmed: boolean) => {
    setConfirmedSensitive((current) => {
      const next = new Set(current)
      if (confirmed) next.add(path)
      else next.delete(path)
      return next
    })
  }

  const describeError = (err: unknown): string => {
    if (err instanceof FileShareRefusedError) return t(REFUSAL_KEY[err.reason])
    if (err instanceof ShareFilesTooLargeError) return t("files.errorTooLarge")
    if (err instanceof ShareFilesUploadError) {
      if (err.cause instanceof ShareFileChangedError) {
        return t("files.errorChanged", { path: err.cause.path })
      }
      return err.revoked ? t("files.errorUploadWithdrawn") : t("files.errorUploadNotWithdrawn")
    }
    if (
      err instanceof SharePayloadTooLargeError ||
      (err instanceof ShareRequestError && err.status === 413)
    ) {
      return t("errorTooLarge")
    }
    return t("errorGeneric")
  }

  const onCreate = async () => {
    if (!effectiveTtl) return
    setBusy(true)
    setError(null)
    setNotConfigured(false)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const build = asBuild(await buildPayload())
      setUnavailableMedia(build.unavailableMedia ?? 0)
      const result = await createFileShare({
        payload: build.payload,
        ttlSeconds: TTL_SECONDS[effectiveTtl],
        maxViews: limitMode === "count" ? maxViews : undefined,
        burnAfterRead: limitMode === "burn",
        passphrase: passphrase || undefined,
        session: files?.session,
        files: included,
        attachments: build.attachments,
        confirmedSensitive,
        onProgress: setProgress,
        signal: controller.signal,
      })
      setCreatedFiles(included.length + build.attachments.length)
      setCreated(result)
    } catch (err) {
      if (controller.signal.aborted) {
        // Cancelling withdraws a half-made link like any failed upload; when
        // that withdrawal failed too, the link is live and must be revoked.
        setError(
          err instanceof ShareFilesUploadError && !err.revoked
            ? t("files.errorUploadNotWithdrawn")
            : t("files.cancelled")
        )
      } else if (err instanceof ShareNotConfiguredError) {
        setNotConfigured(true)
      } else {
        log.error("share-create-failed", {
          error: err instanceof Error ? err.message : String(err),
        })
        setError(describeError(err))
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setProgress(null)
      setBusy(false)
    }
  }

  const onCopy = async () => {
    if (!created) return
    await navigator.clipboard.writeText(created.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const onRevoke = async () => {
    if (!created) return
    setRevoking(true)
    try {
      await revokeShareLink(created.code)
      setRevoked(true)
    } catch (err) {
      log.error("share-revoke-failed", { error: err instanceof Error ? err.message : String(err) })
      setError(t("errorGeneric"))
    } finally {
      setRevoking(false)
    }
  }

  const progressPercent =
    progress && progress.total > 0 ? Math.floor((progress.done / progress.total) * 100) : 0

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2Icon className="size-4" />
            {t("dialogTitle")}
          </DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>

        {notConfigured ? (
          <div className="space-y-3 py-2 text-center">
            <ShieldOffIcon className="mx-auto size-8 text-muted-foreground" />
            <p className="font-medium">{t("notConfiguredTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("notConfiguredBody")}</p>
            {onConfigure && (
              <Button variant="outline" onClick={onConfigure}>
                {t("notConfiguredCta")}
              </Button>
            )}
          </div>
        ) : created ? (
          <div className="space-y-4 py-2">
            <p className="text-sm font-medium">{t("createdTitle")}</p>
            <div className="flex gap-2">
              <Input
                readOnly
                value={created.url}
                aria-label={t("linkLabel")}
                className="font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon"
                aria-label={t("copy")}
                onClick={() => void onCopy()}
              >
                <CopyFeedbackIcon copied={copied} size={16} />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("createdHelp")}</p>
            <p className="text-xs text-muted-foreground">
              {created.expiresAt !== undefined
                ? t("createdExpiry", { date: new Date(created.expiresAt).toLocaleString() })
                : t("expiryUnavailable")}
            </p>
            {createdFiles > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("files.createdCount", { count: createdFiles })}
              </p>
            ) : null}
            <div className="flex flex-col items-center gap-1">
              <QRCodeSVG value={created.url} size={160} level="M" aria-label={t("scanHint")} />
              <span className="text-xs text-muted-foreground">{t("scanHint")}</span>
            </div>
            {revoked && <p className="text-center text-sm text-muted-foreground">{t("revoked")}</p>}
          </div>
        ) : preview ? (
          <div className="space-y-2 py-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">{t("view.previewTitle")}</p>
              <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>
                {t("view.previewClose")}
              </Button>
            </div>
            {unavailableMedia > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("files.unavailableMedia", { count: unavailableMedia })}
              </p>
            ) : null}
            <div className="max-h-[50vh] overflow-auto rounded-md border border-border p-3">
              <PayloadView payload={preview} />
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {artifactSummary}
            {files ? (
              <ShareFilesField
                selection={selection}
                selected={selected}
                onToggle={onToggle}
                confirmedSensitive={confirmedSensitive}
                onConfirmSensitive={onConfirmSensitive}
                violations={violations}
              />
            ) : null}
            {snapshotsForbidden ? (
              <p className="text-xs text-destructive">
                {t(
                  policy?.orgUnavailable
                    ? "files.policyOrgUnavailable"
                    : "files.refused.publicSnapshotsDisabled"
                )}
              </p>
            ) : null}
            <div className="space-y-1">
              <Label className="text-xs">{t("ttlLabel")}</Label>
              <Select
                value={effectiveTtl ?? undefined}
                onValueChange={(v) => setTtl(v as TtlOption)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[...ttlOptions].reverse().map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(TTL_LABEL[option])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("ttlHelp")}</p>
              {carriesFiles && ttlOptions.length < TTL_ASCENDING.length ? (
                <p className="text-xs text-muted-foreground">{t("files.ttlLimitedByPolicy")}</p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label className="text-xs">{t("limitLabel")}</Label>
              <Select value={limitMode} onValueChange={(v) => setLimitMode(v as LimitMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unlimited">{t("limit.unlimited")}</SelectItem>
                  <SelectItem value="count">{t("limit.count")}</SelectItem>
                  <SelectItem value="burn">{t("limit.burn")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {limitMode === "count" && (
              <div className="space-y-1">
                <Label className="text-xs">{t("maxViewsLabel")}</Label>
                <Input
                  type="number"
                  min={1}
                  value={maxViews}
                  onChange={(e) => setMaxViews(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs">{t("passphraseLabel")}</Label>
              <Input
                type="password"
                value={passphrase}
                placeholder={t("passphrasePlaceholder")}
                onChange={(e) => setPassphrase(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("passphraseHelp")}</p>
            </div>

            {progress ? (
              <div className="space-y-1" role="status">
                <p className="text-xs text-muted-foreground">
                  {t(progress.phase === "hashing" ? "files.hashing" : "files.uploading", {
                    index: progress.fileIndex + 1,
                    count: progress.fileCount,
                  })}
                </p>
                <Progress value={progressPercent} aria-label={t("files.progressLabel")} />
              </div>
            ) : null}

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {created ? (
            <>
              <Button
                variant="ghost"
                onClick={() => void onRevoke()}
                disabled={revoking || revoked}
              >
                {revoking ? t("revoking") : t("revoke")}
              </Button>
              <Button asChild variant="outline">
                <a href={created.url} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon className="mr-1.5 size-4" />
                  {t("openLink")}
                </a>
              </Button>
              <Button onClick={() => handleOpenChange(false)}>{t("done")}</Button>
            </>
          ) : notConfigured ? null : (
            <>
              {busy && progress ? (
                <Button variant="ghost" onClick={() => abortRef.current?.abort()}>
                  {t("files.cancel")}
                </Button>
              ) : null}
              {!preview && !files?.required && (
                <Button variant="outline" onClick={() => void onPreview()} disabled={busy}>
                  {t("view.preview")}
                </Button>
              )}
              <Button onClick={() => void onCreate()} disabled={!canCreate}>
                {busy ? t("creating") : t("createButton")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
