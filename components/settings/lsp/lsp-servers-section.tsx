"use client"

/**
 * Settings → Language Servers (first-class section).
 *
 * The single surface for the unified LSP config. It edits
 * `AppSettings.lsp.servers` — the user layer the resolver
 * (`lib/lsp/resolve-config.ts`) merges over the builtin defaults and under
 * any project `.cognia/lsp.json`. The same resolved list drives both the
 * agent runtime LSP and the editor LSP, so a server added here works in both.
 *
 * Two groups:
 *   - Builtin defaults (typescript / pyright / rust-analyzer / gopls): shown
 *     read-only with a source badge. Each can be disabled or overridden — an
 *     override is stored as a user entry with the same id, which the resolver
 *     deep-merges over the default.
 *   - Your servers: fully user-authored entries (add / edit / remove).
 *
 * Plugin-contributed LSP servers (`manifest.lspServers`) are NOT shown here —
 * their lifecycle is owned by the plugin manager under Settings → Plugins.
 *
 * Above the two groups sits the runtime block, which owns the rest of the
 * `AppSettings.lsp` slice. Those three fields were declared and read but had no
 * control anywhere in the app: `lsp.enabled` gates the agent runtime in
 * `lib/claude/build-options.ts` (and now the editor plane in
 * `lib/plugin/lsp/lsp-bootstrap.ts`), `lsp.autoInstall` gates the sidecar's
 * npm install ladder, and `lsp.unsignedAllowed` is what the VS Code binary
 * policy consults. Adding servers here while none of the three was reachable
 * meant the section could not actually turn the subsystem on.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Plus, Trash2, Pencil, RotateCcw, Download, ScrollText } from "lucide-react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { LspServerConfig, LspSettings } from "@/types/lsp/config"
import { BUILTIN_LSP_SERVERS, BUILTIN_LSP_SERVER_IDS } from "@/lib/lsp/builtin-defaults"
import { useLspStatusStore } from "@/lib/lsp/lsp-status-store"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { LspDevToggle } from "../developer/lsp-dev-toggle"
import { LspEditDialog } from "./lsp-edit-dialog"
import { LspEffectivePreview } from "./lsp-effective-preview"
import { LspServerStatusBadge } from "./lsp-server-status-badge"
import { LspLogsDialog } from "./lsp-logs-dialog"

export function LspServersSection() {
  const t = useTranslations("settings.lspServers")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<LspServerConfig | undefined>(undefined)
  const [logsOpen, setLogsOpen] = useState(false)

  const statuses = useLspStatusStore((s) => s.statuses)
  const installProgress = useLspStatusStore((s) => s.installProgress)
  const refreshStatus = useLspStatusStore((s) => s.refresh)
  const installServer = useLspStatusStore((s) => s.install)

  // Detect binaries + runtime health once the section mounts (inert on web).
  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const userServers = useMemo<LspServerConfig[]>(
    () => settings?.lsp?.servers ?? [],
    [settings?.lsp?.servers]
  )
  const userById = useMemo(() => new Map(userServers.map((s) => [s.id, s] as const)), [userServers])
  const customServers = useMemo(
    () => userServers.filter((s) => !BUILTIN_LSP_SERVER_IDS.has(s.id)),
    [userServers]
  )

  // `enabled` is tri-state on disk: `undefined` means "legacy default", which
  // differs per plane (the agent falls back to the `builtinTools.lsp` category,
  // the editor stays on). The switch shows the agent-side resolution because
  // that is the one a user can otherwise only reach through Settings → Tools.
  const masterEnabled = settings?.lsp?.enabled ?? settings?.builtinTools?.lsp ?? false
  const autoInstall = settings?.lsp?.autoInstall !== false

  const writeLsp = (patch: Partial<LspSettings>) => {
    void save({ lsp: { ...settings?.lsp, servers: settings?.lsp?.servers ?? [], ...patch } })
  }

  const writeServers = (next: LspServerConfig[]) => {
    writeLsp({ servers: next })
  }

  const upsertServer = (entry: LspServerConfig) => {
    const exists = userById.has(entry.id)
    writeServers(
      exists ? userServers.map((s) => (s.id === entry.id ? entry : s)) : [...userServers, entry]
    )
  }

  const removeServer = (id: string) => {
    writeServers(userServers.filter((s) => s.id !== id))
  }

  const toggleEnabled = (entry: LspServerConfig, nextEnabled: boolean) => {
    upsertServer({ ...entry, enabled: nextEnabled })
  }

  const openAdd = () => {
    setEditing(undefined)
    setDialogOpen(true)
  }
  const openEdit = (entry: LspServerConfig) => {
    setEditing(entry)
    setDialogOpen(true)
  }

  const handleSubmit = (entry: LspServerConfig) => {
    upsertServer(entry)
    setDialogOpen(false)
  }

  return (
    <section className="space-y-6" data-testid="lsp-servers-section">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setLogsOpen(true)}
            aria-label={t("logs.openAriaLabel")}
          >
            <ScrollText className="mr-1 h-4 w-4" />
            {t("logs.button")}
          </Button>
          <Button onClick={openAdd} aria-label={t("addAriaLabel")}>
            <Plus className="mr-1 h-4 w-4" />
            {t("addButton")}
          </Button>
        </div>
      </header>

      {/* Runtime — the rest of the `AppSettings.lsp` slice */}
      <div className="space-y-3" data-testid="lsp-runtime-block">
        <h3 className="text-sm font-medium">{t("runtime.title")}</h3>
        <div className="divide-y divide-border/60 rounded-md border">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4">
            <div className="min-w-0 flex-1 basis-64 space-y-1">
              <Label htmlFor="lsp-master-enabled" className="font-medium">
                {t("runtime.enabledLabel")}
              </Label>
              <p className="text-xs text-pretty text-muted-foreground">
                {t("runtime.enabledDescription")}
              </p>
            </div>
            <Switch
              id="lsp-master-enabled"
              checked={masterEnabled}
              onCheckedChange={(next) => writeLsp({ enabled: next })}
              aria-label={t("runtime.enabledLabel")}
              data-testid="lsp-master-enabled"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4">
            <div className="min-w-0 flex-1 basis-64 space-y-1">
              <Label htmlFor="lsp-auto-install" className="font-medium">
                {t("runtime.autoInstallLabel")}
              </Label>
              <p className="text-xs text-pretty text-muted-foreground">
                {t("runtime.autoInstallDescription")}
              </p>
            </div>
            <Switch
              id="lsp-auto-install"
              checked={autoInstall}
              onCheckedChange={(next) => writeLsp({ autoInstall: next })}
              aria-label={t("runtime.autoInstallLabel")}
              data-testid="lsp-auto-install"
            />
          </div>
        </div>
        <LspDevToggle />
      </div>

      {/* Builtin defaults */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("builtinGroup")}</h3>
        <p className="text-xs text-muted-foreground">{t("builtinHint")}</p>
        <Table aria-label={t("builtinGroup")}>
          <TableBody>
            {BUILTIN_LSP_SERVERS.map((builtin) => {
              const override = userById.get(builtin.id)
              const effective = override ?? builtin
              const overridden = !!override
              return (
                <TableRow key={builtin.id} data-testid={`lsp-builtin-${builtin.id}`}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{effective.name}</span>
                      <Badge variant="secondary" className="text-[10px]">
                        {overridden ? t("badge.overridden") : t("badge.builtin")}
                      </Badge>
                      <LspServerStatusBadge
                        status={statuses[builtin.id]}
                        progress={installProgress[builtin.id]}
                      />
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {effective.command}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {(effective.languages ?? []).join(", ")}
                  </TableCell>
                  <TableCell className="text-right">
                    <Switch
                      checked={effective.enabled !== false}
                      onCheckedChange={(v) => toggleEnabled(effective, v)}
                      aria-label={t("enabledAriaLabel", { name: effective.name })}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {statuses[builtin.id]?.install === "missing" &&
                      statuses[builtin.id]?.npmPackage ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void installServer(builtin.id)}
                          disabled={
                            installProgress[builtin.id]?.phase === "resolving" ||
                            installProgress[builtin.id]?.phase === "installing"
                          }
                          aria-label={t("install.ariaLabel", { name: builtin.name })}
                          data-testid={`lsp-install-${builtin.id}`}
                        >
                          <Download className="mr-1 h-4 w-4" />
                          {t("install.button")}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(effective)}
                        aria-label={t("overrideAriaLabel", { name: builtin.name })}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {overridden ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeServer(builtin.id)}
                          aria-label={t("resetAriaLabel", { name: builtin.name })}
                        >
                          <RotateCcw className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {/* User servers */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("customGroup")}</h3>
        {customServers.length === 0 ? (
          <div className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            {t("empty")}
          </div>
        ) : (
          <Table aria-label={t("tableAriaLabel")}>
            <TableHeader className="text-xs uppercase text-muted-foreground">
              <TableRow>
                <TableHead>{t("col.name")}</TableHead>
                <TableHead>{t("col.languages")}</TableHead>
                <TableHead className="text-right">{t("col.enabled")}</TableHead>
                <TableHead className="text-right">{t("col.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customServers.map((entry) => (
                <TableRow key={entry.id} data-testid={`lsp-row-${entry.id}`}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{entry.name}</span>
                      <LspServerStatusBadge
                        status={statuses[entry.id]}
                        progress={installProgress[entry.id]}
                      />
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">{entry.command}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {(entry.languages ?? []).join(", ")}
                  </TableCell>
                  <TableCell className="text-right">
                    <Switch
                      checked={entry.enabled !== false}
                      onCheckedChange={(v) => toggleEnabled(entry, v)}
                      aria-label={t("enabledAriaLabel", { name: entry.name })}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(entry)}
                        aria-label={t("editAriaLabel", { name: entry.name })}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeServer(entry.id)}
                        aria-label={t("removeAriaLabel", { name: entry.name })}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <LspEffectivePreview userServers={userServers} />

      <LspLogsDialog open={logsOpen} onOpenChange={setLogsOpen} />

      <LspEditDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editing}
        existingIds={userServers.map((s) => s.id)}
        onSubmit={handleSubmit}
      />
    </section>
  )
}
