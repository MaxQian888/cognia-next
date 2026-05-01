/**
 * A2UI Hooks
 * React hooks for A2UI app building and management
 */

export { useA2UIAppBuilder, type A2UIAppInstance, type A2UIAppTemplate } from "./use-app-builder"
export { useA2UI } from "./use-a2ui"

// Context hooks (extracted from components/a2ui/a2ui-context.tsx)
export {
  useA2UIActions,
  useA2UIData,
  useA2UIContext,
  useA2UIComponent,
  useA2UIBinding,
  useA2UIVisibility,
  useA2UIDisabled,
  A2UIActionsCtx,
  A2UIDataCtx,
} from "./use-a2ui-context"
export {
  useA2UIDataModel,
  useA2UIBoundValue,
  useA2UIWatchPaths,
  useA2UIFormField,
} from "./use-a2ui-data-model"

// Form hooks
export {
  useA2UIForm,
  type FormField,
  type FormState,
  type ValidationRule,
  type UseA2UIFormOptions,
} from "./use-a2ui-form"

// Gallery filter hook
export {
  useAppGalleryFilter,
  CATEGORY_KEYS,
  CATEGORY_I18N_MAP,
  type ViewMode,
  type SortField,
  type SortOrder,
} from "./use-app-gallery-filter"

// Keyboard navigation hooks
export {
  useA2UIKeyboard,
  useA2UIFocusTrap,
  useA2UIListNavigation,
  type KeyboardNavigationOptions,
} from "./use-a2ui-keyboard"

// Bridge diagnostics
export { useBridgeHealth, type BridgeHealth } from "./use-bridge-health"
