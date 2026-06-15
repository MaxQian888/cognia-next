"use client"

/**
 * Tool-search runtime card — surfaces the previously dormant
 * `AppSettings.toolSearchRuntime` (consumed by `lib/claude/build-options.ts`).
 *
 * When enabled, tools load on demand (deferred) to shrink the system prompt;
 * the two allow-lists pin specific MCP servers / bare tools as always-resident.
 * Built on the shared settings toolkit so it matches the rest of the tab.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { SearchCodeIcon, PlusIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SettingsCard, SettingsToggle } from "@/components/settings/common/settings-section"
import { useSettingsStore } from "@/stores/settings"
import type { ToolSearchRuntimeConfig } from "@/lib/claude/types"

const DEFAULT_CONFIG: ToolSearchRuntimeConfig = { enabled: false }

export function ToolSearchRuntimeCard() {
  const t = useTranslations("settings.agentRuntimeSection.toolSearch")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const config = settings?.toolSearchRuntime ?? DEFAULT_CONFIG

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
  values,
  onChange,
  testid,
}: TagListEditorProps) {
  const [draft, setDraft] = useState("")

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
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              add()
            }
          }}
        />
        <Button variant="outline" onClick={add} disabled={!draft.trim()} aria-label={addAria}>
          <PlusIcon className="size-4" />
        </Button>
      </div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <Badge key={value} variant="secondary" className="gap-1 font-mono text-xs">
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
          ))}
        </div>
      )}
    </div>
  )
}
