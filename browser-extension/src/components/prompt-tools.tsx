import { useCallback, useEffect, useState } from "react"
import { Button, Input, Textarea } from "@cognia/plugin-ui"

import { STORAGE_KEYS, type BrowserApi } from "@ext/src/lib/browser-api"
import { QUICK_ACTIONS, type QuickActionId } from "@ext/src/lib/capture/capture-request"
import { quickActionInstruction, quickActionLabel } from "@ext/src/lib/panel/quick-actions"
import {
  parseSavedPrompts,
  upsertSavedPrompt,
  type SavedPrompt,
  type SavePromptOutcome,
} from "@ext/src/lib/preferences"

export interface PromptToolsProps {
  api: BrowserApi
  /** The instruction box's current text, offered as the prompt to save. */
  instruction: string
  /** Replace the instruction with a quick action's or a saved prompt's text. */
  onUse: (text: string, quickAction?: QuickActionId) => void
}

/**
 * One-click instructions above the instruction box (ADR-0228 §1).
 *
 * Quick actions are fixed and translated; saved prompts are the person's own,
 * kept in `chrome.storage.local` — their words, never page content — and
 * editable here: insert, save the current instruction, rename, delete.
 */
export function PromptTools({ api, instruction, onUse }: PromptToolsProps) {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([])
  const [managing, setManaging] = useState(false)
  const [editing, setEditing] = useState<SavedPrompt | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // A change that lands before the first read answers is newer than it.
    let changed = false
    void api
      .read<unknown>(STORAGE_KEYS.savedPrompts)
      .then((value) => {
        if (!cancelled && !changed) setPrompts(parseSavedPrompts(value))
      })
      .catch(() => undefined)
    const stop = api.onStorageChange(STORAGE_KEYS.savedPrompts, (value) => {
      changed = true
      if (!cancelled) setPrompts(parseSavedPrompts(value))
    })
    return () => {
      cancelled = true
      stop()
    }
  }, [api])

  const persist = useCallback(
    async (outcome: SavePromptOutcome) => {
      if (!outcome.ok) {
        setError(
          outcome.reason === "full"
            ? api.message("promptsFull")
            : outcome.reason === "too_long"
              ? api.message("promptsTooLong")
              : api.message("promptsEmpty")
        )
        return false
      }
      setError(null)
      setPrompts(outcome.prompts)
      await api.write(STORAGE_KEYS.savedPrompts, outcome.prompts)
      return true
    },
    [api]
  )

  const remove = useCallback(
    async (id: string) => {
      const next = prompts.filter((prompt) => prompt.id !== id)
      setPrompts(next)
      await api.write(STORAGE_KEYS.savedPrompts, next)
    },
    [api, prompts]
  )

  return (
    <div className="space-y-1.5" data-testid="prompt-tools">
      <div className="flex flex-wrap gap-1">
        {QUICK_ACTIONS.map((action) => (
          <Button
            key={action}
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() => onUse(quickActionInstruction(action, api.message), action)}
            data-testid={`quick-action-${action}`}
          >
            {quickActionLabel(action, api.message)}
          </Button>
        ))}
        {prompts.map((prompt) => (
          <Button
            key={prompt.id}
            size="sm"
            variant="secondary"
            className="h-6 max-w-40 truncate px-2 text-[11px]"
            title={prompt.instruction}
            onClick={() => onUse(prompt.instruction)}
            data-testid={`saved-prompt-${prompt.id}`}
          >
            {prompt.title}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={() => {
            setManaging((current) => !current)
            setEditing(null)
            setError(null)
          }}
          aria-expanded={managing}
          data-testid="prompts-manage"
        >
          {api.message("promptsManage")}
        </Button>
      </div>
      {managing ? (
        <div
          className="space-y-2 rounded-control border border-border p-2"
          data-testid="prompts-panel"
        >
          <Button
            size="sm"
            variant="outline"
            disabled={!instruction.trim()}
            onClick={() =>
              void persist(
                upsertSavedPrompt(prompts, { id: crypto.randomUUID(), title: "", instruction })
              )
            }
            data-testid="prompts-save-current"
          >
            {api.message("promptsSaveCurrent")}
          </Button>
          {prompts.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{api.message("promptsNone")}</p>
          ) : (
            <ul className="space-y-1">
              {prompts.map((prompt) =>
                editing?.id === prompt.id ? (
                  <li key={prompt.id} className="space-y-1">
                    <Input
                      value={editing.title}
                      onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                      aria-label={api.message("promptsTitleLabel")}
                      placeholder={api.message("promptsTitleLabel")}
                      data-testid="prompt-edit-title"
                    />
                    <Textarea
                      rows={3}
                      value={editing.instruction}
                      onChange={(event) =>
                        setEditing({ ...editing, instruction: event.target.value })
                      }
                      aria-label={api.message("promptsInstructionLabel")}
                      data-testid="prompt-edit-instruction"
                    />
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        onClick={() =>
                          void persist(upsertSavedPrompt(prompts, editing)).then((saved) => {
                            if (saved) setEditing(null)
                          })
                        }
                        data-testid="prompt-edit-save"
                      >
                        {api.message("promptsSave")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        {api.message("cancel")}
                      </Button>
                    </div>
                  </li>
                ) : (
                  <li key={prompt.id} className="flex items-center justify-between gap-1">
                    <span className="min-w-0 truncate text-xs" title={prompt.instruction}>
                      {prompt.title}
                    </span>
                    <span className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => setEditing(prompt)}
                        data-testid={`prompt-edit-${prompt.id}`}
                      >
                        {api.message("promptsEdit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => void remove(prompt.id)}
                        data-testid={`prompt-delete-${prompt.id}`}
                      >
                        {api.message("promptsDelete")}
                      </Button>
                    </span>
                  </li>
                )
              )}
            </ul>
          )}
          {error ? (
            <p role="alert" className="text-[11px] text-destructive" data-testid="prompts-error">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
