"use client"

/**
 * Settings → Language Servers panel (Phase B of the LSP reuse work).
 *
 * Lists every user-managed `UserLspServerEntry`, lets the user add /
 * edit / remove entries, and persists changes through the settings
 * store. The `syncUserLspServers` bootstrap reads the same list and
 * re-syncs with the LSP registry whenever it changes.
 *
 * Plugin-contributed LSP servers (the `manifest.lspServers` path) are
 * NOT shown here — they live under Settings → Plugins where the
 * lifecycle is owned by the plugin manager.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Plus, Trash2 } from "lucide-react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { UserLspServerEntry } from "@/lib/claude/types"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { AddLspDialog } from "./add-lsp-dialog"

function generateEntryId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `lsp_${(crypto as Crypto).randomUUID().slice(0, 8)}`
  }
  return `lsp_${Math.random().toString(36).slice(2, 10)}`
}

export function LspServersSection() {
  const t = useTranslations("settings.lspServers")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const [addOpen, setAddOpen] = useState(false)

  const entries = useMemo<UserLspServerEntry[]>(
    () => settings?.developer?.userLspServers ?? [],
    [settings?.developer?.userLspServers]
  )

  const updateEntries = (next: UserLspServerEntry[]) => {
    void save({
      developer: {
        ...settings?.developer,
        userLspServers: next,
      },
    })
  }

  const onAdd = (entry: Omit<UserLspServerEntry, "id">) => {
    const next: UserLspServerEntry[] = [
      ...entries,
      { ...entry, id: generateEntryId(), enabled: true },
    ]
    updateEntries(next)
    setAddOpen(false)
  }

  const onToggle = (id: string, nextEnabled: boolean) => {
    updateEntries(entries.map((e) => (e.id === id ? { ...e, enabled: nextEnabled } : e)))
  }

  const onRemove = (id: string) => {
    updateEntries(entries.filter((e) => e.id !== id))
  }

  return (
    <section className="space-y-4" data-testid="lsp-servers-section">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <Button onClick={() => setAddOpen(true)} aria-label={t("addAriaLabel")}>
          <Plus className="mr-1 h-4 w-4" />
          {t("addButton")}
        </Button>
      </header>

      {entries.length === 0 ? (
        <div className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <table className="w-full text-sm" aria-label={t("tableAriaLabel")}>
          <thead className="border-b text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-2 py-2">{t("col.name")}</th>
              <th className="px-2 py-2">{t("col.languages")}</th>
              <th className="px-2 py-2">{t("col.command")}</th>
              <th className="px-2 py-2 text-right">{t("col.enabled")}</th>
              <th className="px-2 py-2 text-right">{t("col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.id}
                className="border-b last:border-b-0 hover:bg-muted/40"
                data-testid={`lsp-row-${entry.id}`}
              >
                <td className="px-2 py-2 font-medium">{entry.name}</td>
                <td className="px-2 py-2 text-muted-foreground">{entry.languages.join(", ")}</td>
                <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
                  {entry.command}
                </td>
                <td className="px-2 py-2 text-right">
                  <Switch
                    checked={entry.enabled !== false}
                    onCheckedChange={(v) => onToggle(entry.id, v)}
                    aria-label={t("enabledAriaLabel", { name: entry.name })}
                  />
                </td>
                <td className="px-2 py-2 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRemove(entry.id)}
                    aria-label={t("removeAriaLabel", { name: entry.name })}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <AddLspDialog open={addOpen} onOpenChange={setAddOpen} onAdd={onAdd} />
    </section>
  )
}
