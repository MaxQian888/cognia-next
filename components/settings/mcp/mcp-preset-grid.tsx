"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon, Loader2Icon, SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { MCP_PRESETS, type McpPreset } from "@/lib/claude/mcp-presets"
import { searchRegistry } from "@/lib/mcp/registry/client"

interface Props {
  existingNames: string[]
  onPresetSelected: (preset: McpPreset, values: Record<string, string>) => void
}

/** Debounce before hitting the network, so typing doesn't fire a request a key. */
const REGISTRY_DEBOUNCE_MS = 350
/** Below this, a query matches too much of the registry to be useful. */
const REGISTRY_MIN_QUERY = 2

interface RegistryState {
  presets: McpPreset[]
  loading: boolean
  failed: boolean
  /** True once a query has actually been searched (so we can show "no results"). */
  searched: boolean
  /** False when the registry shouldn't be consulted at all — hides the section. */
  active: boolean
}

/**
 * Live search against the official MCP Registry, layered under the curated
 * catalog. Only runs for a real query — browsing with no term would just dump
 * whatever the registry happens to return first, which isn't useful. A tag
 * filter means the user is narrowing the curated set, so registry results are
 * suppressed rather than shown ignoring the filter.
 *
 * The result is tagged with the query it came from, so everything except the
 * fetch itself is derived at render. That keeps the effect free of synchronous
 * setState and means a stale page can never be shown against a newer query.
 */
function useRegistrySearch(query: string, activeTag: string | null): RegistryState {
  const q = query.trim()
  const active = !activeTag && q.length >= REGISTRY_MIN_QUERY
  const [result, setResult] = useState<{
    query: string
    presets: McpPreset[]
    failed: boolean
  } | null>(null)

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchRegistry({ search: q, limit: 30, signal: controller.signal })
        .then((res) => {
          if (!controller.signal.aborted) {
            setResult({ query: q, presets: res.presets, failed: false })
          }
        })
        .catch(() => {
          // Offline or registry down: the curated catalog still works, so fail
          // quietly into an inline notice instead of a toast.
          if (!controller.signal.aborted) setResult({ query: q, presets: [], failed: true })
        })
    }, REGISTRY_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [q, active])

  const fresh = result && result.query === q ? result : null
  return {
    presets: fresh?.presets ?? [],
    failed: fresh?.failed ?? false,
    loading: active && !fresh,
    searched: !!fresh,
    active,
  }
}

/**
 * The MCP preset "market" — the catalog from the legacy gallery dialog,
 * flattened into a full tab. Search + tag filtering pick a preset; presets
 * that require fields drop into an inline configure step before emitting
 * `onPresetSelected`. Field-less presets (and "Custom") emit immediately.
 */
export function McpPresetGrid({ existingNames, onPresetSelected }: Props) {
  const t = useTranslations("mcp.gallery")
  const [selected, setSelected] = useState<McpPreset | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [query, setQuery] = useState("")
  const [activeTag, setActiveTag] = useState<string | null>(null)

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const p of MCP_PRESETS) {
      for (const tag of p.tags ?? []) set.add(tag)
    }
    return Array.from(set).sort()
  }, [])

  const presets = useMemo(() => {
    const q = query.trim().toLowerCase()
    return MCP_PRESETS.filter((p) => {
      if (activeTag && !(p.tags ?? []).includes(activeTag)) return false
      if (!q) return true
      const haystack = [p.name, p.description, p.id, ...(p.tags ?? [])].join(" ").toLowerCase()
      return haystack.includes(q)
    })
  }, [query, activeTag])

  const registry = useRegistrySearch(query, activeTag)

  const nameTaken = selected ? existingNames.includes(selected.id.toLowerCase()) : false

  const handlePick = (preset: McpPreset) => {
    if (preset.fields.length === 0) {
      onPresetSelected(preset, {})
      return
    }
    setSelected(preset)
    const initial: Record<string, string> = {}
    const env = (preset.config.env as Record<string, string> | undefined) ?? {}
    const headers = (preset.config.headers as Record<string, string> | undefined) ?? {}
    const presetUrl = typeof preset.config.url === "string" ? preset.config.url : ""
    for (const f of preset.fields) {
      if (f.placement === "env") initial[f.key] = env[f.key] ?? ""
      else if (f.placement === "header") initial[f.key] = headers[f.key] ?? ""
      else if (f.placement === "url") initial[f.key] = presetUrl
      else initial[f.key] = ""
    }
    setValues(initial)
  }

  const handleSubmit = () => {
    if (!selected) return
    onPresetSelected(selected, values)
    setSelected(null)
    setValues({})
  }

  if (selected) {
    return (
      <div className="space-y-3" data-testid="mcp-preset-configure">
        <div>
          <h3 className="text-sm font-medium">{t("configureTitle", { name: selected.name })}</h3>
          <p className="text-xs text-muted-foreground">{selected.description}</p>
        </div>
        {nameTaken && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-200">
            {t("duplicateName", { name: selected.id })}
          </p>
        )}
        {selected.fields.map((field) => (
          <div key={field.key} className="space-y-1">
            <Label className="text-xs">{field.label}</Label>
            <Input
              type={field.secret ? "password" : "text"}
              placeholder={field.placeholder}
              value={values[field.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              className="text-xs"
            />
            {field.description && (
              <p className="text-[10px] text-muted-foreground">{field.description}</p>
            )}
          </div>
        ))}
        {selected.docsUrl && (
          <a
            href={selected.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          >
            <ExternalLinkIcon className="size-3" />
            {t("docs")}
          </a>
        )}
        <div className="flex justify-between gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
            {t("back")}
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={nameTaken || selected.fields.some((f) => !values[f.key]?.trim())}
          >
            {t("addServer")}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2" data-testid="mcp-preset-grid">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search")}
          className="h-8 pl-8 text-xs"
        />
      </div>
      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <TagChip
            active={activeTag == null}
            onClick={() => setActiveTag(null)}
            label={t("tagAll")}
          />
          {allTags.map((tag) => (
            <TagChip
              key={tag}
              active={activeTag === tag}
              onClick={() => setActiveTag((prev) => (prev === tag ? null : tag))}
              label={tag}
            />
          ))}
        </div>
      )}
      {presets.length === 0 && !registry.active ? (
        <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          {t("noMatch")}
        </p>
      ) : (
        presets.length > 0 && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {presets.map((p) => (
              <PresetCard
                key={p.id}
                preset={p}
                taken={existingNames.includes(p.id.toLowerCase()) && p.id !== "custom"}
                takenLabel={t("addedBadge")}
                onPick={handlePick}
              />
            ))}
          </div>
        )
      )}

      {registry.active && (
        <div className="space-y-2 pt-1" data-testid="mcp-registry-results">
          <div className="flex items-center gap-1.5 pt-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {t("registryTitle")}
            </span>
            {registry.loading && (
              <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
            )}
          </div>
          {registry.failed ? (
            <p className="rounded-md border border-dashed p-3 text-center text-[11px] text-muted-foreground">
              {t("registryError")}
            </p>
          ) : registry.presets.length === 0 && !registry.loading ? (
            <p className="rounded-md border border-dashed p-3 text-center text-[11px] text-muted-foreground">
              {t("registryEmpty")}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {registry.presets.map((p) => (
                <PresetCard
                  key={p.id}
                  preset={p}
                  taken={existingNames.includes(p.id.toLowerCase())}
                  takenLabel={t("addedBadge")}
                  onPick={handlePick}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** One clickable card in either grid. `h-full` keeps a row's cards aligned. */
function PresetCard({
  preset,
  taken,
  takenLabel,
  onPick,
}: {
  preset: McpPreset
  taken: boolean
  takenLabel: string
  onPick: (preset: McpPreset) => void
}) {
  return (
    <button
      type="button"
      className="group flex h-full flex-col items-start gap-1 rounded-md border bg-card p-3 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent disabled:opacity-50"
      onClick={() => onPick(preset)}
      disabled={taken}
    >
      <div className="flex w-full items-center gap-2">
        <span className="text-xl leading-none">{preset.icon}</span>
        <span className="flex-1 truncate font-medium">{preset.name}</span>
        {taken && <span className="text-[10px] text-muted-foreground">{takenLabel}</span>}
      </div>
      <p className="line-clamp-2 text-[11px] text-muted-foreground">{preset.description}</p>
    </button>
  )
}

function TagChip({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-[10px] uppercase tracking-wider transition-colors",
        active
          ? "border-primary/40 bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:border-primary/40 hover:bg-accent"
      )}
    >
      {label}
    </button>
  )
}
