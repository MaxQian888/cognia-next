"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  CodeIcon,
  FileTextIcon,
  FolderTreeIcon,
  PlusIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

interface SampleId {
  id: "explore" | "review" | "draft" | "tests"
  icon: LucideIcon
}

const SAMPLE_IDS: SampleId[] = [
  { id: "explore", icon: FolderTreeIcon },
  { id: "review", icon: CodeIcon },
  { id: "draft", icon: FileTextIcon },
  { id: "tests", icon: TerminalIcon },
]

interface Props {
  onCreate: () => void
  onUseSample: (prompt: string) => void
  /** When `inline` is true, render without the full-screen frame. */
  variant?: "fullscreen" | "inline"
}

export function EmptyChatState({ onCreate, onUseSample, variant = "fullscreen" }: Props) {
  const t = useTranslations("chat.empty")
  return (
    <div
      className={
        variant === "fullscreen"
          ? "flex flex-1 flex-col items-center justify-center gap-6 p-8"
          : "flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto p-8"
      }
    >
      <div className="flex max-w-2xl flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <SparklesIcon className="size-6" />
        </div>
        <h2 className="text-2xl font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <div className="grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
        {SAMPLE_IDS.map(({ id, icon: Icon }) => {
          const title = t(`samples.${id}Title`)
          const prompt = t(`samples.${id}Prompt`)
          return (
            <Card
              key={id}
              role="button"
              tabIndex={0}
              onClick={() => onUseSample(prompt)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onUseSample(prompt)
                }
              }}
              className="cursor-pointer p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="mb-2 flex items-center gap-2">
                <Icon className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">{title}</span>
              </div>
              <p className="line-clamp-2 text-xs text-muted-foreground">{prompt}</p>
            </Card>
          )
        })}
      </div>

      {variant === "fullscreen" && (
        <Button onClick={onCreate} variant="outline" className="gap-2">
          <PlusIcon className="size-4" />
          {t("newChat")}
        </Button>
      )}
    </div>
  )
}
