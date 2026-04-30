"use client"

import { useTranslations } from "next-intl"
import { FileCode, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

export function CanvasEmptyState() {
  const t = useTranslations("canvas.empty")
  const create = useArtifactStore((s) => s.createCanvasDocument)
  const setActive = useArtifactStore((s) => s.setActiveCanvas)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="rounded-full bg-primary/10 p-3 text-primary">
        <FileCode className="size-6" />
      </div>
      <div>
        <h2 className="text-lg font-semibold">{t("title", { default: "Welcome to Canvas" })}</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {t("subtitle", {
            default:
              "A Monaco-powered editor with AI actions, version history, and inline suggestions.",
          })}
        </p>
      </div>
      <Button
        onClick={() => {
          const id = create({
            title: "Untitled",
            content: "",
            language: "markdown",
            type: "text",
          })
          setActive(id)
        }}
        className="gap-2"
      >
        <Sparkles className="size-4" />
        {t("cta", { default: "Create your first document" })}
      </Button>
    </div>
  )
}
