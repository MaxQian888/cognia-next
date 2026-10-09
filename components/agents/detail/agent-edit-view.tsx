"use client"

/**
 * An agent's edit mode (ADR-0220): the full agent form in place of the
 * profile. A built-in or pack-provided agent cannot be edited in place, so it
 * says so and offers the copy that can; a variant says which base it follows.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CopyIcon, LockIcon } from "lucide-react"
import type { Character } from "@cognia/agent-config-types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { CharacterEditor } from "@/components/agents/editor/character-editor"
import { SupportDiagnosticsConsent } from "@/components/support/support-diagnostics-consent"
import { updateCharacter } from "@/lib/db/characters"
import { characterToEditorState } from "@/lib/agents/editor-state"
import { isSupportAgentId } from "@/lib/support-agent/context"
import type { AgentCatalogs } from "@/hooks/agents/use-agent-catalogs"
import { createLogger } from "@cognia/logging"

const log = createLogger("agents.edit")

export interface AgentEditViewProps {
  agent: Character
  editable: boolean
  catalogs: AgentCatalogs
  /** The base's name when the agent is a variant. */
  baseName?: string
  onDuplicate: () => void
  onDone: () => void
}

export function AgentEditView({
  agent,
  editable,
  catalogs,
  baseName,
  onDuplicate,
  onDone,
}: AgentEditViewProps) {
  const t = useTranslations("settings.characters")
  const tc = useTranslations("agentsConsole.edit")
  // Re-hydrate only when the stored agent actually changes (its id or its
  // `updatedAt`), not whenever the live query hands back a new object for an
  // unrelated write, so an edit in progress is not reset under the user.
  const key = `${agent.id}:${agent.updatedAt}`
  const [snapshot, setSnapshot] = useState(() => ({ key, initial: characterToEditorState(agent) }))
  if (snapshot.key !== key) setSnapshot({ key, initial: characterToEditorState(agent) })
  const initial = snapshot.initial

  return (
    <div className="mx-auto w-full max-w-3xl space-y-3" data-testid="agent-edit">
      {isSupportAgentId(agent.id) ? <SupportDiagnosticsConsent surface="settings" /> : null}
      {!editable ? (
        <Alert data-testid="agent-edit-locked">
          <LockIcon className="size-4" />
          <AlertTitle>{tc("lockedTitle")}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{agent.isBuiltIn ? t("builtInReadOnly") : t("overlayReadOnly")}</p>
            <Button size="sm" variant="outline" onClick={onDuplicate}>
              <CopyIcon className="size-3.5" aria-hidden />
              {tc("duplicateToEdit")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {agent.variant ? (
            <p
              className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
              data-testid="variant-editor-notice"
            >
              {t("variants.editorNotice", { base: baseName ?? agent.variant.baseId })}
            </p>
          ) : null}
          <CharacterEditor
            editingId={agent.id}
            initial={initial}
            skillsCatalog={catalogs.skills}
            mcpCatalog={catalogs.mcpServers}
            knowledgeBaseCatalog={catalogs.knowledgeBases}
            submitLabel={t("save")}
            chrome="plain"
            onCancel={onDone}
            onSave={async (patch) => {
              try {
                await updateCharacter(agent.id, patch)
                log.info("character_updated", { id: agent.id })
                toast.success(t("updatedToast", { name: patch.name || agent.name }))
                onDone()
              } catch (err) {
                log.error("character_update_failed", err, { id: agent.id })
                toast.error(err instanceof Error ? err.message : String(err))
              }
            }}
          />
        </>
      )}
    </div>
  )
}
