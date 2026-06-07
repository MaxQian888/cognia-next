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
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Plus, Trash2, Pencil, RotateCcw } from "lucide-react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { LspServerConfig } from "@/types/lsp/config"
import { BUILTIN_LSP_SERVERS, BUILTIN_LSP_SERVER_IDS } from "@/lib/lsp/builtin-defaults"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { LspEditDialog } from "./add-lsp-dialog"

export function LspServersSection() {
  const t = useTranslations("settings.lspServers")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<LspServerConfig | undefined>(undefined)

  const userServers = useMemo<LspServerConfig[]>(
    () => settings?.lsp?.servers ?? [],
    [settings?.lsp?.servers]
  )
  const userById = useMemo(() => new Map(userServers.map((s) => [s.id, s] as const)), [userServers])
  const customServers = useMemo(
    () => userServers.filter((s) => !BUILTIN_LSP_SERVER_IDS.has(s.id)),
    [userServers]
  )

  const writeServers = (next: LspServerConfig[]) => {
    void save({ lsp: { ...settings?.lsp, servers: next } })
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
        <Button onClick={openAdd} aria-label={t("addAriaLabel")}>
          <Plus className="mr-1 h-4 w-4" />
          {t("addButton")}
        </Button>
      </header>

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
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {effective.command}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {effective.languages.join(", ")}
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
                    <div className="font-medium">{entry.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{entry.command}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {entry.languages.join(", ")}
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
