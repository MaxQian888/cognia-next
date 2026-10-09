"use client"

/**
 * "Start blank" (ADR-0220): the agent form, empty, in create mode. Saving
 * creates the agent and opens it.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { Character } from "@cognia/agent-config-types"
import { CharacterEditor } from "@/components/agents/editor/character-editor"
import type { AgentCatalogs } from "@/hooks/agents/use-agent-catalogs"
import { createCharacter } from "@/lib/db/characters"
import { emptyEditorState } from "@/lib/agents/editor-state"
import { createLogger } from "@cognia/logging"

const log = createLogger("agents.create")

export interface AgentBlankCreateProps {
  catalogs: AgentCatalogs
  onCreated: (agent: Character) => void
  onCancel: () => void
}

export function AgentBlankCreate({ catalogs, onCreated, onCancel }: AgentBlankCreateProps) {
  const t = useTranslations("settings.characters")
  const [initial] = useState(emptyEditorState)
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-5" data-testid="agent-blank-create">
      <CharacterEditor
        initial={initial}
        skillsCatalog={catalogs.skills}
        mcpCatalog={catalogs.mcpServers}
        knowledgeBaseCatalog={catalogs.knowledgeBases}
        submitLabel={t("create")}
        chrome="plain"
        onCancel={onCancel}
        onSave={async (data) => {
          try {
            const agent = await createCharacter(data)
            log.info("character_created", { name: data.name })
            toast.success(t("addedToast", { name: data.name }))
            onCreated(agent)
          } catch (err) {
            log.error("character_create_failed", err)
            toast.error(err instanceof Error ? err.message : String(err))
          }
        }}
      />
    </div>
  )
}
