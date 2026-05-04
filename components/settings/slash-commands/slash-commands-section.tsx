"use client"

/**
 * SlashCommandsSection — settings panel for the unified slash-command
 * surface. Three groups visible at once:
 *   - Built-in: from BUILTIN_SLASH_COMMANDS (read-only descriptors)
 *   - Custom: scanned `.claude/commands/*.md` (read-only here; "Open file"
 *     opens the source in the system editor via Tauri shell).
 *   - Plugin: registered through the unified registry by plugin manifests.
 *
 * Phase 7a of the ClaudeCode 完整化 plan. Editing custom command markdown
 * is intentionally out of scope for v1 — Phase 7c will add it once the
 * Tauri write surface is settled.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { TerminalSquareIcon, FileEditIcon, PlayIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { BUILTIN_SLASH_COMMANDS } from "@/lib/slash-commands/builtin"
import type { SlashCommand } from "@/lib/slash-commands/builtin"
import { loadCustomSlashCommands } from "@/lib/slash-commands/custom"
import { listSlashCommands } from "@/lib/slash-commands/registry"
import type { SlashCommandDefinition } from "@/lib/slash-commands/registry"
import { isTauri } from "@/lib/tauri"
import { toast } from "@/components/ui/sonner"
import { createLogger } from "@/lib/logger"

const log = createLogger("settings.slash-commands")

export function SlashCommandsSection() {
  const t = useTranslations("settings.slashCommands")
  const [custom, setCustom] = useState<SlashCommand[]>([])
  const [filter, setFilter] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function go() {
      setLoading(true)
      try {
        const cmds = await loadCustomSlashCommands(null)
        if (!cancelled) setCustom(cmds)
      } catch (e) {
        log.error("custom_scan_failed", { error: String(e) })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void go()
    return () => {
      cancelled = true
    }
  }, [])

  const pluginCmds = useMemo<SlashCommandDefinition[]>(
    () => listSlashCommands().filter((c) => c.source === "plugin"),
    // listSlashCommands reads a module-scoped registry; only re-evaluate on
    // component mount or filter changes (no producer side-effects to subscribe
    // to in this surface).
    [filter]
  )

  const filteredBuiltin = useMemo(
    () => filterCommandsByName(BUILTIN_SLASH_COMMANDS, filter),
    [filter]
  )
  const filteredCustom = useMemo(() => filterCommandsByName(custom, filter), [custom, filter])
  const filteredPlugin = useMemo(
    () =>
      pluginCmds.filter(
        (c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase().replace(/^\//, ""))
      ),
    [pluginCmds, filter]
  )

  const tryInComposer = async (name: string) => {
    const text = `/${name} `
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text)
        toast.success(t("copiedToClipboard", { name }))
        return
      }
    } catch (e) {
      log.warn("clipboard_write_failed", { error: String(e) })
    }
    toast.message(t("typeIntoComposer", { name }))
  }

  return (
    <div className="space-y-4" data-testid="slash-commands-section">
      <div className="space-y-1">
        <h2 className="text-base font-semibold flex items-center gap-2">
          <TerminalSquareIcon className="size-4" />
          {t("title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t("filterPlaceholder")}
        className="text-sm"
        data-testid="slash-commands-filter"
      />

      <Accordion type="multiple" defaultValue={["builtin", "custom", "plugin"]}>
        <AccordionItem value="builtin">
          <AccordionTrigger className="text-sm" data-testid="group-builtin">
            {t("builtin", { count: filteredBuiltin.length })}
          </AccordionTrigger>
          <AccordionContent>
            <div className="space-y-2" data-testid="builtin-list">
              {filteredBuiltin.map((c) => (
                <CommandRow
                  key={c.name}
                  name={c.name}
                  description={c.description}
                  argumentHint={c.argumentHint}
                  scopeLabel={t("scope.builtin")}
                  scopeVariant="secondary"
                  onTry={() => tryInComposer(c.name)}
                  tryLabel={t("try")}
                />
              ))}
              {filteredBuiltin.length === 0 ? (
                <p className="px-2 text-xs italic text-muted-foreground">{t("emptyBuiltin")}</p>
              ) : null}
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="custom">
          <AccordionTrigger className="text-sm" data-testid="group-custom">
            {t("custom", { count: filteredCustom.length })}
          </AccordionTrigger>
          <AccordionContent>
            <div className="space-y-2" data-testid="custom-list">
              {loading ? (
                <p className="px-2 text-xs text-muted-foreground">{t("scanning")}</p>
              ) : filteredCustom.length === 0 ? (
                <p className="px-2 text-xs italic text-muted-foreground">
                  {isTauri() ? t("emptyCustom") : t("emptyCustomWeb")}
                </p>
              ) : (
                filteredCustom.map((c) => (
                  <CommandRow
                    key={c.name}
                    name={c.name}
                    description={c.description}
                    argumentHint={c.argumentHint}
                    scopeLabel={c.scope === "project" ? t("scope.project") : t("scope.user")}
                    scopeVariant="outline"
                    filePath={c.filePath}
                    onTry={() => tryInComposer(c.name)}
                    tryLabel={t("try")}
                  />
                ))
              )}
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="plugin">
          <AccordionTrigger className="text-sm" data-testid="group-plugin">
            {t("plugin", { count: filteredPlugin.length })}
          </AccordionTrigger>
          <AccordionContent>
            <div className="space-y-2" data-testid="plugin-list">
              {filteredPlugin.length === 0 ? (
                <p className="px-2 text-xs italic text-muted-foreground">{t("emptyPlugin")}</p>
              ) : (
                filteredPlugin.map((c) => (
                  <CommandRow
                    key={c.id}
                    name={c.name}
                    description={c.description}
                    argumentHint={c.shortcut ?? undefined}
                    scopeLabel={
                      c.pluginId
                        ? t("scope.plugin", { id: c.pluginId })
                        : t("scope.plugin", { id: "?" })
                    }
                    scopeVariant="outline"
                    onTry={() => tryInComposer(c.name)}
                    tryLabel={t("try")}
                  />
                ))
              )}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )
}

interface RowProps {
  name: string
  description?: string
  argumentHint?: string
  scopeLabel: string
  scopeVariant: "secondary" | "outline"
  filePath?: string
  onTry: () => void
  tryLabel: string
}

function CommandRow({
  name,
  description,
  argumentHint,
  scopeLabel,
  scopeVariant,
  filePath,
  onTry,
  tryLabel,
}: RowProps) {
  return (
    <Card className="p-3" data-testid={`slash-command-row-${name}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">/{name}</code>
            <Badge variant={scopeVariant} className="text-[10px]">
              {scopeLabel}
            </Badge>
            {argumentHint ? (
              <code className="text-[10px] text-muted-foreground">{argumentHint}</code>
            ) : null}
          </div>
          {description ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{description}</p>
          ) : null}
          {filePath ? (
            <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{filePath}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {filePath ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              data-testid={`open-file-${name}`}
              title={filePath}
              disabled
            >
              <FileEditIcon className="size-3.5" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onTry}
            data-testid={`try-${name}`}
            title={tryLabel}
          >
            <PlayIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  )
}

function filterCommandsByName(list: SlashCommand[], filter: string): SlashCommand[] {
  if (!filter.trim()) return list
  const q = filter.toLowerCase().replace(/^\//, "")
  return list.filter(
    (c) => c.name.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q)
  )
}

export default SlashCommandsSection
