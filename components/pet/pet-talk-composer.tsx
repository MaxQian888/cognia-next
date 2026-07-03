// The shared talk composer: an autofocused input with IME-safe Enter submit
// and shell-style ↑/↓ recall of previous phrases, persisted under one global
// key ("one pet talk surface") so phrases repeat across the widget panel, the
// desktop popup, and the /pet nurture tab.

"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { SendIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useCommandHistory, handleHistoryArrowKey } from "@/hooks/use-command-history"

export interface PetTalkComposerProps {
  /** Talk action. Submitted composer text rides along; empty submit omits it. */
  onTalk: (text?: string) => void
  className?: string
}

export function PetTalkComposer({ onTalk, className }: PetTalkComposerProps) {
  const t = useTranslations("pet")
  const [text, setText] = useState("")
  const history = useCommandHistory({ persistKey: "cmdhist:pet-talk" })

  const submit = () => {
    const trimmed = text.trim()
    history.record(trimmed)
    onTalk(trimmed || undefined)
    setText("")
  }

  return (
    <div data-testid="pet-talk-composer" className={cn("flex items-center gap-2", className)}>
      <Input
        autoFocus
        value={text}
        placeholder={t("talkInput.placeholder")}
        aria-label={t("talkInput.placeholder")}
        className="h-8 text-xs"
        maxLength={500}
        onChange={(e) => {
          setText(e.target.value)
          history.noteEdit()
        }}
        onKeyDown={(e) => {
          if (handleHistoryArrowKey(e, history, setText)) return
          if (e.key === "Enter" && !e.nativeEvent.isComposing) submit()
        }}
      />
      <Button size="sm" className="h-8 shrink-0" onClick={submit} aria-label={t("talkInput.send")}>
        <SendIcon className="size-3.5" />
      </Button>
    </div>
  )
}
