"use client"

/**
 * HookGroupEditor — edits a single `HookGroup` (matcher + agents + handler list).
 *
 * Phase 5 of the ClaudeCode 完整化 plan. The matcher field is a Claude Code
 * tool-name regex (or `"*"` / pipe-list). Validation is regex-only — pipe
 * lists work too because they're valid regex alternations. An empty matcher
 * means "match all", consistent with `lib/claude/hooks.ts:HookGroup`.
 *
 * `agents` is the orthogonal selector: `matcher` narrows by tool, `agents`
 * narrows by which agent produced the turn. It is a COGNIA EXTENSION — this
 * panel writes `~/.claude/settings.json`, which real Claude Code also reads and
 * where the unknown key is ignored, so a group narrowed here runs
 * unconditionally there. The field carries that warning inline rather than
 * leaving users to discover it.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card } from "@/components/ui/card"
import { HOOK_AGENT_KINDS } from "@/lib/claude/hooks"
import type { HookGroup, HookHandler, HookHandlerType } from "@/lib/claude/hooks"
import { knownHookRuntimeCapabilities } from "@/lib/claude/hooks/runtime-capabilities"
import { emptyHandlerForType, HookHandlerForm } from "./hook-handler-form"

const DEFAULT_HANDLER_TYPES = knownHookRuntimeCapabilities("claude").handlerTypes

interface Props {
  value: HookGroup
  onChange: (next: HookGroup) => void
  onRemove: () => void
  /** Focus the matcher input on mount — set for a freshly added group. */
  autoFocus?: boolean
  supportedHandlerTypes?: readonly HookHandlerType[]
}

export function HookGroupEditor({
  value,
  onChange,
  onRemove,
  autoFocus,
  supportedHandlerTypes = DEFAULT_HANDLER_TYPES,
}: Props) {
  const t = useTranslations("settings.hooks.group")

  const matcherError = useMemo(() => validateMatcher(value.matcher), [value.matcher])
  const agentsError = useMemo(() => validateMatcher(value.agents), [value.agents])
  const agentsHint = useMemo(() => HOOK_AGENT_KINDS.join(" · "), [])

  const updateHandler = (idx: number, next: HookHandler) => {
    const handlers = value.hooks.map((h, i) => (i === idx ? next : h))
    onChange({ ...value, hooks: handlers })
  }
  const removeHandler = (idx: number) => {
    onChange({ ...value, hooks: value.hooks.filter((_, i) => i !== idx) })
  }
  const addHandler = () => {
    const type = supportedHandlerTypes[0]
    if (!type) return
    onChange({
      ...value,
      hooks: [...value.hooks, emptyHandlerForType(type)],
    })
  }

  return (
    <Card className="space-y-3 p-4" data-testid="hook-group-editor">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 space-y-1">
          <Label className="text-xs">{t("matcherLabel")}</Label>
          <Input
            value={value.matcher ?? ""}
            onChange={(e) =>
              onChange({ ...value, matcher: e.target.value === "" ? undefined : e.target.value })
            }
            placeholder={t("matcherPlaceholder")}
            className="font-mono text-xs"
            aria-invalid={Boolean(matcherError)}
            autoFocus={autoFocus}
            data-testid="group-matcher"
          />
          <p className="text-[11px] text-muted-foreground">{t("matcherHint")}</p>
          {matcherError ? (
            <p
              className="text-[11px] text-destructive"
              role="alert"
              data-testid="group-matcher-error"
            >
              {t("matcherInvalid", { detail: matcherError })}
            </p>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-destructive"
          onClick={onRemove}
          aria-label={t("removeAria")}
          data-testid="group-remove"
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t("agentsLabel")}</Label>
        <Input
          value={value.agents ?? ""}
          onChange={(e) =>
            onChange({ ...value, agents: e.target.value === "" ? undefined : e.target.value })
          }
          placeholder={t("agentsPlaceholder")}
          className="font-mono text-xs"
          aria-invalid={Boolean(agentsError)}
          data-testid="group-agents"
        />
        <p className="text-[11px] text-muted-foreground">
          {t("agentsHint", { kinds: agentsHint })}
        </p>
        {value.agents ? (
          <p
            className="text-[11px] text-amber-600 dark:text-amber-500"
            data-testid="group-agents-portability"
          >
            {t("agentsPortabilityWarning")}
          </p>
        ) : null}
        {agentsError ? (
          <p className="text-[11px] text-destructive" role="alert" data-testid="group-agents-error">
            {t("agentsInvalid", { detail: agentsError })}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        {value.hooks.length === 0 ? (
          <p className="text-xs italic text-muted-foreground" data-testid="group-empty-handlers">
            {t("emptyHandlers")}
          </p>
        ) : (
          value.hooks.map((h, i) => (
            <HookHandlerForm
              key={i}
              value={h}
              onChange={(next) => updateHandler(i, next)}
              onRemove={() => removeHandler(i)}
              supportedHandlerTypes={supportedHandlerTypes}
            />
          ))
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={addHandler}
          disabled={supportedHandlerTypes.length === 0}
          data-testid="group-add-handler"
          className="text-xs"
        >
          <PlusIcon className="mr-1 size-3.5" />
          {t("addHandler")}
        </Button>
      </div>
    </Card>
  )
}

/** Returns the error message when `matcher` is not a valid regex, else `null`. */
export function validateMatcher(matcher: string | undefined): string | null {
  if (!matcher || matcher.trim() === "" || matcher === "*") return null
  try {
    new RegExp(matcher)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : "invalid regex"
  }
}
