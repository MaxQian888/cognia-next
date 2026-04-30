/**
 * Artifact Icons - Centralized icon components for artifact types
 */

import {
  Code,
  FileText,
  Image as ImageIcon,
  BarChart,
  GitBranch,
  Sparkles,
  Calculator,
  BookOpen,
} from "lucide-react"
import type { ArtifactType } from "@/types"
import { ARTIFACT_TYPES } from "@/lib/artifacts"

/**
 * Get the icon component for an artifact type
 */
export function getArtifactTypeIcon(type: ArtifactType, className = "h-4 w-4") {
  const icons: Record<ArtifactType, React.ReactNode> = {
    code: <Code className={className} />,
    document: <FileText className={className} />,
    svg: <ImageIcon className={className} />,
    html: <Code className={className} />,
    react: <Sparkles className={className} />,
    mermaid: <GitBranch className={className} />,
    chart: <BarChart className={className} />,
    math: <Calculator className={className} />,
    jupyter: <BookOpen className={className} />,
  }

  return icons[type] || <Code className={className} />
}

/**
 * Artifact type icon mapping (derived from getArtifactTypeIcon to avoid duplication)
 */
export const ARTIFACT_TYPE_ICONS: Record<ArtifactType, React.ReactNode> = Object.fromEntries(
  ARTIFACT_TYPES.map((type) => [type, getArtifactTypeIcon(type)])
) as Record<ArtifactType, React.ReactNode>
