"use client"

/**
 * The live agent draft beside the builder conversation (ADR-0220): the agent
 * form in controlled mode. The builder's tools write the draft; the panel
 * adopts each of their revisions. The person's own edits are written back
 * (debounced) and are never replaced by their own echo; an edit still waiting
 * when the builder writes is dropped rather than written over the builder's
 * newer draft, so storage keeps what the panel shows. "Create & open"
 * validates with the form's rules and creates the agent from the draft.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { SparklesIcon } from "lucide-react"
import type { AgentBuilderSessionState, Character } from "@cognia/agent-config-types"
import { CharacterEditor } from "@/components/agents/editor/character-editor"
import type { AgentCatalogs } from "@/hooks/agents/use-agent-catalogs"
import {
  characterToEditorState,
  editorStateToOutput,
  type EditorState,
} from "@/lib/agents/editor-state"
import {
  AgentBuilderSessionError,
  createAgentFromBuilder,
  writeBuilderDraft,
} from "@/lib/agents/builder/builder-session"

const WRITE_DELAY_MS = 400

export interface AgentBuilderDraftPanelProps {
  sessionId: string
  state: AgentBuilderSessionState
  catalogs: AgentCatalogs
  onCreated: (agent: Character) => void
  onDiscard: () => void
}

export function AgentBuilderDraftPanel({
  sessionId,
  state,
  catalogs,
  onCreated,
  onDiscard,
}: AgentBuilderDraftPanelProps) {
  const t = useTranslations("agentsConsole.builder")
  const [value, setValue] = useState<EditorState>(() => characterToEditorState(state.draft))
  // What secret bindings are compared against: the draft as the panel opened.
  // A secret added here after that still needs its value before creating.
  const [baseline] = useState<EditorState>(value)
  const [seenRevision, setSeenRevision] = useState(state.revision)
  const [agentTouched, setAgentTouched] = useState(false)
  // Adopt what the builder wrote; ignore the echo of our own writes.
  if (state.revision !== seenRevision) {
    setSeenRevision(state.revision)
    if (state.editedBy === "agent") {
      setValue(characterToEditorState(state.draft))
      setAgentTouched(true)
    }
  }

  const pending = useRef<EditorState | null>(null)
  // The revision the pending edit was made on top of.
  const pendingBase = useRef(state.revision)
  const latestRevision = useRef(state.revision)
  useEffect(() => {
    latestRevision.current = state.revision
  }, [state.revision])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const next = pending.current
    pending.current = null
    if (!next) return
    try {
      await writeBuilderDraft(sessionId, () => editorStateToOutput(next), "user", {
        baseRevision: pendingBase.current,
      })
    } catch (err) {
      // A draft discarded or created while an edit was still waiting to be
      // written has nowhere to go; that is not a failure worth a toast.
      if (err instanceof AgentBuilderSessionError && err.code !== "invalid-draft") return
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [sessionId])
  useEffect(
    () => () => {
      void flush()
    },
    [flush]
  )

  const onValueChange = useCallback(
    (next: EditorState) => {
      setValue(next)
      pending.current = next
      pendingBase.current = latestRevision.current
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), WRITE_DELAY_MS)
    },
    [flush]
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-builder-draft-panel">
      <div className="border-b px-5 py-3">
        <h2 className="text-sm font-semibold">{t("panelTitle")}</h2>
        <p className="text-xs text-muted-foreground">{t("panelDescription")}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <CharacterEditor
          initial={baseline}
          value={value}
          onValueChange={onValueChange}
          skillsCatalog={catalogs.skills}
          mcpCatalog={catalogs.mcpServers}
          knowledgeBaseCatalog={catalogs.knowledgeBases}
          chrome="plain"
          submitLabel={t("create")}
          cancelLabel={t("discard")}
          onCancel={onDiscard}
          footerStart={
            agentTouched ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <SparklesIcon className="size-3.5" aria-hidden />
                {t("updatedByBuilder", { revision: state.revision })}
              </span>
            ) : null
          }
          onSave={async (output) => {
            try {
              // The form's latest values, secrets already in the keyring, become
              // the draft that is created; the pending debounce is superseded.
              pending.current = null
              if (timer.current) clearTimeout(timer.current)
              await writeBuilderDraft(sessionId, () => output, "user")
              const agent = await createAgentFromBuilder(sessionId)
              toast.success(t("created", { name: agent.name }))
              onCreated(agent)
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      </div>
    </div>
  )
}
