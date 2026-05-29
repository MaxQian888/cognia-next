/**
 * A2UI Renderer & Surface Type Definitions
 * Props for renderer, surface, message-renderer, tool-output, and error boundary components
 */

import type React from "react"
import type {
  A2UIComponent,
  A2UISurfaceProps,
  A2UIUserAction,
  A2UIDataModelChange,
  A2UIServerMessage,
} from "@/types/artifact/a2ui"

/**
 * Props for the A2UI component renderer
 */
export interface A2UIRendererProps {
  component: A2UIComponent
  className?: string
}

/**
 * Props for the A2UI surface container (extends base surface props)
 */
export interface A2UISurfaceContainerProps extends A2UISurfaceProps {
  showLoading?: boolean
  loadingText?: string
  /** Render the surface read-only: user actions are inert (no store mutations). */
  readOnly?: boolean
}

/**
 * Props for the A2UI message renderer
 */
export interface A2UIMessageRendererProps {
  content: string
  messageId: string
  className?: string
  textRenderer?: (text: string) => React.ReactNode
  onAction?: (action: A2UIUserAction) => void
  onDataChange?: (change: A2UIDataModelChange) => void
}

/**
 * Props for the A2UI tool output renderer
 */
export interface A2UIToolOutputProps {
  toolId: string
  toolName: string
  output: unknown
  className?: string
  onAction?: (action: A2UIUserAction) => void
  onDataChange?: (change: A2UIDataModelChange) => void
}

/**
 * Props for the generic A2UI structured output wrapper
 */
export interface A2UIStructuredOutputProps {
  id: string
  messages: A2UIServerMessage[]
  title?: string
  className?: string
  onAction?: (action: A2UIUserAction) => void
  onDataChange?: (change: A2UIDataModelChange) => void
}

/**
 * Props for A2UI component error boundary
 */
export interface A2UIErrorBoundaryProps {
  componentType: string
  componentId: string
  children: React.ReactNode
}

/**
 * State for A2UI component error boundary
 */
export interface A2UIErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * Props for shared delete confirmation dialog
 */
export interface DeleteConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  titleKey?: string
  descriptionKey?: string
}
