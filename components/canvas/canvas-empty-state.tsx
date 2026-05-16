"use client"

import { useTranslations } from "next-intl"
import { FileCode, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

export function CanvasEmptyState() {
  const t = useTranslations("canvas.empty")
  const tRoot = useTranslations("canvas")
  const create = useArtifactStore((s) => s.createCanvasDocument)
  const setActive = useArtifactStore((s) => s.setActiveCanvas)
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileCode />
        </EmptyMedia>
        <EmptyTitle>{t("title", { default: "Welcome to Canvas" })}</EmptyTitle>
        <EmptyDescription>
          {t("subtitle", {
            default:
              "A Monaco-powered editor with AI actions, version history, and inline suggestions.",
          })}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          onClick={() => {
            const id = create({
              title: tRoot("untitledDefault"),
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
      </EmptyContent>
    </Empty>
  )
}
