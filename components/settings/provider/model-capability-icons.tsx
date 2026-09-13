"use client"

/**
 * One glyph per model capability, in one fixed order, so the same capability
 * sits in the same place on every row of the model table and the catalog
 * list. Text labels wrapped and re-flowed between rows, which made a column
 * of them unscannable.
 *
 * Every glyph carries the translated capability name as its accessible name
 * and native tooltip, so the icon row reads the same to a screen reader as
 * the badge row it replaced.
 */

import {
  AudioLines,
  Binary,
  Braces,
  Brain,
  Eye,
  ImagePlus,
  Paperclip,
  Shuffle,
  Video,
  Wrench,
  Zap,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

/** Capability ids as emitted by `provider-settings` and models.dev. */
export const MODEL_CAPABILITY_ORDER = [
  "tools",
  "vision",
  "reasoning",
  "streaming",
  "structured",
  "audio",
  "video",
  "image-gen",
  "embedding",
  "attachment",
  "interleaved",
] as const

export type ModelCapabilityId = (typeof MODEL_CAPABILITY_ORDER)[number]

const ICONS: Record<ModelCapabilityId, React.ComponentType<{ className?: string }>> = {
  tools: Wrench,
  vision: Eye,
  reasoning: Brain,
  streaming: Zap,
  structured: Braces,
  audio: AudioLines,
  video: Video,
  "image-gen": ImagePlus,
  embedding: Binary,
  attachment: Paperclip,
  interleaved: Shuffle,
}

/** `providers.modelsTab.capability.*` key for an id ("image-gen" → "imageGen"). */
export const CAPABILITY_LABEL_KEY: Record<ModelCapabilityId, string> = {
  tools: "tools",
  vision: "vision",
  reasoning: "reasoning",
  streaming: "streaming",
  structured: "structured",
  audio: "audio",
  video: "video",
  "image-gen": "imageGen",
  embedding: "embedding",
  attachment: "attachment",
  interleaved: "interleaved",
}

export function isKnownCapability(id: string): id is ModelCapabilityId {
  return (MODEL_CAPABILITY_ORDER as readonly string[]).includes(id)
}

/**
 * Translated capability label. Unknown ids (a future models.dev flag) fall
 * back to the raw id rather than a missing-key marker.
 */
export function useCapabilityLabel(): (id: string) => string {
  const t = useTranslations("providers.modelsTab.capability")
  return (id: string) => (isKnownCapability(id) ? t(CAPABILITY_LABEL_KEY[id]) : id)
}

export interface ModelCapabilityIconsProps {
  /** Capability ids present on the model, in any order. */
  capabilities: readonly string[]
  className?: string
}

export function ModelCapabilityIcons({ capabilities, className }: ModelCapabilityIconsProps) {
  const label = useCapabilityLabel()
  const present = new Set(capabilities.map((c) => c.toLowerCase()))
  const items = MODEL_CAPABILITY_ORDER.filter((id) => present.has(id))
  if (items.length === 0) return null

  return (
    <span
      className={cn("inline-flex items-center gap-1", className)}
      role="list"
      data-testid="model-capability-icons"
    >
      {items.map((id) => {
        const Icon = ICONS[id]
        const name = label(id)
        return (
          <span
            key={id}
            role="listitem"
            title={name}
            aria-label={name}
            data-capability={id}
            className="inline-flex size-5 items-center justify-center rounded-sm text-foreground/80"
          >
            <Icon className="size-3.5" />
          </span>
        )
      })}
    </span>
  )
}
