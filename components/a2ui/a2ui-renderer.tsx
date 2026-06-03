"use client"

/**
 * A2UI Component Renderer
 * Renders A2UI components by mapping to registered React components
 */

import React, { useMemo, useCallback, memo, lazy, Suspense, type ComponentType } from "react"
import type { A2UIComponent, A2UIComponentProps } from "@/types/a2ui/schema"
import type { A2UIRendererProps } from "@/types/a2ui/renderer"
import { useA2UIContext, useA2UIVisibility, useA2UIDisabled } from "@/hooks/a2ui/use-a2ui-context"
import { getComponent } from "@/lib/a2ui/catalog"

// Import layout components
import { A2UIRow } from "./layout/a2ui-row"
import { A2UIColumn } from "./layout/a2ui-column"
import { A2UICard } from "./layout/a2ui-card"
import { A2UIDivider } from "./layout/a2ui-divider"
import { A2UISpacer } from "./layout/a2ui-spacer"
import { A2UIDialog } from "./layout/a2ui-dialog"
import { A2UITabs } from "./layout/a2ui-tabs"
import { A2UIAccordion } from "./layout/a2ui-accordion"
import { A2UIFallback } from "./layout/a2ui-fallback"
import { A2UIErrorBoundary } from "./a2ui-error-boundary"

// Import display components
import { A2UIText } from "./display/a2ui-text"
import { A2UIAlert } from "./display/a2ui-alert"
import { A2UIProgress } from "./display/a2ui-progress"
import { A2UIBadge } from "./display/a2ui-badge"
import { A2UIImage } from "./display/a2ui-image"
import { A2UIIcon } from "./display/a2ui-icon"
import { A2UILink } from "./display/a2ui-link"
import { A2UILoading } from "./display/a2ui-loading"
import { A2UIError } from "./display/a2ui-error"
import { A2UIEmpty } from "./display/a2ui-empty"
import { A2UIRichOutput } from "./display/a2ui-rich-output"
import { A2UIComparisonCards } from "./display/a2ui-comparison-cards"
import { A2UIWidgetStatus } from "./display/a2ui-widget-status"

// Import form components
import { A2UIButton } from "./form/a2ui-button"
import { A2UITextField } from "./form/a2ui-textfield"
import { A2UITextArea } from "./form/a2ui-textarea"
import { A2UISelect } from "./form/a2ui-select"
import { A2UICheckbox } from "./form/a2ui-checkbox"
import { A2UIRadio, A2UIRadioGroup } from "./form/a2ui-radio"
import { A2UISlider } from "./form/a2ui-slider"
import { A2UIDatePicker } from "./form/a2ui-datepicker"
import { A2UITimePicker } from "./form/a2ui-timepicker"
import { A2UIDateTimePicker } from "./form/a2ui-datetimepicker"
import { A2UIToggle } from "./form/a2ui-toggle"
import { A2UIFormGroup } from "./form/a2ui-form-group"
import { A2UISwitch } from "./form/a2ui-switch"

// Import data components (Table/List are light; Chart is lazy-loaded)
import { A2UITable } from "./data/a2ui-table"
import { A2UIList } from "./data/a2ui-list"

// Import academic adapter for withA2UIContext integration
import { A2UIAnalysisAdapter } from "./academic/a2ui-analysis-adapter"
import { A2UIStepperShell } from "./layout/a2ui-stepper-shell"
import { A2UIMockupFrame } from "./layout/a2ui-mockup-frame"

// P0 display
import { A2UISpinner } from "./display/a2ui-spinner"
import { A2UISkeleton } from "./display/a2ui-skeleton"
import { A2UIAvatar } from "./display/a2ui-avatar"
import { A2UIToast } from "./display/a2ui-toast"

// P0 overlay
import { A2UITooltip } from "./overlay/a2ui-tooltip"
import { A2UIPopover } from "./overlay/a2ui-popover"
import { A2UIHoverCard } from "./overlay/a2ui-hover-card"
import { A2UIDropdownMenu } from "./overlay/a2ui-dropdown-menu"
import { A2UIContextMenu } from "./overlay/a2ui-context-menu"

// P0 type fix + form
import { A2UICombobox } from "./form/a2ui-combobox"
import { A2UIInputOTP } from "./form/a2ui-input-otp"
import { A2UIToggleGroup } from "./form/a2ui-toggle-group"
import { A2UIButtonGroup } from "./form/a2ui-button-group"
import { A2UIInputGroup } from "./form/a2ui-input-group"

// P1 navigation
import { A2UIBreadcrumb } from "./navigation/a2ui-breadcrumb"
import { A2UICarousel } from "./navigation/a2ui-carousel"
import { A2UIDrawer } from "./navigation/a2ui-drawer"
import { A2UISheet } from "./navigation/a2ui-sheet"
import { A2UIScrollArea } from "./navigation/a2ui-scroll-area"
import { A2UIPagination } from "./navigation/a2ui-pagination"
import { A2UISidebar } from "./navigation/a2ui-sidebar"

// P1 layout
import { A2UICollapsible } from "./layout/a2ui-collapsible"

// Lazy-load heavy components (recharts ~200KB, motion/react)
const A2UIChart = lazy(() => import("./data/a2ui-chart").then((m) => ({ default: m.A2UIChart })))
const A2UIAnimation = lazy(() =>
  import("./display/a2ui-animation").then((m) => ({ default: m.A2UIAnimation }))
)
const A2UIInteractiveGuide = lazy(() =>
  import("./display/a2ui-interactive-guide").then((m) => ({ default: m.A2UIInteractiveGuide }))
)

/**
 * Component registry for built-in components
 * Using Map for O(1) lookups without prototype chain overhead
 */
type A2UIComponentType = React.ComponentType<A2UIComponentProps>
const builtInComponents = new Map<string, A2UIComponentType>([
  // Layout components
  ["Row", A2UIRow as A2UIComponentType],
  ["Column", A2UIColumn as A2UIComponentType],
  ["Card", A2UICard as A2UIComponentType],
  ["Divider", A2UIDivider as A2UIComponentType],
  ["Spacer", A2UISpacer as A2UIComponentType],
  ["Dialog", A2UIDialog as A2UIComponentType],
  ["Tabs", A2UITabs as A2UIComponentType],
  ["Accordion", A2UIAccordion as A2UIComponentType],
  ["StepperShell", A2UIStepperShell as A2UIComponentType],
  ["MockupFrame", A2UIMockupFrame as A2UIComponentType],
  // Text and display components
  ["Text", A2UIText as A2UIComponentType],
  ["Image", A2UIImage as A2UIComponentType],
  ["Icon", A2UIIcon as A2UIComponentType],
  ["Link", A2UILink as A2UIComponentType],
  ["Badge", A2UIBadge as A2UIComponentType],
  ["Alert", A2UIAlert as A2UIComponentType],
  ["Progress", A2UIProgress as A2UIComponentType],
  ["Loading", A2UILoading as A2UIComponentType],
  ["Error", A2UIError as unknown as A2UIComponentType],
  ["Empty", A2UIEmpty as A2UIComponentType],
  ["RichOutput", A2UIRichOutput as A2UIComponentType],
  ["ComparisonCards", A2UIComparisonCards as A2UIComponentType],
  ["WidgetStatus", A2UIWidgetStatus as A2UIComponentType],
  // Form components
  ["Button", A2UIButton as A2UIComponentType],
  ["TextField", A2UITextField as A2UIComponentType],
  ["TextArea", A2UITextArea as A2UIComponentType],
  ["Select", A2UISelect as A2UIComponentType],
  ["Checkbox", A2UICheckbox as A2UIComponentType],
  ["Radio", A2UIRadio as A2UIComponentType],
  ["RadioGroup", A2UIRadioGroup as A2UIComponentType],
  ["Slider", A2UISlider as A2UIComponentType],
  ["DatePicker", A2UIDatePicker as A2UIComponentType],
  ["TimePicker", A2UITimePicker as A2UIComponentType],
  ["DateTimePicker", A2UIDateTimePicker as A2UIComponentType],
  ["Toggle", A2UIToggle as A2UIComponentType],
  ["FormGroup", A2UIFormGroup as unknown as A2UIComponentType],
  ["Switch", A2UISwitch as unknown as A2UIComponentType],
  // Data display components
  ["Chart", A2UIChart as A2UIComponentType],
  ["Table", A2UITable as A2UIComponentType],
  ["List", A2UIList as A2UIComponentType],
  // Legacy "DataExplorer" surfaces are migrated to "Table" at store ingestion
  // (see migrateLegacyComponent in stores/a2ui/a2ui-store.ts).
  // Animation and interactive components
  ["Animation", A2UIAnimation as A2UIComponentType],
  ["InteractiveGuide", A2UIInteractiveGuide as A2UIComponentType],
  // Academic components (wrapped with withA2UIContext bridge)
  ["AcademicAnalysis", withA2UIContext(A2UIAnalysisAdapter) as unknown as A2UIComponentType],
  // P0 display
  ["Avatar", A2UIAvatar as A2UIComponentType],
  ["Skeleton", A2UISkeleton as A2UIComponentType],
  ["Spinner", A2UISpinner as A2UIComponentType],
  ["Toast", A2UIToast as unknown as A2UIComponentType],
  // P0 overlay
  ["Tooltip", A2UITooltip as unknown as A2UIComponentType],
  ["Popover", A2UIPopover as unknown as A2UIComponentType],
  ["HoverCard", A2UIHoverCard as unknown as A2UIComponentType],
  ["DropdownMenu", A2UIDropdownMenu as unknown as A2UIComponentType],
  ["ContextMenu", A2UIContextMenu as unknown as A2UIComponentType],
  // P1 form
  ["Combobox", A2UICombobox as unknown as A2UIComponentType],
  ["InputOTP", A2UIInputOTP as unknown as A2UIComponentType],
  ["ToggleGroup", A2UIToggleGroup as unknown as A2UIComponentType],
  ["ButtonGroup", A2UIButtonGroup as unknown as A2UIComponentType],
  ["InputGroup", A2UIInputGroup as unknown as A2UIComponentType],
  // P1 navigation
  ["Breadcrumb", A2UIBreadcrumb as unknown as A2UIComponentType],
  ["Carousel", A2UICarousel as unknown as A2UIComponentType],
  ["Drawer", A2UIDrawer as unknown as A2UIComponentType],
  ["Sheet", A2UISheet as unknown as A2UIComponentType],
  ["ScrollArea", A2UIScrollArea as unknown as A2UIComponentType],
  ["Pagination", A2UIPagination as unknown as A2UIComponentType],
  ["Sidebar", A2UISidebar as unknown as A2UIComponentType],
  // P1 layout
  ["Collapsible", A2UICollapsible as unknown as A2UIComponentType],
])

/**
 * Resolve the React component for a given A2UI component type.
 * Declared at module level so the reference is never "created during render".
 */
function resolveA2UIComponent(componentType: string, catalogId?: string): A2UIComponentType {
  return (
    builtInComponents.get(componentType) ||
    getComponent(componentType, catalogId)?.component ||
    (A2UIFallback as A2UIComponentType)
  )
}

/**
 * A2UI Component Renderer
 * Looks up the appropriate React component and renders it
 */
export const A2UIRenderer = memo(function A2UIRenderer({
  component,
  className,
}: A2UIRendererProps) {
  const context = useA2UIContext()
  const { surfaceId, dataModel, emitAction, setDataValue, renderChild, catalog } = context

  // Check visibility
  const isVisible = useA2UIVisibility(component.visible)
  const isDisabled = useA2UIDisabled(component.disabled)

  // Stable onAction callback (must be before early return to satisfy hooks rules)
  const onAction = useCallback(
    (action: string, data?: Record<string, unknown>) => {
      emitAction(action, component.id, data)
    },
    [emitAction, component.id]
  )

  // Build props for the component (must be before early return to satisfy hooks rules)
  const componentProps: A2UIComponentProps = useMemo(
    () => ({
      component: {
        ...component,
        disabled: isDisabled ? true : component.disabled,
        className: className || component.className,
      },
      surfaceId,
      dataModel,
      onAction,
      onDataChange: setDataValue,
      renderChild,
    }),
    [component, isDisabled, className, surfaceId, dataModel, onAction, setDataValue, renderChild]
  )

  // Don't render if not visible
  if (!isVisible) {
    return null
  }

  // Lazy-loaded component types that need Suspense wrapper
  const isLazy =
    component.component === "Chart" ||
    component.component === "Animation" ||
    component.component === "InteractiveGuide"

  // Use createElement instead of JSX to avoid React 19 compiler rule
  // "Cannot create components during render" — the rule only flags JSX
  // element types from local variables, not createElement calls.
  const resolved = resolveA2UIComponent(component.component, catalog?.id)
  const element = React.createElement(resolved, componentProps)

  return (
    <A2UIErrorBoundary componentType={component.component} componentId={component.id}>
      {isLazy ? (
        <Suspense fallback={<div className="animate-pulse h-8 bg-muted rounded" />}>
          {element}
        </Suspense>
      ) : (
        element
      )}
    </A2UIErrorBoundary>
  )
})

/**
 * HOC to wrap a component with A2UI context access
 */
export function withA2UIContext<P extends A2UIComponentProps>(
  WrappedComponent: ComponentType<P>
): ComponentType<Omit<P, keyof A2UIComponentProps> & { component: A2UIComponent }> {
  return function A2UIContextWrapper(
    props: Omit<P, keyof A2UIComponentProps> & { component: A2UIComponent }
  ) {
    const { surfaceId, dataModel, emitAction, setDataValue, renderChild } = useA2UIContext()

    const onAction = useCallback(
      (action: string, data?: Record<string, unknown>) => {
        emitAction(action, props.component.id, data)
      },
      [emitAction, props.component.id]
    )

    const componentProps = {
      ...props,
      surfaceId,
      dataModel,
      onAction,
      onDataChange: setDataValue,
      renderChild,
    } as P

    return <WrappedComponent {...componentProps} />
  }
}

/**
 * Register a component for use in A2UI surfaces
 * This is called at module load time for built-in components
 * and can be called dynamically for custom components
 */
export function registerBuiltInComponent(
  type: string,
  component: React.ComponentType<A2UIComponentProps>
): void {
  builtInComponents.set(type, component)
}

/**
 * Check if a component type is registered
 */
export function isComponentRegistered(type: string): boolean {
  return builtInComponents.has(type) || getComponent(type) !== undefined
}

/**
 * Get all registered component types
 */
export function getRegisteredComponentTypes(): string[] {
  return [...builtInComponents.keys()]
}
