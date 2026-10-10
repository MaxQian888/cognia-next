"use client"

/**
 * Connectivity → Network drive → SFTPGo (ADR-0222 §7.4): a separately
 * deployed SFTPGo the host creates share users in, instead of serving them
 * itself. Useful on a server whose workspaces SFTPGo already sees.
 *
 * The admin API key is write-only: the host keeps it in the system keychain
 * and only says whether one is set. Each folder a grant shares must map to a
 * path SFTPGo sees, or the grant is refused (`sftpgo_path_unmapped`).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { CopyValue } from "@/components/filespace/live-share-credentials"
import { SettingsBlock, SettingsField } from "@/components/settings/common/settings-block"
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
import { Label } from "@/components/ui/label"
import {
  fileShareErrorDetails,
  setSftpgoProvider,
  type FileShareTarget,
} from "@/lib/filespace/grants-client"
import type { SftpgoConfig, SftpgoPathMapping, SftpgoStatus } from "@/types/filespace/live"

interface Draft {
  baseUrl: string
  apiKey: string
  homeBase: string
  pathMappings: SftpgoPathMapping[]
  publicSftpHost: string
  publicSftpPort: string
  publicWebdavUrl: string
}

function draftOf(config: SftpgoConfig | null): Draft {
  return {
    baseUrl: config?.baseUrl ?? "",
    apiKey: "",
    homeBase: config?.homeBase ?? "",
    pathMappings: config?.pathMappings.length
      ? config.pathMappings.map((mapping) => ({ ...mapping }))
      : [{ hostPrefix: "", sftpgoPrefix: "" }],
    publicSftpHost: config?.publicSftpHost ?? "",
    publicSftpPort: config?.publicSftpPort ? String(config.publicSftpPort) : "",
    publicWebdavUrl: config?.publicWebdavUrl ?? "",
  }
}

/** The config the draft describes, blank optional fields left out. */
export function sftpgoConfigOf(draft: Draft): SftpgoConfig {
  const port = Number.parseInt(draft.publicSftpPort, 10)
  return {
    baseUrl: draft.baseUrl.trim(),
    homeBase: draft.homeBase.trim(),
    pathMappings: draft.pathMappings
      .map((mapping) => ({
        hostPrefix: mapping.hostPrefix.trim(),
        sftpgoPrefix: mapping.sftpgoPrefix.trim(),
      }))
      .filter((mapping) => mapping.hostPrefix && mapping.sftpgoPrefix),
    publicSftpHost: draft.publicSftpHost.trim() || null,
    publicSftpPort: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
    publicWebdavUrl: draft.publicWebdavUrl.trim() || null,
  }
}

export interface SftpgoBlockProps {
  sftpgo: SftpgoStatus
  pendingProviderOps: number
  target: FileShareTarget
  onSaved: () => void
}

export function SftpgoBlock({ sftpgo, pendingProviderOps, target, onSaved }: SftpgoBlockProps) {
  const t = useTranslations("liveShare.settings.sftpgo")
  const tl = useTranslations("liveShare")
  const [draft, setDraft] = useState<Draft>(() => draftOf(sftpgo.config))
  const [saving, setSaving] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const edit = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))
  const config = sftpgoConfigOf(draft)
  // A first configuration needs the key; afterwards an empty field keeps it.
  const complete =
    config.baseUrl !== "" &&
    config.homeBase !== "" &&
    config.pathMappings.length > 0 &&
    (sftpgo.apiKeySet || draft.apiKey.trim() !== "")

  const run = async (change: Parameters<typeof setSftpgoProvider>[0], done: string) => {
    setSaving(true)
    try {
      await setSftpgoProvider(change, target)
      toast.success(done)
      onSaved()
    } catch (error) {
      const { code, message } = fileShareErrorDetails(error)
      toast.error(tl(`errors.${code}`, { message }))
    } finally {
      setSaving(false)
    }
  }

  const health = !sftpgo.configured
    ? { variant: "outline" as const, label: t("notConfigured") }
    : sftpgo.healthy === true
      ? { variant: "secondary" as const, label: t("health.healthy") }
      : sftpgo.healthy === false
        ? { variant: "destructive" as const, label: t("health.unhealthy") }
        : { variant: "outline" as const, label: t("health.unchecked") }

  const field = (key: keyof Omit<Draft, "pathMappings">, label: string, extra: object = {}) => (
    <div className="space-y-1">
      <Label htmlFor={`sftpgo-${key}`}>{label}</Label>
      <Input
        id={`sftpgo-${key}`}
        value={draft[key]}
        onChange={(event) => edit({ [key]: event.target.value })}
        {...extra}
      />
    </div>
  )

  return (
    <SettingsBlock
      title={t("title")}
      description={t("description")}
      testid="sftpgo-block"
      collapsible
      defaultOpen={sftpgo.configured}
      badge={
        <Badge variant={health.variant} className="text-[10px]">
          {health.label}
        </Badge>
      }
    >
      {sftpgo.error ? (
        <p className="text-xs text-destructive" role="alert">
          {sftpgo.error}
        </p>
      ) : null}
      {pendingProviderOps > 0 ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {tl("settings.pendingProviderOps", { count: pendingProviderOps })}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {field("baseUrl", t("baseUrl"), { placeholder: "http://sftpgo:8080" })}
        <div className="space-y-1">
          <Label htmlFor="sftpgo-apiKey">{t("apiKey")}</Label>
          <Input
            id="sftpgo-apiKey"
            type="password"
            autoComplete="off"
            value={draft.apiKey}
            onChange={(event) => edit({ apiKey: event.target.value })}
          />
          {sftpgo.apiKeySet ? (
            <p className="text-xs text-muted-foreground">{t("apiKeySet")}</p>
          ) : null}
        </div>
        {field("homeBase", t("homeBase"), { placeholder: "/srv/sftpgo/homes" })}
      </div>

      <SettingsField label={t("mappings")} description={t("mappingHint")} stacked>
        <div className="space-y-2">
          {draft.pathMappings.map((mapping, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                aria-label={t("hostPrefix")}
                placeholder={t("hostPrefix")}
                value={mapping.hostPrefix}
                onChange={(event) =>
                  edit({
                    pathMappings: draft.pathMappings.map((row, at) =>
                      at === index ? { ...row, hostPrefix: event.target.value } : row
                    ),
                  })
                }
              />
              <Input
                aria-label={t("sftpgoPrefix")}
                placeholder={t("sftpgoPrefix")}
                value={mapping.sftpgoPrefix}
                onChange={(event) =>
                  edit({
                    pathMappings: draft.pathMappings.map((row, at) =>
                      at === index ? { ...row, sftpgoPrefix: event.target.value } : row
                    ),
                  })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label={t("removeMapping")}
                disabled={draft.pathMappings.length === 1}
                onClick={() =>
                  edit({ pathMappings: draft.pathMappings.filter((_, at) => at !== index) })
                }
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              edit({ pathMappings: [...draft.pathMappings, { hostPrefix: "", sftpgoPrefix: "" }] })
            }
          >
            <PlusIcon className="size-3.5" aria-hidden />
            {t("addMapping")}
          </Button>
        </div>
      </SettingsField>

      <div className="grid gap-3 sm:grid-cols-3">
        {field("publicSftpHost", t("publicSftpHost"), { placeholder: "files.example.com" })}
        {field("publicSftpPort", t("publicSftpPort"), {
          type: "number",
          inputMode: "numeric",
          placeholder: "2022",
        })}
        {field("publicWebdavUrl", t("publicWebdavUrl"), {
          placeholder: "https://files.example.com/dav/",
        })}
      </div>

      <p className="text-xs text-muted-foreground">{t("agpl")}</p>

      <div className="flex items-center justify-end gap-2">
        {sftpgo.config ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => setConfirmRemove(true)}
          >
            {t("remove")}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={!complete || saving}
          onClick={() =>
            void run(
              { ...config, ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}) },
              t("saved")
            )
          }
        >
          {t("save")}
        </Button>
      </div>

      {sftpgo.configured &&
      (sftpgo.endpoints.webdavUrls.length > 0 || sftpgo.endpoints.sftp.length > 0) ? (
        <div className="space-y-1" data-testid="sftpgo-addresses">
          {sftpgo.endpoints.webdavUrls.map((url) => (
            <CopyValue key={url} label={tl("dialog.protocol.webdav")} value={url} />
          ))}
          {sftpgo.endpoints.sftp.map((endpoint) => (
            <CopyValue
              key={`${endpoint.host}:${endpoint.port}`}
              label={tl("dialog.protocol.sftp")}
              value={`${endpoint.host}:${endpoint.port}`}
            />
          ))}
        </div>
      ) : sftpgo.configured && sftpgo.endpoints.unavailableReason ? (
        <p className="text-xs text-muted-foreground">
          {tl(
            `unavailable.${sftpgo.endpoints.unavailableReason === "sftpgo_no_public_endpoint" ? "sftpgo_no_public_endpoint" : "unknown"}`
          )}
        </p>
      ) : null}

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("removeConfirm.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tl("dialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void run(null, t("removed"))}>
              {t("removeConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsBlock>
  )
}
