"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { SkillValidationError } from "@cognia/agent-config-types"

type AiIntent = "optimize" | "simplify" | "expand" | "fixErrors"

interface Props {
  current: { name: string; description?: string; content: string }
  validationErrors: SkillValidationError[]
  onClose: () => void
  onAccept: (suggested: string) => void
  onAiAssist: (
    intent: AiIntent,
    current: {
      name: string
      description?: string
      content: string
      validationErrors?: SkillValidationError[]
    }
  ) => Promise<string | null>
}

const INTENTS: { id: AiIntent; labelKey: string; hintKey: string }[] = [
  { id: "optimize", labelKey: "optimize", hintKey: "optimizeHint" },
  { id: "simplify", labelKey: "simplify", hintKey: "simplifyHint" },
  { id: "expand", labelKey: "expand", hintKey: "expandHint" },
  { id: "fixErrors", labelKey: "fixErrors", hintKey: "fixErrorsHint" },
]

export function SkillEditorAiPopup({
  current,
  validationErrors,
  onClose,
  onAccept,
  onAiAssist,
}: Props) {
  const t = useTranslations("skills.ai")
  const tEditor = useTranslations("skills.editor")
  const [running, setRunning] = useState<AiIntent | null>(null)
  const [suggested, setSuggested] = useState<string | null>(null)
  const [usedIntent, setUsedIntent] = useState<AiIntent | null>(null)

  const run = async (intent: AiIntent) => {
    setRunning(intent)
    try {
      const out = await onAiAssist(intent, {
        ...current,
        validationErrors: intent === "fixErrors" ? validationErrors : undefined,
      })
      if (out !== null) {
        setSuggested(out)
        setUsedIntent(intent)
      }
    } finally {
      setRunning(null)
    }
  }

  const fixErrorsDisabled = validationErrors.length === 0

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("buttonLabel")}</DialogTitle>
          <DialogDescription>
            {t("diff")} — {current.name || tEditor("unnamedPreview")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {INTENTS.map((intent) => (
            <Button
              key={intent.id}
              variant={usedIntent === intent.id ? "default" : "outline"}
              size="sm"
              className={cn("h-auto justify-start py-2 text-left")}
              disabled={running !== null || (intent.id === "fixErrors" && fixErrorsDisabled)}
              onClick={() => run(intent.id)}
            >
              <div className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  {running === intent.id && <Spinner className="size-3" />}
                  {t(intent.labelKey)}
                </span>
                <span className="text-[10px] text-muted-foreground">{t(intent.hintKey)}</span>
              </div>
            </Button>
          ))}
        </div>

        {suggested !== null && (
          <div className="max-h-72 overflow-auto border-y py-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("diff")}
            </p>
            <Message from="assistant">
              <MessageContent>
                <MessageResponse>{suggested}</MessageResponse>
              </MessageContent>
            </Message>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("revert")}
          </Button>
          <Button
            size="sm"
            disabled={suggested === null}
            onClick={() => suggested !== null && onAccept(suggested)}
          >
            {t("accept")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
