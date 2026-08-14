"use client"

/**
 * Picker over the real tool catalog (`lib/tools/tool-catalog.ts`) — builtin,
 * MCP, plugin and native-Anthropic tools, with their risk levels and owners.
 *
 * The catalog ids are the SDK-namespaced form (`mcp__<server>__<tool>`), which
 * is exactly why a free-text field was never an honest way to edit this list:
 * nobody types those from memory. The preset editor still does it that way;
 * this dialog is the alternative.
 *
 * Ids already on the template that the catalog no longer knows about (an MCP
 * server that was removed, a plugin that was uninstalled) are surfaced in
 * their own group rather than quietly dropped on confirm — losing a tool
 * grant because its provider was offline when the dialog opened would be a
 * silent behaviour change.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { motion } from "motion/react"
import { Loader2Icon, SearchIcon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { MOBILE_SPRING } from "@/lib/ui/motion"
import {
  getToolCatalog,
  searchToolCatalog,
  type ToolCatalogEntry,
  type ToolSource,
} from "@/lib/tools/tool-catalog"

// Any source missing here is silently dropped by the grouping below, so this
// must list every `ToolSource` variant.
const SOURCE_ORDER: readonly ToolSource[] = [
  "builtin",
  "sdk-native",
  "native-anthropic",
  "mcp",
  "plugin",
]

export interface ToolCatalogDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Currently granted tool ids. */
  selected: readonly string[]
  onConfirm: (next: string[]) => void
  /** Restrict which catalog sources are offered. */
  sources?: readonly ToolSource[]
}

export function ToolCatalogDialog({
  open,
  onOpenChange,
  selected,
  onConfirm,
  sources,
}: ToolCatalogDialogProps) {
  const t = useTranslations("settings.subagents.toolCatalog")
  const tRisk = useTranslations("toolSettings")
  const { reduce } = useFlowMotion()

  const [entries, setEntries] = useState<ToolCatalogEntry[] | null>(null)
  const [query, setQuery] = useState("")
  const [draft, setDraft] = useState<string[]>([...selected])

  // Load once per opening: the catalog reflects live MCP/plugin state, so a
  // stale snapshot from a previous open would list servers since removed.
  // Resetting the local draft here is the dialog's initialisation, not a
  // render cascade — opening is an edge, and the writes happen once per edge.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setEntries(null)
    setDraft([...selected])
    setQuery("")
    void getToolCatalog().then((list) => {
      if (!cancelled) setEntries(list)
    })
    return () => {
      cancelled = true
    }
    // `selected` is intentionally read at open time only — the draft is local
    // from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  /* eslint-enable react-hooks/set-state-in-effect */

  const filtered = useMemo(() => {
    if (!entries) return []
    return searchToolCatalog(entries, query, sources ? { sources: [...sources] } : {})
  }, [entries, query, sources])

  const grouped = useMemo(() => {
    const map = new Map<ToolSource, ToolCatalogEntry[]>()
    for (const entry of filtered) {
      const bucket = map.get(entry.source)
      if (bucket) bucket.push(entry)
      else map.set(entry.source, [entry])
    }
    return SOURCE_ORDER.filter((s) => map.has(s)).map((s) => ({ source: s, items: map.get(s)! }))
  }, [filtered])

  /** Selected ids the catalog does not know about — kept, not dropped. */
  const orphans = useMemo(() => {
    if (!entries) return []
    const known = new Set(entries.map((e) => e.id))
    return draft.filter((id) => !known.has(id))
  }, [entries, draft])

  const toggle = (id: string) => {
    setDraft((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="tool-catalog-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-8 pl-8 text-xs"
            data-testid="tool-catalog-search"
          />
        </div>

        <div className="max-h-[50vh] min-h-[12rem] space-y-3 overflow-y-auto pr-1">
          {entries === null ? (
            <div
              className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"
              data-testid="tool-catalog-loading"
            >
              <Loader2Icon className="size-4 animate-spin" />
              {t("loading")}
            </div>
          ) : (
            <>
              {orphans.length > 0 ? (
                <Group label={t("groups.unknown")} testId="unknown">
                  {orphans.map((id) => (
                    <Row
                      key={id}
                      id={id}
                      name={id}
                      description={t("unknownHint")}
                      checked
                      onToggle={() => toggle(id)}
                      reduce={reduce}
                    />
                  ))}
                </Group>
              ) : null}

              {grouped.map(({ source, items }) => (
                <Group key={source} label={t(`groups.${source}`)} testId={source}>
                  {items.map((entry) => (
                    <Row
                      key={entry.id}
                      id={entry.id}
                      name={entry.name}
                      description={
                        entry.descriptionKey ? tRisk(entry.descriptionKey) : entry.description
                      }
                      owner={entry.ownerName}
                      risk={entry.riskLevel}
                      riskLabel={
                        entry.riskLevel
                          ? tRisk(
                              entry.riskLevel === "high"
                                ? "riskHigh"
                                : entry.riskLevel === "medium"
                                  ? "riskMedium"
                                  : "riskLow"
                            )
                          : undefined
                      }
                      checked={draft.includes(entry.id)}
                      onToggle={() => toggle(entry.id)}
                      reduce={reduce}
                    />
                  ))}
                </Group>
              ))}

              {grouped.length === 0 && orphans.length === 0 ? (
                <p
                  className="py-10 text-center text-xs text-muted-foreground"
                  data-testid="tool-catalog-empty"
                >
                  {t("empty")}
                </p>
              ) : null}
            </>
          )}
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground" data-testid="tool-catalog-count">
            {t("selectedCount", { count: draft.length })}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                onConfirm(draft)
                onOpenChange(false)
              }}
              data-testid="tool-catalog-confirm"
            >
              {t("confirm")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Group({
  label,
  testId,
  children,
}: {
  label: string
  testId: string
  children: React.ReactNode
}) {
  return (
    <div data-testid={`tool-catalog-group-${testId}`}>
      <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function Row({
  id,
  name,
  description,
  owner,
  risk,
  riskLabel,
  checked,
  onToggle,
  reduce,
}: {
  id: string
  name: string
  description?: string
  owner?: string
  risk?: "low" | "medium" | "high"
  riskLabel?: string
  checked: boolean
  onToggle: () => void
  reduce: boolean
}) {
  return (
    <motion.label
      // Low-density surface — a hover scale reads as responsive here in a way
      // it would not in the nav's tight row list.
      whileHover={reduce ? undefined : { scale: 1.02 }}
      transition={MOBILE_SPRING}
      className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 transition-colors hover:bg-accent/50"
      data-testid={`tool-catalog-row-${id}`}
    >
      <Checkbox checked={checked} onCheckedChange={onToggle} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs">{name}</span>
          {owner ? (
            <Badge variant="secondary" className="text-[9px]">
              {owner}
            </Badge>
          ) : null}
          {riskLabel ? (
            <Badge
              variant="outline"
              className={cn(
                "text-[9px] uppercase",
                risk === "high" && "border-destructive/50 text-destructive"
              )}
            >
              {riskLabel}
            </Badge>
          ) : null}
        </span>
        {description ? (
          <span className="mt-0.5 block line-clamp-2 text-[11px] text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </motion.label>
  )
}
