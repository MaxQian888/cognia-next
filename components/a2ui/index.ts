/**
 * A2UI Components
 * React components for rendering A2UI surfaces
 */

// Context
export {
  A2UIProvider,
  useA2UIActions,
  useA2UIData,
  useA2UIContext,
  useA2UIComponent,
  useA2UIBinding,
  useA2UIVisibility,
  useA2UIDisabled,
} from "./a2ui-context"

// Surface
export { A2UISurface, A2UIInlineSurface, A2UIDialogSurface } from "./a2ui-surface"
export type { A2UISurfaceContainerProps } from "@/types/a2ui/renderer"

// Renderer
export {
  A2UIRenderer,
  withA2UIContext,
  registerBuiltInComponent,
  isComponentRegistered,
  getRegisteredComponentTypes,
} from "./a2ui-renderer"
export { A2UIChildRenderer } from "./a2ui-child-renderer"

// Error Boundary
export { A2UIErrorBoundary } from "./a2ui-error-boundary"

// Layout components
export {
  A2UIFallback,
  A2UIRow,
  A2UIColumn,
  A2UICard,
  A2UIDivider,
  A2UISpacer,
  A2UIDialog,
  A2UITabs,
  A2UIAccordion,
} from "./layout"

// Display components
export {
  A2UIText,
  A2UIImage,
  A2UIIcon,
  A2UILink,
  A2UIBadge,
  A2UIAlert,
  A2UIProgress,
  A2UILoading,
  A2UIError,
  A2UIEmpty,
  A2UIRichOutput,
  A2UIComparisonCards,
  A2UIWidgetStatus,
  type A2UILoadingComponent,
  type A2UIErrorComponent,
  type A2UIEmptyComponent,
} from "./display"

// Form components
export {
  A2UIButton,
  A2UITextField,
  A2UITextArea,
  A2UISelect,
  A2UICheckbox,
  A2UIRadio,
  A2UIRadioGroup,
  A2UISlider,
  A2UIDatePicker,
  A2UITimePicker,
  A2UIDateTimePicker,
  A2UIFormGroup,
  A2UISwitch,
  type A2UIFormGroupComponent,
  type A2UISwitchComponent,
  A2UIToggle,
} from "./form"

// Data display components
export { A2UIChart, A2UITable, A2UIList } from "./data"

// Chat and tool integration
export {
  A2UIMessageRenderer,
  hasA2UIContent,
  useA2UIMessageIntegration,
} from "./a2ui-message-renderer"

export { A2UIToolOutput, A2UIStructuredOutput, hasA2UIToolOutput } from "./a2ui-tool-output"

// Academic components
export { AcademicPaperCard, AcademicSearchResults, AcademicAnalysisPanel } from "./academic"

// App Builder components
export { QuickAppBuilder } from "./quick-app-builder"
export { AppGallery } from "./app-gallery"
export { AppCard, type AppCardProps } from "./a2ui-app-card"
export { AppDetailDialog, type AppDetailDialogProps } from "./app-detail-dialog"

// Workspace components
export { A2UIWorkspace } from "./workspace/a2ui-workspace"
export { A2UIToolbar } from "./workspace/a2ui-toolbar"
export { ComponentTreePanel } from "./workspace/component-tree-panel"
export { PropertyInspectorPanel } from "./workspace/property-inspector-panel"
export { DataModelPanel } from "./workspace/data-model-panel"
export { A2UIErrorPanel } from "./workspace/a2ui-error-panel"
export { VersionHistoryPanel } from "./workspace/version-history-panel"
export { A2UIWorkspaceProvider, useWorkspaceContext } from "./workspace/a2ui-workspace-context"

// Hooks (re-exported from centralized hooks)
export {
  useA2UIForm,
  useA2UIKeyboard,
  useA2UIFocusTrap,
  useA2UIListNavigation,
  type FormField,
  type FormState,
  type ValidationRule,
  type UseA2UIFormOptions,
  type KeyboardNavigationOptions,
} from "@/hooks/a2ui"
