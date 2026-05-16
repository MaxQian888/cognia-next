/**
 * A2UI App Builder Type Definitions
 * Props for app card, detail dialog, gallery, quick builder, and academic components
 */

import type { A2UIUserAction, A2UIDataModelChange } from "@/types/artifact/a2ui"
import type { A2UIAppInstance } from "@/hooks/a2ui/app-builder/types"
import type { A2UIAppTemplate } from "@/lib/a2ui/templates"
import type { PaperAnalysisType } from "@/types/academic"
import type { ViewMode } from "@/hooks/a2ui/use-app-gallery-filter"

/**
 * Props for the AppCard component
 */
export interface AppCardProps {
  app: A2UIAppInstance
  template?: A2UIAppTemplate
  isSelected?: boolean
  showThumbnail?: boolean
  showStats?: boolean
  showDescription?: boolean
  compact?: boolean
  onSelect?: (appId: string) => void
  onOpen?: (appId: string) => void
  onRename?: (app: A2UIAppInstance) => void
  onDuplicate?: (appId: string) => void
  onDelete?: (appId: string) => void
  onReset?: (appId: string) => void
  onShare?: (appId: string) => void
  onViewDetails?: (app: A2UIAppInstance) => void
  onThumbnailGenerated?: (appId: string, thumbnail: string) => void
  className?: string
}

/**
 * Props for the AppDetailDialog component
 */
export interface AppDetailDialogProps {
  app: A2UIAppInstance | null
  template?: A2UIAppTemplate
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave?: (appId: string, metadata: Partial<A2UIAppInstance>) => void
  onGenerateThumbnail?: (appId: string) => void
  onPreparePublish?: (appId: string) => { valid: boolean; missing: string[] }
  className?: string
}

/**
 * Props for the AppGallery component
 */
export interface AppGalleryProps {
  className?: string
  onAction?: (action: A2UIUserAction) => void
  onDataChange?: (change: A2UIDataModelChange) => void
  onAppOpen?: (appId: string) => void
  showPreview?: boolean
  showThumbnails?: boolean
  columns?: 1 | 2 | 3 | 4
  defaultViewMode?: ViewMode
}

/**
 * Tab values for QuickAppBuilder
 */
export type TabValue = "flash" | "templates" | "my-apps"

/**
 * Props for the QuickAppBuilder component
 */
export interface QuickAppBuilderProps {
  className?: string
  onAction?: (action: A2UIUserAction) => void
  onDataChange?: (change: A2UIDataModelChange) => void
  onAppSelect?: (appId: string) => void
}

/**
 * Props for the QuickAppCard sub-component
 */
export interface QuickAppCardProps {
  app: A2UIAppInstance
  template: A2UIAppTemplate | undefined
  isActive: boolean
  viewMode: "grid" | "list"
  onSelect: (appId: string) => void
  onDuplicate: (appId: string) => void
  onDownload: (appId: string) => void
  onDelete: (appId: string) => void
  onCopyToClipboard: (appId: string, format: "json" | "code" | "url") => Promise<boolean>
  onNativeShare: (appId: string) => Promise<void>
  onSocialShare: (appId: string, platform: string) => void
}

/**
 * Props for the FlashAppTab sub-component
 */
export interface FlashAppTabProps {
  onGenerate: (prompt: string) => Promise<void>
}

/**
 * Props for the AcademicAnalysisPanel component
 */
export interface AcademicAnalysisPanelProps {
  paperTitle: string
  paperAbstract?: string
  analysisType: PaperAnalysisType
  analysisContent: string
  suggestedQuestions?: string[]
  relatedTopics?: string[]
  isLoading?: boolean
  onAnalysisTypeChange?: (type: PaperAnalysisType) => void
  onRegenerate?: () => void
  onAskFollowUp?: (question: string) => void
  onCopy?: (content: string) => void
  className?: string
}
