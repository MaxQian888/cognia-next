"use client"

// Model-alias mapping CRUD list — the heart of routing customization. Each
// row shows the alias, its fallback chain, and edit/delete controls.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { GitMerge, Pencil, Plus, Trash2 } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SettingsEmptyState } from "@/components/settings/common/settings-section"
import { FallbackChainView } from "./fallback-chain-view"
import { ModelAliasEditor } from "./model-alias-editor"
import type { ModelMapping } from "@cognia/provider-types/model-mapping"

export function ModelAliasList() {
  const t = useTranslations("providers.routingView")
  const mappings = useSettingsStore((s) => s.settings?.modelMappings) ?? []
  const removeModelMapping = useSettingsStore((s) => s.removeModelMapping)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ModelMapping | null>(null)

  const openNew = () => {
    setEditing(null)
    setEditorOpen(true)
  }
  const openEdit = (mapping: ModelMapping) => {
    setEditing(mapping)
    setEditorOpen(true)
  }

  return (
    <div className="space-y-3">
      {mappings.length === 0 ? (
        <SettingsEmptyState
          icon={<GitMerge className="h-5 w-5" />}
          title={t("noAliases")}
          description={t("noAliasesDesc")}
        />
      ) : (
        <div className="space-y-2">
          {mappings.map((m) => (
            <div
              key={m.id}
              className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5"
              data-testid={`alias-row-${m.alias}`}
            >
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">{m.alias}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {m.distribution === "weighted"
                      ? t("distributionWeighted")
                      : t("distributionPriority")}
                  </Badge>
                  {!m.enabled ? (
                    <Badge variant="secondary" className="text-[10px]">
                      {t("aliasDisabled")}
                    </Badge>
                  ) : null}
                </div>
                <FallbackChainView entries={m.providers} />
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={t("editAlias")}
                  onClick={() => openEdit(m)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive"
                  aria-label={t("deleteAlias")}
                  onClick={() => void removeModelMapping(m.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={openNew}>
        <Plus className="mr-1 h-3 w-3" />
        {t("addAlias")}
      </Button>

      <ModelAliasEditor open={editorOpen} onOpenChange={setEditorOpen} mapping={editing} />
    </div>
  )
}

export default ModelAliasList
