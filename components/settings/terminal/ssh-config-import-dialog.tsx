"use client"

/**
 * Preview and approve an import of `~/.ssh/config`.
 *
 * The preview is the point of this dialog. An OpenSSH config says more than a
 * host list can hold, so importing one without showing what survived would
 * leave the user believing an alias came across faithfully when its
 * `ProxyCommand` — or its whole `Match` block — was dropped. Every entry is
 * listed with what will happen to it, every narrowing is labelled on the entry
 * it applies to, and everything skipped is named with its line number.
 *
 * Nothing is written until the user confirms. Resolution is per entry, so one
 * conflict cannot force an all-or-nothing choice over the rest of the file.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  applySshConfigImport,
  parseSshConfig,
  planSshConfigImport,
  readSshConfigFile,
  type SshImportPlan,
  type SshImportResolution,
  type SshImportResult,
} from "@/lib/terminal/ssh-config-import"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"

export interface SshConfigImportDialogProps {
  hosts: readonly SshHostProfile[]
  onImport: (result: SshImportResult) => Promise<void> | void
  /** Injected in tests; defaults to reading the real `~/.ssh/config`. */
  read?: typeof readSshConfigFile
}

type Stage =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "absent"; path: string | null }
  | { kind: "failed"; message: string }
  | { kind: "ready"; path: string; plan: SshImportPlan }

const RESOLUTIONS: readonly SshImportResolution[] = ["create", "overwrite", "skip"]

export function SshConfigImportDialog({
  hosts,
  onImport,
  read = readSshConfigFile,
}: SshConfigImportDialogProps) {
  const t = useTranslations("settings.terminal.ssh.configImport")
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<Stage>({ kind: "idle" })
  const [resolutions, setResolutions] = useState<Record<string, SshImportResolution>>({})
  const [applying, setApplying] = useState(false)

  const load = useCallback(async () => {
    setStage({ kind: "loading" })
    setResolutions({})
    try {
      const source = await read()
      if (source.kind === "absent") {
        setStage({ kind: "absent", path: source.path })
        return
      }
      setStage({
        kind: "ready",
        path: source.path,
        plan: planSshConfigImport(parseSshConfig(source.text), hosts),
      })
    } catch (error) {
      setStage({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }, [hosts, read])

  const openDialog = useCallback(() => {
    setOpen(true)
    void load()
  }, [load])

  const confirm = useCallback(async () => {
    if (stage.kind !== "ready") return
    setApplying(true)
    try {
      await onImport(applySshConfigImport(hosts, stage.plan, resolutions))
      setOpen(false)
      setStage({ kind: "idle" })
    } catch (error) {
      setStage({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setApplying(false)
    }
  }, [hosts, onImport, resolutions, stage])

  const entries = stage.kind === "ready" ? stage.plan.entries : []
  const notices = stage.kind === "ready" ? stage.plan.notices : []
  const importing = entries.filter(
    (entry) => (resolutions[entry.key] ?? entry.defaultResolution) !== "skip"
  ).length

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={openDialog}
        data-testid="ssh-config-import-open"
      >
        <DownloadIcon className="mr-1 h-3.5 w-3.5" />
        {t("open")}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl" data-testid="ssh-config-import-dialog">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>
              {stage.kind === "ready" ? stage.path : t("description")}
            </DialogDescription>
          </DialogHeader>

          {stage.kind === "loading" ? (
            <p className="text-xs text-muted-foreground" data-testid="ssh-config-import-loading">
              {t("loading")}
            </p>
          ) : null}

          {stage.kind === "absent" ? (
            /*
              Two different answers, and they were rendered as one.

              `path === null` means `readSshConfigFile` could not resolve a home
              directory at all — the shell has no local filesystem to look in,
              which is every non-Tauri shell. Telling that reader "no config
              found at ~/.ssh/config" invites them to go create a file that this
              build would still never read. A real path means we looked there
              and it genuinely is not there, which is the ordinary fresh-machine
              case and needs no apology.
            */
            <p className="text-xs text-muted-foreground" data-testid="ssh-config-import-absent">
              {stage.path === null ? t("unreadableHere") : t("absent", { path: stage.path })}
            </p>
          ) : null}

          {stage.kind === "failed" ? (
            <p className="text-xs text-red-500" data-testid="ssh-config-import-error">
              {stage.message}
            </p>
          ) : null}

          {stage.kind === "ready" ? (
            <ScrollArea className="max-h-[50vh]">
              <div className="space-y-3 pr-3">
                {entries.length === 0 ? (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="ssh-config-import-empty"
                  >
                    {t("noHosts")}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {entries.map((entry) => {
                      const resolution = resolutions[entry.key] ?? entry.defaultResolution
                      return (
                        <li
                          key={entry.key}
                          className="space-y-1 rounded border p-2"
                          data-testid={`ssh-config-import-entry-${entry.key}`}
                          data-resolution={resolution}
                        >
                          <div className="flex items-center gap-2">
                            <span className="truncate text-xs font-medium">{entry.name}</span>
                            {entry.existingId ? (
                              <Badge variant="secondary" className="text-[10px]">
                                {t("badges.exists")}
                              </Badge>
                            ) : null}
                            {entry.synthesized ? (
                              <Badge variant="outline" className="text-[10px]">
                                {t("badges.synthesized")}
                              </Badge>
                            ) : null}
                            <Select
                              value={resolution}
                              onValueChange={(value) =>
                                setResolutions((current) => ({
                                  ...current,
                                  [entry.key]: value as SshImportResolution,
                                }))
                              }
                            >
                              <SelectTrigger
                                className="ml-auto h-7 w-32 text-[11px]"
                                aria-label={t("resolution.label", { name: entry.name })}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {RESOLUTIONS.filter(
                                  // Replacing nothing is not a choice; the
                                  // option only exists where a profile matched.
                                  (option) => option !== "overwrite" || entry.existingId
                                ).map((option) => (
                                  <SelectItem key={option} value={option}>
                                    {t(`resolution.${option}`)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <p className="font-mono text-[10px] text-muted-foreground">
                            {entry.username ? `${entry.username}@` : ""}
                            {entry.host}:{entry.port}
                            {entry.jumpKey ? ` · ${t("via")}` : ""}
                          </p>
                          {entry.adjustments.map((adjustment) => (
                            <p
                              key={adjustment}
                              className="text-[10px] text-amber-600 dark:text-amber-500"
                              data-testid={`ssh-config-import-adjustment-${adjustment}`}
                            >
                              {t(`adjustments.${adjustment}`)}
                            </p>
                          ))}
                        </li>
                      )
                    })}
                  </ul>
                )}

                {notices.length > 0 ? (
                  <div className="space-y-1" data-testid="ssh-config-import-notices">
                    <p className="text-[11px] font-medium">{t("notices.title")}</p>
                    <ul className="space-y-0.5">
                      {notices.map((notice, index) => (
                        <li
                          key={`${notice.kind}-${notice.line}-${index}`}
                          className="text-[10px] text-muted-foreground"
                        >
                          {t("notices.line", { line: notice.line })} ·{" "}
                          {t(`notices.${notice.kind}`, { subject: notice.subject })}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              data-testid="ssh-config-import-cancel"
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={stage.kind !== "ready" || importing === 0 || applying}
              onClick={() => void confirm()}
              data-testid="ssh-config-import-confirm"
            >
              {applying ? t("importing") : t("confirm", { count: importing })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default SshConfigImportDialog
