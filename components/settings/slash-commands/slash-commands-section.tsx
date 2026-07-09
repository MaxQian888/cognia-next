"use client"

/**
 * SlashCommandsSection — settings panel for the unified slash-command
 * surface. Three groups visible at once:
 *   - Built-in: from BUILTIN_SLASH_COMMANDS (read-only descriptors)
 *   - Custom: scanned `.claude/commands/*.md` — Edit / Delete / + New now
 *     write through `lib/slash-commands/custom` (Phase 7c, Stage 3 of
 *     the ClaudeCode 完整化 plan).
 *   - Plugin: registered through the unified registry by plugin manifests.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { TerminalSquareIcon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react"
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
import { BUILTIN_SLASH_COMMANDS } from "@/lib/slash-commands/builtin"
import type { SlashCommand } from "@/lib/slash-commands/builtin"
import { deleteCustomSlashCommand, loadCustomSlashCommands } from "@/lib/slash-commands/custom"
import { listSlashCommands } from "@/lib/slash-commands/registry"
import type { SlashCommandDefinition } from "@/lib/slash-commands/registry"
import { isTauri } from "@/lib/tauri"
import { toast } from "@/components/ui/sonner"
import { createLogger } from "@/lib/logging"
import { CommandEditorDialog } from "./command-editor-dialog"
import { useChatStore } from "@/stores/chat"
import { getSession } from "@/lib/db/sessions"
import { resolveEffectiveCwdForSession } from "@/hooks/chat/use-effective-cwd"
import {
  CLAUDE_CODE_RELATED,
  RelatedSectionsStrip,
} from "@/components/settings/common/related-sections-strip"

const log = createLogger("settings.slash-commands")

export function SlashCommandsSection() {
  const t = useTranslations("settings.slashCommands")
  const desktop = isTauri()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const [custom, setCustom] = useState<SlashCommand[]>([])
  const [filter, setFilter] = useState("")
  const [loading, setLoading] = useState(false)
  const [reloadCounter, setReloadCounter] = useState(0)

  // Resolve the active session's working dir so project-scope commands write
  // to the right `.claude/commands/`. Falls back to `null` (= disabled).
  const [cwd, setCwd] = useState<string | null>(null)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editorInitial, setEditorInitial] = useState<SlashCommand | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SlashCommand | null>(null)
  const [busy, setBusy] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    let cancelled = false
    async function go() {
      setLoading(true)
      try {
        const cmds = await loadCustomSlashCommands(cwd)
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
  }, [cwd, reloadCounter])

  // Track the active session's working dir so the editor can target its
  // `.claude/commands/`. This effect re-runs when the user switches sessions.
  useEffect(() => {
    let cancelled = false
    if (!activeSessionId) {
      setCwd(null)
      return
    }
    void (async () => {
      try {
        const session = await getSession(activeSessionId)
        // Effective chain (session → active workspace → character → default),
        // matching the send path — a selected workspace enables project-scope
        // commands even when the session has no per-session dir.
        const resolved = await resolveEffectiveCwdForSession(session)
        if (!cancelled) setCwd(resolved)
      } catch {
        if (!cancelled) setCwd(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeSessionId])
  /* eslint-enable react-hooks/set-state-in-effect */

  const triggerReload = () => setReloadCounter((n) => n + 1)

  const onEdit = (c: SlashCommand) => {
    setEditorInitial(c)
    setEditorOpen(true)
  }

  const onCreate = () => {
    setEditorInitial(null)
    setEditorOpen(true)
  }

  const onDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await deleteCustomSlashCommand({
        scope: deleteTarget.scope === "project" ? "project" : "user",
        name: deleteTarget.name,
        cwd,
      })
      toast.success(t("deletedToast", { name: deleteTarget.name }))
      setDeleteTarget(null)
      triggerReload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pluginCmds = useMemo<SlashCommandDefinition[]>(
    () => listSlashCommands().filter((c) => c.source === "plugin"),
    // listSlashCommands reads a module-scoped registry; recompute once per
    // mount — there are no producer side-effects to subscribe to here.
    []
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

      <RelatedSectionsStrip current="slash-commands" targets={CLAUDE_CODE_RELATED} />

      <div className="flex items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("filterPlaceholder")}
          className="text-sm"
          data-testid="slash-commands-filter"
        />
        <Button
          size="sm"
          onClick={onCreate}
          disabled={!desktop}
          aria-label={t("newBtn")}
          data-testid="slash-commands-new"
        >
          <PlusIcon className="mr-1 size-3.5" />
          {t("newBtn")}
        </Button>
      </div>
      {!desktop && (
        <p
          className="rounded border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
          role="status"
          data-testid="slash-commands-web-banner"
        >
          {t("webModeBanner")}
        </p>
      )}

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
                  {desktop ? t("emptyCustom") : t("emptyCustomWeb")}
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
                    onEdit={desktop ? () => onEdit(c) : undefined}
                    editLabel={t("edit")}
                    onDelete={desktop ? () => setDeleteTarget(c) : undefined}
                    deleteLabel={t("delete")}
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

      <CommandEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        initial={editorInitial}
        cwd={cwd}
        onSaved={() => {
          setEditorOpen(false)
          triggerReload()
        }}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteDialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDialogDesc", { name: deleteTarget?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void onDelete()}
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="slash-commands-delete-confirm"
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  onEdit?: () => void
  editLabel?: string
  onDelete?: () => void
  deleteLabel?: string
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
  onEdit,
  editLabel,
  onDelete,
  deleteLabel,
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
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onTry}
            data-testid={`try-${name}`}
            title={tryLabel}
            aria-label={tryLabel}
          >
            <PlayIcon className="size-3.5" />
          </Button>
          {onEdit && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onEdit}
              data-testid={`edit-${name}`}
              title={editLabel}
              aria-label={editLabel}
            >
              <PencilIcon className="size-3.5" />
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-destructive hover:text-destructive"
              onClick={onDelete}
              data-testid={`delete-${name}`}
              title={deleteLabel}
              aria-label={deleteLabel}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          )}
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
