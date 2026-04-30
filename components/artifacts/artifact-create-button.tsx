"use client"

/**
 * ArtifactCreateButton - Button to create an artifact from a code block.
 *
 * cognia-next reads the active session id from `useChatStore`
 * (no `useSessionStore` here), and falls back gracefully if no session is
 * active so the button still works for ad-hoc previews.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Layers, Check, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useChatStore } from "@/stores/chat"
import type { ArtifactType } from "@/types"
import {
  generateArtifactTitle,
  enhancedDetectArtifactType,
  mapToArtifactLanguage,
} from "@/lib/artifacts"
import { MERMAID_TYPE_I18N_KEYS } from "@/lib/artifacts/constants"
import type { ArtifactTitleMessages } from "@/lib/artifacts/utils"
import { buildArtifactSourceMetadata } from "@/lib/artifacts/source-metadata"
import { detectArtifactType as detectType } from "@/hooks/chat/use-artifact-detection"

interface ArtifactCreateButtonProps {
  content: string
  language?: string
  title?: string
  messageId?: string
  className?: string
  variant?: "icon" | "button" | "dropdown"
}

/**
 * Detect artifact type from language and content
 */
function detectArtifactType(language?: string, content?: string): ArtifactType {
  const baseType = detectType(language, content)
  return enhancedDetectArtifactType(baseType, language, content)
}

export function ArtifactCreateButton({
  content,
  language,
  title,
  messageId,
  className,
  variant = "icon",
}: ArtifactCreateButtonProps) {
  const t = useTranslations("artifactCreateButton")
  const tDefaults = useTranslations("artifacts.defaultTitles")
  const tMermaid = useTranslations("artifacts.mermaidTypes")
  const [created, setCreated] = useState(false)
  const createArtifact = useArtifactStore((state) => state.createArtifact)
  const activeSessionId = useChatStore((state) => state.activeSessionId)

  const titleMessages = useMemo<ArtifactTitleMessages>(() => {
    const mermaidTypes: Partial<Record<string, string>> = {}
    for (const [regexKey, leafKey] of Object.entries(MERMAID_TYPE_I18N_KEYS)) {
      mermaidTypes[regexKey] = tMermaid(leafKey)
    }
    return {
      codeSnippet: tDefaults("codeSnippet"),
      codeWithLanguage: (language: string) => tDefaults("codeWithLanguage", { language }),
      document: tDefaults("document"),
      svgGraphic: tDefaults("svgGraphic"),
      htmlPage: tDefaults("htmlPage"),
      reactComponent: tDefaults("reactComponent"),
      mermaidDiagram: tDefaults("mermaidDiagram"),
      dataChart: tDefaults("dataChart"),
      mathExpression: tDefaults("mathExpression"),
      jupyterNotebook: tDefaults("jupyterNotebook"),
      untitled: tDefaults("untitled"),
      mermaidTypes,
    }
  }, [tDefaults, tMermaid])

  const handleCreate = (type?: ArtifactType) => {
    const sessionId = activeSessionId || "standalone"

    const detectedType = type || detectArtifactType(language, content)
    const artifactTitle =
      title || generateArtifactTitle(content, detectedType, language, titleMessages)
    const artifactLanguage = mapToArtifactLanguage(language)
    const resolvedMessageId = messageId || ""

    createArtifact({
      sessionId,
      messageId: resolvedMessageId,
      type: detectedType,
      title: artifactTitle,
      content,
      language: artifactLanguage,
      metadata: buildArtifactSourceMetadata({
        sessionId,
        messageId: resolvedMessageId,
        type: detectedType,
        content,
        language: artifactLanguage,
        sourceOrigin: "manual",
        userInitiated: true,
      }),
    })

    setCreated(true)
    setTimeout(() => setCreated(false), 2000)
  }

  if (variant === "dropdown") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className={className}>
            {created ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <Layers className="h-4 w-4" />
            )}
            <span className="ml-1">{t("createArtifact")}</span>
            <ChevronDown className="ml-1 h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => handleCreate("code")}>{t("asCode")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleCreate("react")}>{t("asReact")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleCreate("html")}>{t("asHtml")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleCreate("document")}>
            {t("asDocument")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleCreate("mermaid")}>
            {t("asMermaid")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleCreate("chart")}>{t("asChart")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleCreate("math")}>{t("asMath")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  if (variant === "button") {
    return (
      <Button size="sm" variant="ghost" className={className} onClick={() => handleCreate()}>
        {created ? <Check className="h-4 w-4 text-green-500" /> : <Layers className="h-4 w-4" />}
        <span className="ml-1">{t("createArtifact")}</span>
      </Button>
    )
  }

  // Icon variant (default)
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon" variant="ghost" className={className} onClick={() => handleCreate()}>
            {created ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <Layers className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("createArtifact")}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
