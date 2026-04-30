/**
 * useArtifactDetection - Hook to detect and extract artifacts from AI responses
 *
 * Delegates to centralized utilities in @/lib/artifacts and
 * @/lib/ai/generation/artifact-detector to avoid duplicate detection logic.
 */

import { useMemo } from "react"
import type { ArtifactType, ArtifactLanguage } from "@/types"
import {
  mapToArtifactLanguage as centralMapToArtifactLanguage,
  generateArtifactTitle,
} from "@/lib/artifacts"
import {
  detectArtifactType as centralDetectArtifactType,
  detectArtifacts,
  DEFAULT_DETECTION_CONFIG,
  extractCodeBlocks,
} from "@/lib/ai/generation/artifact-detector"

export interface DetectedArtifact {
  type: ArtifactType
  language?: ArtifactLanguage
  content: string
  title: string
  startIndex: number
  endIndex: number
}

interface UseArtifactDetectionOptions {
  enabled?: boolean
  minCodeLength?: number
}

/**
 * Hook to detect artifacts in text content
 */
export function useArtifactDetection(
  content: string,
  options: UseArtifactDetectionOptions = {}
): DetectedArtifact[] {
  const { enabled = true, minCodeLength = 50 } = options

  const artifacts = useMemo(() => {
    if (!enabled || !content) return []

    const pipelineArtifacts: DetectedArtifact[] = detectArtifacts(content, {
      ...DEFAULT_DETECTION_CONFIG,
      minLines: 1,
    })
      .filter((artifact) => artifact.type === "math" || artifact.content.length >= minCodeLength)
      .map(
        (artifact): DetectedArtifact => ({
          type: artifact.type,
          language: artifact.language as ArtifactLanguage | undefined,
          content: artifact.content,
          title: artifact.title,
          startIndex: artifact.startIndex,
          endIndex: artifact.endIndex,
        })
      )

    const fallbackArtifacts: DetectedArtifact[] = extractCodeBlocks(content)
      .map((block): DetectedArtifact | null => {
        const trimmedContent = block.code

        if (trimmedContent.length < minCodeLength) {
          return null
        }

        const { type } = centralDetectArtifactType(trimmedContent, block.language)
        const language = centralMapToArtifactLanguage(block.language)

        return {
          type,
          language: language || undefined,
          content: trimmedContent,
          title: generateArtifactTitle(trimmedContent, type, block.language),
          startIndex: block.startIndex,
          endIndex: block.endIndex,
        }
      })
      .filter((artifact): artifact is DetectedArtifact => artifact !== null)
      .filter(
        (artifact) =>
          !pipelineArtifacts.some(
            (existing) =>
              existing.startIndex === artifact.startIndex && existing.endIndex === artifact.endIndex
          )
      )

    return [...pipelineArtifacts, ...fallbackArtifacts]
  }, [content, enabled, minCodeLength])

  return artifacts
}

/**
 * Utility function to detect artifact type from language string
 */
export function detectArtifactType(language?: string, content?: string): ArtifactType {
  if (!language) return "code"
  const { type } = centralDetectArtifactType(content || "", language)
  return type
}

/**
 * Utility function to map language to ArtifactLanguage
 */
export const mapToArtifactLanguage = centralMapToArtifactLanguage

export default useArtifactDetection
