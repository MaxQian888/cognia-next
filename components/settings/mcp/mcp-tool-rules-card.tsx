"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CircleSlashIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { loggers } from "@cognia/logging"
import { updateMcpServer } from "@/lib/db/mcp-servers"
import { useMcpServerTools } from "@/hooks/mcp/use-mcp-server-tools"
import {
  isToolPattern,
  matchesToolPattern,
  matchingToolPatterns,
  normalizeToolRuleList,
} from "@/lib/mcp/tool-rules"
import type { McpServer } from "@cognia/agent-config-types"

interface Props {
  server: McpServer
}

/**
 * Per-tool governance for one server.
 *
 * Two rules coexist and the UI has to keep them distinguishable, because they
 * behave differently: a switch pins ONE tool by name, a pattern keeps covering
 * tools the server grows later. A tool denied by a pattern therefore shows a
 * disabled switch and names the pattern — offering a switch that silently
 * loses to a rule would be a lie.
 *
 * Nothing here can be answered without knowing which tools exist, so an
 * un-probed server leads with discovery rather than an empty list.
 */
export function McpToolRulesCard({ server }: Props) {
  const t = useTranslations("mcp.tools")
  const { tools, discoveredAt, discovering, error, discover, canDiscover, loading } =
    useMcpServerTools(server)
  const [query, setQuery] = useState("")
  const [patternDraft, setPatternDraft] = useState("")
  const [saving, setSaving] = useState(false)

  const explicit = useMemo(
    () => normalizeToolRuleList(server.disallowedTools),
    [server.disallowedTools]
  )
  const patterns = useMemo(
    () => normalizeToolRuleList(server.disallowedToolPatterns),
    [server.disallowedToolPatterns]
  )
  const rules = useMemo(
    () => ({ disallowedTools: explicit, disallowedToolPatterns: patterns }),
    [explicit, patterns]
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tools
    return tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(q) || (tool.description ?? "").toLowerCase().includes(q)
    )
  }, [tools, query])

  // Deny rules pinned against tools this server no longer reports. They keep
  // working (the name is still sent to the SDK), so they must stay visible and
  // removable instead of vanishing with the tool.
  const orphanRules = useMemo(() => {
    const known = new Set(tools.map((tool) => tool.name))
    return explicit.filter((name) => !known.has(name))
  }, [explicit, tools])

  const deniedCount = useMemo(
    () =>
      tools.filter(
        (tool) => explicit.includes(tool.name) || matchingToolPatterns(tool.name, rules).length > 0
      ).length,
    [tools, explicit, rules]
  )

  const persist = async (patch: {
    disallowedTools?: string[]
    disallowedToolPatterns?: string[]
  }) => {
    setSaving(true)
    try {
      await updateMcpServer(server.id, patch)
      loggers.mcp.info("settings.toolRulesUpdated", {
        id: server.id,
        explicit: patch.disallowedTools?.length,
        patterns: patch.disallowedToolPatterns?.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.mcp.error("settings.toolRulesUpdateFailed", err, { id: server.id })
    } finally {
      setSaving(false)
    }
  }

  const setToolAllowed = (name: string, allowed: boolean) => {
    const next = allowed ? explicit.filter((tool) => tool !== name) : [...explicit, name]
    void persist({ disallowedTools: normalizeToolRuleList(next) })
  }

  const denyAllFiltered = () => {
    const names = filtered
      .filter((tool) => matchingToolPatterns(tool.name, rules).length === 0)
      .map((tool) => tool.name)
    void persist({ disallowedTools: normalizeToolRuleList([...explicit, ...names]) })
  }

  const allowAllFiltered = () => {
    const names = new Set(filtered.map((tool) => tool.name))
    void persist({ disallowedTools: explicit.filter((tool) => !names.has(tool)) })
  }

  const addPattern = (raw: string) => {
    const pattern = raw.trim()
    if (!pattern) return
    setPatternDraft("")
    if (patterns.includes(pattern)) return
    void persist({ disallowedToolPatterns: normalizeToolRuleList([...patterns, pattern]) })
  }

  const removePattern = (pattern: string) => {
    void persist({ disallowedToolPatterns: patterns.filter((entry) => entry !== pattern) })
  }

  const busy = saving || discovering

  return (
    <Card data-testid="mcp-tool-rules-card">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex items-center gap-2 text-sm">
              <WrenchIcon className="size-3.5" />
              {t("title")}
              {tools.length > 0 && (
                <Badge variant="secondary" className="text-[10px] tabular-nums">
                  {t("countBadge", { total: tools.length, denied: deniedCount })}
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs">{t("subtitle")}</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void discover()}
            disabled={!canDiscover || busy}
            title={canDiscover ? t("refreshTooltip") : t("desktopOnly")}
          >
            {discovering ? (
              <Loader2Icon className="size-3.5 animate-spin sm:mr-1.5" />
            ) : (
              <RefreshCwIcon className="size-3.5 sm:mr-1.5" />
            )}
            <span className="hidden sm:inline">{t("refresh")}</span>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {error && <p className="text-xs text-destructive">{error}</p>}

        {tools.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-center">
            <p className="text-xs text-muted-foreground">
              {loading ? t("loading") : canDiscover ? t("emptyDesktop") : t("desktopOnly")}
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="relative min-w-40 flex-1">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("searchPlaceholder")}
                  className="h-8 pl-8 text-xs"
                  aria-label={t("searchPlaceholder")}
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={allowAllFiltered}
                disabled={busy || filtered.length === 0}
              >
                {t("allowAll")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={denyAllFiltered}
                disabled={busy || filtered.length === 0}
              >
                {t("denyAll")}
              </Button>
              {query.trim() && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => addPattern(`*${query.trim()}*`)}
                  disabled={busy}
                  title={t("denyMatchingTooltip")}
                >
                  <CircleSlashIcon className="size-3.5 sm:mr-1.5" />
                  <span className="hidden sm:inline">{t("denyMatching")}</span>
                </Button>
              )}
            </div>

            <div className="divide-y rounded-md border" data-testid="mcp-tool-list">
              {filtered.length === 0 ? (
                <p className="p-4 text-center text-xs text-muted-foreground">{t("noMatch")}</p>
              ) : (
                filtered.map((tool) => {
                  const matched = matchingToolPatterns(tool.name, rules)
                  const pinned = explicit.includes(tool.name)
                  const denied = pinned || matched.length > 0
                  return (
                    <div
                      key={tool.name}
                      className="flex items-start gap-2.5 px-2.5 py-2"
                      data-testid={`mcp-tool-row-${tool.name}`}
                    >
                      <Switch
                        className="mt-0.5"
                        checked={!denied}
                        disabled={busy || matched.length > 0}
                        onCheckedChange={(value) => setToolAllowed(tool.name, value)}
                        aria-label={
                          denied
                            ? t("allowToolAria", { name: tool.name })
                            : t("denyToolAria", { name: tool.name })
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span
                            className={cn(
                              "truncate font-mono text-[11px]",
                              denied && "text-muted-foreground line-through"
                            )}
                          >
                            {tool.name}
                          </span>
                          {matched.length > 0 && (
                            <Badge variant="outline" className="h-4 px-1 text-[9px]">
                              {t("deniedByPattern", { pattern: matched[0] })}
                            </Badge>
                          )}
                        </div>
                        {tool.description && (
                          <p className="line-clamp-2 text-[10px] text-muted-foreground">
                            {tool.description}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            {discoveredAt && (
              <p className="text-[10px] text-muted-foreground">
                {t("discoveredAt", { time: new Date(discoveredAt).toLocaleString() })}
              </p>
            )}
          </>
        )}

        <div className="space-y-1.5 rounded-md border bg-muted/30 p-2.5">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("patternsTitle")}
          </p>
          <p className="text-[10px] text-muted-foreground">{t("patternsHint")}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {patterns.map((pattern) => {
              const hits = tools.filter((tool) => matchesToolPattern(tool.name, pattern)).length
              return (
                <span
                  key={pattern}
                  className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[10px]"
                  data-testid={`mcp-tool-pattern-${pattern}`}
                >
                  <code className="font-mono">{pattern}</code>
                  <span className="text-muted-foreground tabular-nums">
                    {t("patternHits", { count: hits })}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-4"
                    onClick={() => removePattern(pattern)}
                    disabled={busy}
                    aria-label={t("removePattern", { pattern })}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </span>
              )
            })}
            {patterns.length === 0 && (
              <span className="text-[10px] text-muted-foreground">{t("patternsEmpty")}</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              value={patternDraft}
              onChange={(event) => setPatternDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  addPattern(patternDraft)
                }
              }}
              placeholder={t("patternPlaceholder")}
              className="h-7 font-mono text-[11px]"
              aria-label={t("patternPlaceholder")}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0"
              onClick={() => addPattern(patternDraft)}
              disabled={busy || !patternDraft.trim()}
            >
              <PlusIcon className="size-3.5" />
            </Button>
          </div>
          {patternDraft.trim() && !isToolPattern(patternDraft) && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400">{t("patternLiteral")}</p>
          )}
        </div>

        {orphanRules.length > 0 && (
          <div className="space-y-1.5 rounded-md border border-dashed p-2.5">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("orphansTitle")}
            </p>
            <p className="text-[10px] text-muted-foreground">{t("orphansHint")}</p>
            <div className="flex flex-wrap gap-1.5">
              {orphanRules.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 font-mono text-[10px]"
                >
                  {name}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-4"
                    onClick={() => setToolAllowed(name, true)}
                    disabled={busy}
                    aria-label={t("removeOrphan", { name })}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
