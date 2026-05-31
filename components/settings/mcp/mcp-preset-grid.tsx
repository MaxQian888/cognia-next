"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ExternalLinkIcon, SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { MCP_PRESETS, type McpPreset } from "@/lib/claude/mcp-presets"

interface Props {
  existingNames: string[]
  onPresetSelected: (preset: McpPreset, values: Record<string, string>) => void
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
      {presets.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          {t("noMatch")}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {presets.map((p) => {
            const taken = existingNames.includes(p.id.toLowerCase())
            return (
              <button
                key={p.id}
                type="button"
                className="group flex flex-col items-start gap-1 rounded-md border bg-card p-3 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent disabled:opacity-50"
                onClick={() => handlePick(p)}
                disabled={taken && p.id !== "custom"}
              >
                <div className="flex w-full items-center gap-2">
                  <span className="text-xl leading-none">{p.icon}</span>
                  <span className="flex-1 truncate font-medium">{p.name}</span>
                  {taken && p.id !== "custom" && (
                    <span className="text-[10px] text-muted-foreground">{t("addedBadge")}</span>
                  )}
                </div>
                <p className="line-clamp-2 text-[11px] text-muted-foreground">{p.description}</p>
              </button>
            )
          })}
        </div>
      )}
    </div>
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
