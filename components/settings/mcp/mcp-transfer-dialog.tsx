"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ClipboardPasteIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react"

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
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { loggers } from "@cognia/logging"
import { bulkImportMcpServers, type McpImportStrategy } from "@/lib/db/mcp-servers"
import { parseMcpTransferInput, type McpTransferWarning } from "@/lib/mcp/config-transfer"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import { summarizeServer } from "./mcp-server-utils"

const STRATEGIES: McpImportStrategy[] = ["skip", "overwrite", "duplicate"]

/**
 * Paste-to-add.
 *
 * Every published MCP server documents itself as either a `… mcp add …`
 * command or a `{"mcpServers": …}` block, so the fastest correct path from a
 * README to a working server is a textarea that understands both — not a form
 * the user retypes the same values into. Parsing is live and pure
 * (`parseMcpTransferInput`), so the preview below the box IS the thing that
 * will be written; there is no second interpretation at import time.
 */
export function McpTransferDialog({ onImported }: { onImported?: () => void }) {
  const t = useTranslations("mcp.transfer")
  const open = useMcpPanelStore((s) => s.transferOpen)
  const setOpen = useMcpPanelStore((s) => s.setTransferOpen)
  const [text, setText] = useState("")
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [strategy, setStrategy] = useState<McpImportStrategy>("skip")
  const [busy, setBusy] = useState(false)

  const parsed = useMemo(() => parseMcpTransferInput(text), [text])
  const chosen = parsed.drafts.filter((draft) => !excluded.has(draft.name))

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setText("")
      setExcluded(new Set())
      setStrategy("skip")
    }
  }

  const toggle = (name: string) => {
    setExcluded((prev) => {
      const copy = new Set(prev)
      if (copy.has(name)) copy.delete(name)
      else copy.add(name)
      return copy
    })
  }

  const onConfirm = async () => {
    if (chosen.length === 0) return
    setBusy(true)
    try {
      const result = await bulkImportMcpServers(
        chosen.map((draft) => ({
          name: draft.name,
          transport: draft.transport,
          config: draft.config,
        })),
        strategy,
        "project-import"
      )
      loggers.mcp.info("transfer.imported", {
        kind: parsed.kind,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        errored: result.errored.length,
      })
      const parts: string[] = []
      if (result.created > 0) parts.push(t("created", { count: result.created }))
      if (result.updated > 0) parts.push(t("updated", { count: result.updated }))
      if (result.skipped > 0) parts.push(t("skipped", { count: result.skipped }))
      if (result.errored.length > 0) {
        parts.push(t("errored", { count: result.errored.length }))
        toast.error(result.errored.map((entry) => `${entry.name}: ${entry.error}`).join("\n"))
      }
      toast.success(parts.join(", ") || t("noChanges"))
      onImported?.()
      handleOpenChange(false)
    } catch (err) {
      loggers.mcp.error("transfer.importFailed", err)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardPasteIcon className="size-4" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={t("placeholder")}
            className="font-mono text-xs"
            aria-label={t("title")}
            data-testid="mcp-transfer-input"
          />

          {text.trim().length > 0 && parsed.drafts.length === 0 && (
            <p
              className="flex items-center gap-1.5 text-xs text-destructive"
              data-testid="mcp-transfer-error"
            >
              <TriangleAlertIcon className="size-3.5 shrink-0" />
              {t(`errors.${parsed.error ?? "unrecognized"}`)}
            </p>
          )}

          {parsed.drafts.length > 0 && (
            <>
              <ScrollArea className="max-h-52 rounded-md border">
                <div className="divide-y" data-testid="mcp-transfer-preview">
                  {parsed.drafts.map((draft) => (
                    <label
                      key={draft.name}
                      className="flex cursor-pointer items-center gap-3 p-2.5 transition-colors hover:bg-accent"
                    >
                      <Checkbox
                        checked={!excluded.has(draft.name)}
                        onCheckedChange={() => toggle(draft.name)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium">{draft.name}</span>
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                            {draft.transport}
                          </span>
                        </div>
                        <p className="line-clamp-1 break-all font-mono text-[10px] text-muted-foreground">
                          {summarizeServer(draft)}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </ScrollArea>

              {parsed.warnings.length > 0 && (
                <ul className="space-y-0.5" data-testid="mcp-transfer-warnings">
                  {parsed.warnings.map((warning, index) => (
                    <li key={index} className="text-[11px] text-amber-600 dark:text-amber-400">
                      {describeWarning(warning, t)}
                    </li>
                  ))}
                </ul>
              )}

              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t("onCollision")}
                </Label>
                <RadioGroup
                  value={strategy}
                  onValueChange={(value) => setStrategy(value as McpImportStrategy)}
                  className="grid grid-cols-1 gap-2 sm:grid-cols-3"
                >
                  {STRATEGIES.map((option) => (
                    <label
                      key={option}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-xs transition-colors",
                        strategy === option ? "border-primary/40 bg-accent" : "hover:bg-accent/40"
                      )}
                    >
                      <RadioGroupItem value={option} className="mt-0.5" />
                      <div className="space-y-0.5">
                        <div className="font-medium">{t(`strategy.${option}`)}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {t(`strategy.${option}Desc`)}
                        </div>
                      </div>
                    </label>
                  ))}
                </RadioGroup>
              </div>
            </>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button size="sm" disabled={chosen.length === 0 || busy} onClick={() => void onConfirm()}>
            {busy && <Loader2Icon className="size-3.5 animate-spin" />}
            {t("importN", { count: chosen.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function describeWarning(
  warning: McpTransferWarning,
  t: ReturnType<typeof useTranslations>
): string {
  switch (warning.code) {
    case "guessed-name":
      return t("warnings.guessedName", { name: warning.name })
    case "renamed":
      return t("warnings.renamed", { from: warning.from, to: warning.to })
    case "skipped-entry":
      return t("warnings.skippedEntry", { name: warning.name })
    case "ignored-flag":
      return t("warnings.ignoredFlag", { flag: warning.flag })
  }
}
