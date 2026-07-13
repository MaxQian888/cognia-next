"use client"

/**
 * Tool-search runtime card — surfaces the previously dormant
 * `AppSettings.toolSearchRuntime` (consumed by `lib/claude/build-options.ts`).
 *
 * When enabled, tools load on demand (deferred) to shrink the system prompt;
 * the two allow-lists pin specific MCP servers / bare tools as always-resident.
 * Built on the shared settings toolkit so it matches the rest of the tab.
 *
 * The two allow-lists used to be raw free-text fields, so a typo silently
 * never matched at send time. They are now backed by the real
 * {@link getToolCatalog} aggregate: each editor offers `<datalist>`
 * autocomplete over the live server / tool names and flags any entry that
 * matches nothing in the catalog, so a mistyped pin is visible instead of
 * silently inert. Free text is still accepted (e.g. a server you haven't
 * connected yet).
 */

import { useEffect, useId, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { SearchCodeIcon, PlusIcon, XIcon, TriangleAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SettingsCard, SettingsToggle } from "@/components/settings/common/settings-section"
import { useSettingsStore } from "@/stores/settings"
import type { ToolSearchRuntimeConfig } from "@cognia/agent-config-types"
import { BUILTIN_SERVER_NAME } from "@/lib/settings/builtin-tools"
import { getToolCatalog, PLUGIN_TOOLS_SERVER_NAME } from "@/lib/tools/tool-catalog"

const DEFAULT_CONFIG: ToolSearchRuntimeConfig = { enabled: false }

const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort()

export function ToolSearchRuntimeCard() {
  const t = useTranslations("settings.agentRuntimeSection.toolSearch")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const config = settings?.toolSearchRuntime ?? DEFAULT_CONFIG

  // Live names the two allow-lists can legitimately reference. Server pins
  // match by server name (`mcpServers` is keyed by name; the synthetic builtin
  // / plugin servers carry fixed names); tool pins match a bare tool name from
  // any non-MCP source. Best-effort: a failing catalog leaves the sets empty,
  // which disables the "unrecognized" flagging rather than false-flagging.
  const [serverNames, setServerNames] = useState<readonly string[]>([])
  const [toolNames, setToolNames] = useState<readonly string[]>([])

  useEffect(() => {
    let alive = true
    getToolCatalog()
      .then((entries) => {
        if (!alive) return
        setServerNames(
          sortedUnique([
            BUILTIN_SERVER_NAME,
            PLUGIN_TOOLS_SERVER_NAME,
            ...entries.filter((e) => e.source === "mcp").map((e) => e.name),
          ])
        )
        setToolNames(sortedUnique(entries.filter((e) => e.source !== "mcp").map((e) => e.name)))
      })
      .catch(() => {
        /* catalog unavailable (SSR/web edge) — leave suggestions empty */
      })
    return () => {
      alive = false
    }
  }, [])

  const knownServers = useMemo(() => new Set(serverNames), [serverNames])
  const knownTools = useMemo(() => new Set(toolNames), [toolNames])

  const update = (patch: Partial<ToolSearchRuntimeConfig>) => {
    void save({ toolSearchRuntime: { ...config, ...patch } })
  }

  return (
    <SettingsCard
      icon={<SearchCodeIcon className="size-4" />}
      title={t("title")}
      description={t("description")}
    >
      <SettingsToggle
        id="tool-search-enabled"
        label={t("enableLabel")}
        description={t("enableHelp")}
        checked={config.enabled}
        onCheckedChange={(v) => update({ enabled: v })}
      />

      {config.enabled && (
        <div className="space-y-4">
          <TagListEditor
            label={t("serversLabel")}
            help={t("serversHelp")}
            placeholder={t("serversPlaceholder")}
            addAria={t("addAria")}
            removeAria={(v) => t("removeAria", { value: v })}
            unknownHint={t("unknownHint")}
            suggestions={serverNames}
            known={knownServers}
            values={config.alwaysLoadServers ?? []}
            onChange={(next) => update({ alwaysLoadServers: next })}
            testid="tool-search-servers"
          />
          <TagListEditor
            label={t("toolsLabel")}
            help={t("toolsHelp")}
            placeholder={t("toolsPlaceholder")}
            addAria={t("addAria")}
            removeAria={(v) => t("removeAria", { value: v })}
            unknownHint={t("unknownHint")}
            suggestions={toolNames}
            known={knownTools}
            values={config.alwaysLoadTools ?? []}
            onChange={(next) => update({ alwaysLoadTools: next })}
            testid="tool-search-tools"
          />
        </div>
      )}
    </SettingsCard>
  )
}

interface TagListEditorProps {
  label: string
  help: string
  placeholder: string
  addAria: string
  removeAria: (value: string) => string
  unknownHint: string
  /** Autocomplete options offered via a `<datalist>`. */
  suggestions: readonly string[]
  /** Recognized values; entries outside this set are flagged (empty = no flagging). */
  known: ReadonlySet<string>
  values: string[]
  onChange: (next: string[]) => void
  testid: string
}

function TagListEditor({
  label,
  help,
  placeholder,
  addAria,
  removeAria,
  unknownHint,
  suggestions,
  known,
  values,
  onChange,
  testid,
}: TagListEditorProps) {
  const [draft, setDraft] = useState("")
  const listId = useId()

  const add = () => {
    const value = draft.trim()
    if (!value || values.includes(value)) {
      setDraft("")
      return
    }
    onChange([...values, value])
    setDraft("")
  }

  const remove = (value: string) => onChange(values.filter((v) => v !== value))

  return (
    <div className="space-y-2" data-testid={testid}>
      <div className="space-y-0.5">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          list={suggestions.length > 0 ? listId : undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              add()
            }
          }}
        />
        {suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
        <Button variant="outline" onClick={add} disabled={!draft.trim()} aria-label={addAria}>
          <PlusIcon className="size-4" />
        </Button>
      </div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((value) => {
            const unknown = known.size > 0 && !known.has(value)
            return (
              <Badge
                key={value}
                variant="secondary"
                title={unknown ? unknownHint : undefined}
                className={`gap-1 font-mono text-xs${unknown ? " border-amber-500/60 text-amber-600 dark:text-amber-400" : ""}`}
              >
                {unknown && (
                  <TriangleAlertIcon className="size-3 shrink-0" aria-label={unknownHint} />
                )}
                {value}
                <button
                  type="button"
                  onClick={() => remove(value)}
                  aria-label={removeAria(value)}
                  className="rounded-sm hover:text-destructive"
                >
                  <XIcon className="size-3" />
                </button>
              </Badge>
            )
          })}
        </div>
      )}
    </div>
  )
}
