"use client"

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

interface SamplePrompt {
  icon: LucideIcon
  title: string
  prompt: string
}

const SAMPLES: SamplePrompt[] = [
  {
    icon: FolderTreeIcon,
    title: "Explore the project",
    prompt:
      "List the top-level files in the working directory and summarize what this project does in 3 sentences.",
  },
  {
    icon: CodeIcon,
    title: "Review recent changes",
    prompt:
      "Run `git diff HEAD~3..HEAD` and tell me what's changed and whether anything looks risky.",
  },
  {
    icon: FileTextIcon,
    title: "Draft a commit message",
    prompt:
      "Look at the staged changes (`git diff --cached`) and propose a conventional-commits message.",
  },
  {
    icon: TerminalIcon,
    title: "Run tests and triage",
    prompt:
      "Run the project's tests. If anything fails, list each failure with one-sentence root-cause hypotheses.",
  },
]

interface Props {
  onCreate: () => void
  onUseSample: (prompt: string) => void
  /** When `inline` is true, render without the full-screen frame. */
  variant?: "fullscreen" | "inline"
}

export function EmptyChatState({ onCreate, onUseSample, variant = "fullscreen" }: Props) {
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
        <h2 className="text-2xl font-semibold">How can Claude help?</h2>
        <p className="text-sm text-muted-foreground">
          Ask anything, or start with one of these. Drop images into the composer to include them in
          your prompt.
        </p>
      </div>

      <div className="grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
        {SAMPLES.map(({ icon: Icon, title, prompt }) => (
          <Card
            key={title}
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
        ))}
      </div>

      {variant === "fullscreen" && (
        <Button onClick={onCreate} variant="outline" className="gap-2">
          <PlusIcon className="size-4" />
          New chat
        </Button>
      )}
    </div>
  )
}
