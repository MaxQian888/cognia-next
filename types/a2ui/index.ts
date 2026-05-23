/**
 * A2UI Type Definitions
 * Centralized types for the A2UI module
 */

// Core protocol schema (A2UI v0.9): surfaces, components, messages, catalog
export type * from "./schema"
export { isPathValue } from "./schema"

// Context types
export type {
  A2UIActionsContextValue,
  A2UIDataContextValue,
  A2UIContextValue,
  A2UIProviderProps,
} from "./context"

// Renderer & surface types
export type {
  A2UIRendererProps,
  A2UISurfaceContainerProps,
  A2UIMessageRendererProps,
  A2UIToolOutputProps,
  A2UIStructuredOutputProps,
  A2UIErrorBoundaryProps,
  A2UIErrorBoundaryState,
  DeleteConfirmDialogProps,
} from "./renderer"

// Animation types
export type { A2UIAnimationType, AnimationDirection, A2UIAnimationComponentDef } from "./animation"

// Interactive guide types
export type {
  A2UIGuideStep,
  A2UIInteractiveGuideComponentDef,
  StepIndicatorProps,
} from "./interactive-guide"

// App builder types
export type {
  AppCardProps,
  AppDetailDialogProps,
  AppGalleryProps,
  TabValue,
  QuickAppBuilderProps,
  QuickAppCardProps,
  FlashAppTabProps,
  AcademicAnalysisPanelProps,
} from "./app"
