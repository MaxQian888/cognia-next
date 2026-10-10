"use client"

/**
 * "Share as a network drive" (ADR-0222 §7.5): choose paths of one
 * conversation's FileSpace, what may be done with them, for how long and over
 * which protocols, and get a WebDAV/SFTP sign-in for them.
 *
 * The host the files live on is the authority. This dialog offers only what
 * that host's policy allows (its own pushed copy, `status.policy`), says what
 * would make the share unreachable (the listener off, a protocol off), and
 * shows the one-time passwords the host answers with. It never sees a
 * password again; losing one means rotating it from the grants list.
 */

import { useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"

import { ShareFilesPicker } from "@/components/share/share-files-picker"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { listWorkspaceDir } from "@/lib/files/workspace-fs"
import { createLiveGrant, fileShareErrorDetails } from "@/lib/filespace/grants-client"
import { isFileSpacePathWithin, normalizeFileSpacePath } from "@/lib/filespace/paths"
import { FILE_SHARING_TTL_PRESETS_SECONDS } from "@/lib/filespace/policy"
import { fileSharingPolicyHref, networkDriveSettingsHref } from "@/lib/filespace/settings-links"
import type { FileSpaceDexieListing } from "@/lib/filespace/sources"
import type { ConversationFileSpace, FileSpacePath } from "@/types/filespace"
import type {
  CreatedLiveGrant,
  FileShareStatus,
  LiveProtocol,
  LiveProvider,
} from "@/types/filespace/live"

import { LiveShareCredentials } from "./live-share-credentials"

const HOUR = 60 * 60
const DAY = 24 * HOUR
/** What a new share lasts unless the person picks otherwise. */
const DEFAULT_TTL_SECONDS = DAY
const MAX_LABEL_CHARS = 120
const PROTOCOLS: readonly LiveProtocol[] = ["webdav", "sftp"]

export interface LiveShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  space: ConversationFileSpace
  dexie: FileSpaceDexieListing
  /** The host's status, read by the surface that opened the dialog. */
  status: FileShareStatus
  initialSelection?: readonly FileSpacePath[]
  onCreated?: (created: CreatedLiveGrant) => void
  /** Injectable for tests; the file tree's own listing by default. */
  listDir?: typeof listWorkspaceDir
}

/** Why the host would refuse any grant from here, or `null`. */
export function liveShareBlock(
  status: FileShareStatus
): "locked" | "liveDisabled" | "credentialsDisabled" | null {
  if (!status.active) return "locked"
  if (!status.policy.allowLiveGrants) return "liveDisabled"
  if (!status.policy.allowProtocolCredentials) return "credentialsDisabled"
  return null
}

/** The lifetimes the policy allows, shortest first, and the one to start on. */
export function liveTtlOptions(maxSeconds: number): { options: number[]; initial: number } {
  const options = FILE_SHARING_TTL_PRESETS_SECONDS.filter((seconds) => seconds <= maxSeconds)
  if (!options.includes(maxSeconds)) options.push(maxSeconds)
  options.sort((a, b) => a - b)
  const initial = options.includes(DEFAULT_TTL_SECONDS)
    ? DEFAULT_TTL_SECONDS
    : (options.filter((seconds) => seconds < DEFAULT_TTL_SECONDS).at(-1) ?? options[0]!)
  return { options, initial }
}

/** Whether every chosen path lies in a disk mount this conversation may change. */
export function selectionIsWritable(
  space: ConversationFileSpace,
  selected: readonly FileSpacePath[]
): boolean {
  return selected.every((path) =>
    space.mounts.some((mount) => {
      const prefix = normalizeFileSpacePath(mount.virtualPath)
      return (
        prefix !== null &&
        isFileSpacePathWithin(path, prefix) &&
        mount.backing === "disk" &&
        mount.writable
      )
    })
  )
}

export function LiveShareDialog(props: LiveShareDialogProps) {
  const t = useTranslations("liveShare")
  const { open, onOpenChange, status } = props
  const [created, setCreated] = useState<CreatedLiveGrant | null>(null)
  const block = liveShareBlock(status)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("dialog.resultTitle")}</DialogTitle>
              <DialogDescription>{t("dialog.resultDescription")}</DialogDescription>
            </DialogHeader>
            <LiveShareCredentials credentials={created.credentials} endpoints={created.endpoints} />
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t("dialog.done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("dialog.title")}</DialogTitle>
              <DialogDescription>{t("dialog.description")}</DialogDescription>
            </DialogHeader>
            {block ? (
              <Alert data-testid="live-share-blocked">
                <AlertTitle>{t("dialog.blocked.title")}</AlertTitle>
                <AlertDescription>
                  <p>{t(`dialog.blocked.${block}`)}</p>
                  {block !== "locked" ? (
                    <Button asChild variant="link" className="h-auto p-0">
                      <Link href={fileSharingPolicyHref()}>{t("dialog.blocked.openPolicy")}</Link>
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : (
              <LiveShareForm
                {...props}
                onCreated={(next) => {
                  setCreated(next)
                  props.onCreated?.(next)
                }}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function LiveShareForm({
  onOpenChange,
  space,
  dexie,
  status,
  initialSelection = [],
  onCreated,
  listDir,
}: LiveShareDialogProps & { onCreated: (created: CreatedLiveGrant) => void }) {
  const t = useTranslations("liveShare")
  const tp = useTranslations("share.policy")
  const policy = status.policy
  const ttl = liveTtlOptions(policy.maxLiveTtlSeconds)
  const [selected, setSelected] = useState<FileSpacePath[]>([...initialSelection])
  const [label, setLabel] = useState("")
  const [download, setDownload] = useState(true)
  const [write, setWrite] = useState(false)
  const [ttlSeconds, setTtlSeconds] = useState(ttl.initial)
  const [protocols, setProtocols] = useState<LiveProtocol[]>(["webdav"])
  const [provider, setProvider] = useState<LiveProvider>("builtin")
  const [sshKey, setSshKey] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const writableSelection = selectionIsWritable(space, selected)
  const writeAllowed = policy.allowLiveWrite && writableSelection
  const effectiveWrite = write && writeAllowed
  const listener = status.listener
  const listenerWarnings: string[] =
    provider === "builtin"
      ? !listener.config.enabled || listener.endpoints.unavailableReason === "listener_off"
        ? [t("dialog.listener.off")]
        : protocols
            .filter((protocol) => !listener.config[protocol])
            .map((protocol) =>
              t("dialog.listener.protocolOff", { protocol: t(`dialog.protocol.${protocol}`) })
            )
      : []
  const problem =
    selected.length === 0
      ? t("dialog.nothingSelected")
      : protocols.length === 0
        ? t("dialog.noProtocol")
        : null

  const duration = (seconds: number) =>
    seconds % DAY === 0
      ? tp("duration.days", { count: seconds / DAY })
      : tp("duration.hours", { count: Math.round(seconds / HOUR) })

  const toggle = (path: FileSpacePath, checked: boolean) =>
    setSelected((current) =>
      checked
        ? // A folder covers what is under it: drop the paths it now implies.
          [...current.filter((chosen) => !isFileSpacePathWithin(chosen, path)), path]
        : current.filter((chosen) => chosen !== path)
    )

  const submit = async () => {
    if (problem) return
    setSubmitting(true)
    setError(null)
    try {
      const sftp = protocols.includes("sftp")
      const created = await createLiveGrant(
        {
          sessionId: space.sessionId,
          paths: selected,
          permissions: [
            "read",
            ...(download ? (["download"] as const) : []),
            ...(effectiveWrite ? (["write"] as const) : []),
          ],
          protocols,
          provider,
          expiresInSeconds: ttlSeconds,
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(sftp && sshKey.trim() ? { sshPublicKey: sshKey.trim() } : {}),
        },
        { hostId: space.hostId }
      )
      onCreated(created)
    } catch (caught) {
      const { code, message } = fileShareErrorDetails(caught)
      setError(t(`errors.${code}`, { message }))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="space-y-1.5">
        <Label>{t("dialog.files")}</Label>
        <ShareFilesPicker
          space={space}
          dexie={dexie}
          selected={selected}
          onToggle={toggle}
          {...(listDir ? { listDir } : {})}
        />
        <p className="text-xs text-muted-foreground">{t("dialog.filesHint")}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="live-share-label">{t("dialog.label")}</Label>
        <Input
          id="live-share-label"
          value={label}
          maxLength={MAX_LABEL_CHARS}
          placeholder={t("dialog.labelPlaceholder")}
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("dialog.permissions")}</legend>
        <CheckRow id="live-share-read" checked disabled label={t("dialog.permission.read")}>
          {t("dialog.permission.readHint")}
        </CheckRow>
        <CheckRow
          id="live-share-download"
          checked={download}
          onChange={setDownload}
          label={t("dialog.permission.download")}
        />
        <CheckRow
          id="live-share-write"
          checked={effectiveWrite}
          disabled={!writeAllowed}
          onChange={setWrite}
          label={t("dialog.permission.write")}
        >
          {!policy.allowLiveWrite
            ? t("dialog.permission.writeDisabledPolicy")
            : !writableSelection
              ? t("dialog.permission.writeReadOnly")
              : null}
        </CheckRow>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("dialog.protocols")}</legend>
        {PROTOCOLS.map((protocol) => (
          <CheckRow
            key={protocol}
            id={`live-share-${protocol}`}
            checked={protocols.includes(protocol)}
            onChange={(checked) =>
              setProtocols((current) =>
                checked
                  ? PROTOCOLS.filter((p) => p === protocol || current.includes(p))
                  : current.filter((p) => p !== protocol)
              )
            }
            label={t(`dialog.protocol.${protocol}`)}
          >
            {t(`dialog.protocol.${protocol}Hint`)}
          </CheckRow>
        ))}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="live-share-expiry">{t("dialog.expiry")}</Label>
          <Select value={String(ttlSeconds)} onValueChange={(next) => setTtlSeconds(Number(next))}>
            <SelectTrigger id="live-share-expiry" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ttl.options.map((seconds) => (
                <SelectItem key={seconds} value={String(seconds)}>
                  {duration(seconds)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {status.sftpgo.configured ? (
          <div className="space-y-1.5">
            <Label htmlFor="live-share-provider">{t("dialog.providerLabel")}</Label>
            <Select value={provider} onValueChange={(next) => setProvider(next as LiveProvider)}>
              <SelectTrigger id="live-share-provider" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="builtin">{t("dialog.provider.builtin")}</SelectItem>
                <SelectItem value="sftpgo">{t("dialog.provider.sftpgo")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      {protocols.includes("sftp") ? (
        <div className="space-y-1.5">
          <Label htmlFor="live-share-ssh-key">{t("dialog.sshKey")}</Label>
          <Textarea
            id="live-share-ssh-key"
            value={sshKey}
            rows={2}
            className="font-mono text-xs"
            placeholder={t("dialog.sshKeyPlaceholder")}
            onChange={(event) => setSshKey(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("dialog.sshKeyHint")}</p>
        </div>
      ) : null}

      {listenerWarnings.length > 0 ? (
        <Alert data-testid="live-share-listener-warning">
          <AlertDescription>
            {listenerWarnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
            <Button asChild variant="link" className="h-auto p-0">
              <Link href={networkDriveSettingsHref()}>{t("dialog.listener.openSettings")}</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {t("dialog.cancel")}
        </Button>
        <Button
          type="submit"
          disabled={submitting || problem !== null}
          title={problem ?? undefined}
        >
          {submitting ? (
            <>
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
              {t("dialog.creating")}
            </>
          ) : (
            t("dialog.create")
          )}
        </Button>
      </DialogFooter>
    </form>
  )
}

function CheckRow({
  id,
  checked,
  disabled = false,
  onChange,
  label,
  children,
}: {
  id: string
  checked: boolean
  disabled?: boolean
  onChange?: (checked: boolean) => void
  label: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange?.(next === true)}
        className="mt-0.5"
      />
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="text-sm font-normal">
          {label}
        </Label>
        {children ? <p className="text-xs text-muted-foreground">{children}</p> : null}
      </div>
    </div>
  )
}
