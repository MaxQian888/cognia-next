// The shared talk composer: an autofocused input with IME-safe Enter submit
// and shell-style ↑/↓ recall of previous phrases, persisted under one global
// key ("one pet talk surface") so phrases repeat across the widget panel, the
// desktop popup, and the /pet nurture tab.

"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import type { ChatStatus } from "ai"
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input"
import { cn } from "@/lib/utils"
import { useCommandHistory, handleHistoryArrowKey } from "@/hooks/use-command-history"

export interface PetTalkComposerProps {
  /** Talk action. Submitted composer text rides along; empty submit omits it. */
  onTalk: (text?: string) => void
  className?: string
  mode?: "compact" | "chat"
  status?: ChatStatus
  allowEmpty?: boolean
}

export function PetTalkComposer({
  onTalk,
  className,
  mode = "compact",
  status,
  allowEmpty = mode === "compact",
}: PetTalkComposerProps) {
  const t = useTranslations("pet")
  const [text, setText] = useState("")
  const history = useCommandHistory({ persistKey: "cmdhist:pet-talk" })

  const busy = status === "submitted" || status === "streaming"

  return (
    <PromptInput
      data-testid="pet-talk-composer"
      className={cn(mode === "compact" && "[&_[data-slot=input-group]]:min-h-8", className)}
      onSubmit={({ text: submitted }) => {
        const trimmed = submitted.trim()
        if (!trimmed && !allowEmpty) return
        if (trimmed) history.record(trimmed)
        onTalk(trimmed || undefined)
        setText("")
      }}
    >
      <PromptInputBody>
        <PromptInputTextarea
          autoFocus
          value={text}
          placeholder={t("talkInput.placeholder")}
          aria-label={t("talkInput.placeholder")}
          className={cn(mode === "compact" && "min-h-8 py-1.5 text-xs")}
          maxLength={500}
          rows={mode === "compact" ? 1 : 2}
          onChange={(event) => {
            setText(event.currentTarget.value)
            history.noteEdit()
          }}
          onKeyDown={(event) => {
            handleHistoryArrowKey(event, history, setText)
          }}
        />
      </PromptInputBody>
      <PromptInputFooter className={cn(mode === "compact" && "py-1 pr-1 pl-0")}>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {mode === "chat" ? `${text.length}/500` : null}
        </span>
        <PromptInputSubmit
          status={status}
          aria-label={t("talkInput.send")}
          disabled={busy || (!allowEmpty && !text.trim())}
        />
      </PromptInputFooter>
    </PromptInput>
  )
}
