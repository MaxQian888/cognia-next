/**
 * A2UI (Agent to UI) Type Definitions
 * Based on A2UI Protocol v0.9 specification
 * https://a2ui.org/specification/v0.9-a2ui/
 */

import type { ArtifactLanguage } from "./artifact"

// =============================================================================
// Core Types
// =============================================================================

/**
 * A2UI Surface types - containers for UI components
 */
export type A2UISurfaceType = "inline" | "dialog" | "panel" | "fullscreen"

export type A2UIWidgetHostStrategy =
  | "native"
  | "artifact-preview"
  | "sandboxed-html"
  | "lazy-runtime"

export type A2UIWidgetSizing = "auto" | "content-height" | "fixed-height"

export type A2UIWidgetTheme = "inherit" | "light" | "dark"

export type A2UIWidgetStatus = "ready" | "loading" | "fallback" | "error"

/**
 * Standard A2UI component types from the component catalog
 */
export type A2UIComponentType =
  | "Text"
  | "Button"
  | "TextField"
  | "TextArea"
  | "Select"
  | "Checkbox"
  | "Radio"
  | "RadioGroup"
  | "Slider"
  | "DatePicker"
  | "TimePicker"
  | "DateTimePicker"
  | "Card"
  | "Row"
  | "Column"
  | "List"
  | "Image"
  | "Chart"
  | "Table"
  | "Dialog"
  | "Divider"
  | "Spacer"
  | "Progress"
  | "Badge"
  | "Alert"
  | "Link"
  | "Icon"
  | "Animation"
  | "InteractiveGuide"
  | "RichOutput"
  | "Switch"
  | "Loading"
  | "Error"
  | "Empty"
  | "Animation"
  | "FormGroup"
  | "AcademicAnalysis"
  | "Avatar"
  | "Tooltip"
  | "Skeleton"
  | "Spinner"
  | "Toast"
  | "Combobox"
  | "DropdownMenu"
  | "ContextMenu"
  | "Popover"
  | "HoverCard"
  | "Breadcrumb"
  | "Carousel"
  | "Drawer"
  | "Sheet"
  | "ScrollArea"
  | "Pagination"
  | "Sidebar"
  | "InputOTP"
  | "ToggleGroup"
  | "ButtonGroup"
  | "InputGroup"
  | "Collapsible"
  | string // Allow custom component types

/**
 * Chart types supported by A2UI
 */
export type A2UIChartType = "line" | "bar" | "pie" | "area" | "scatter" | "radar" | "donut"

/**
 * Button variants
 */
export type A2UIButtonVariant =
  | "default"
  | "primary"
  | "secondary"
  | "destructive"
  | "outline"
  | "ghost"
  | "link"

/**
 * Alert variants
 */
export type A2UIAlertVariant = "default" | "info" | "success" | "warning" | "error" | "destructive"

/**
 * Text variants
 */
export type A2UITextVariant =
  | "body"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "caption"
  | "code"
  | "label"

// =============================================================================
// Data Binding Types (JSON Pointer RFC 6901)
// =============================================================================

/**
 * Value that can be either a literal or a data-bound path
 */
export interface A2UIPathValue<_T = string> {
  path: string // JSON Pointer path, e.g., "/user/name"
}

export type A2UIStringOrPath = string | A2UIPathValue<string>
export type A2UINumberOrPath = number | A2UIPathValue<number>
export type A2UIBooleanOrPath = boolean | A2UIPathValue<boolean>
export type A2UIArrayOrPath<T = unknown> = T[] | A2UIPathValue<T[]>

/**
 * Check if value is a path reference
 */
export function isPathValue<T>(value: T | A2UIPathValue<T>): value is A2UIPathValue<T> {
  return typeof value === "object" && value !== null && "path" in value
}

// =============================================================================
// Component Definitions
// =============================================================================

/**
 * Base component definition - all components extend this
 */
export interface A2UIBaseComponent {
  id: string
  component: A2UIComponentType
  weight?: number // Flex weight for Row/Column layouts
  visible?: A2UIBooleanOrPath
  disabled?: A2UIBooleanOrPath
  className?: string
  style?: Record<string, string | number>
  widget?: A2UIWidgetMetadata
}

export interface A2UIWidgetMetadata {
  hostStrategy?: A2UIWidgetHostStrategy
  sizing?: A2UIWidgetSizing
  theme?: A2UIWidgetTheme
  status?: A2UIWidgetStatus
  showChrome?: boolean
  fallbackText?: string
  minHeight?: number
}

/**
 * Text component
 */
export interface A2UITextComponent extends A2UIBaseComponent {
  component: "Text"
  text: A2UIStringOrPath
  variant?: A2UITextVariant
  color?: string
  align?: "left" | "center" | "right"
}

/**
 * Button component
 */
export interface A2UIButtonComponent extends A2UIBaseComponent {
  component: "Button"
  text: A2UIStringOrPath
  action: string // Action identifier sent in userAction
  variant?: A2UIButtonVariant
  icon?: string
  iconPosition?: "left" | "right"
  loading?: A2UIBooleanOrPath
}

/**
 * TextField component (single-line input)
 */
export interface A2UITextFieldComponent extends A2UIBaseComponent {
  component: "TextField"
  value: A2UIStringOrPath
  placeholder?: string
  label?: string
  helperText?: string
  error?: A2UIStringOrPath
  type?: "text" | "email" | "password" | "number" | "tel" | "url"
  required?: boolean
  minLength?: number
  maxLength?: number
  pattern?: string
}

/**
 * TextArea component (multi-line input)
 */
export interface A2UITextAreaComponent extends A2UIBaseComponent {
  component: "TextArea"
  value: A2UIStringOrPath
  placeholder?: string
  label?: string
  helperText?: string
  error?: A2UIStringOrPath
  rows?: number
  required?: boolean
  minLength?: number
  maxLength?: number
}

/**
 * Select/Dropdown component
 */
export interface A2UISelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface A2UISelectComponent extends A2UIBaseComponent {
  component: "Select"
  value: A2UIStringOrPath
  options: A2UISelectOption[] | A2UIPathValue<A2UISelectOption[]>
  placeholder?: string
  label?: string
  helperText?: string
  error?: A2UIStringOrPath
  required?: boolean
  multiple?: boolean
}

/**
 * Checkbox component
 */
export interface A2UICheckboxComponent extends A2UIBaseComponent {
  component: "Checkbox"
  checked: A2UIBooleanOrPath
  label?: string
  helperText?: string
}

/**
 * Radio component (single radio button)
 */
export interface A2UIRadioComponent extends A2UIBaseComponent {
  component: "Radio"
  value: string
  label?: string
  checked?: A2UIBooleanOrPath
}

/**
 * RadioGroup component
 */
export interface A2UIRadioGroupComponent extends A2UIBaseComponent {
  component: "RadioGroup"
  value: A2UIStringOrPath
  options: A2UISelectOption[]
  label?: string
  orientation?: "horizontal" | "vertical"
}

/**
 * Slider component
 */
export interface A2UISliderComponent extends A2UIBaseComponent {
  component: "Slider"
  value: A2UINumberOrPath
  min?: number
  max?: number
  step?: number
  label?: string
  showValue?: boolean
}

/**
 * DatePicker component
 */
export interface A2UIDatePickerComponent extends A2UIBaseComponent {
  component: "DatePicker"
  value: A2UIStringOrPath // ISO date string
  label?: string
  placeholder?: string
  minDate?: string
  maxDate?: string
  required?: boolean
}

/**
 * TimePicker component
 */
export interface A2UITimePickerComponent extends A2UIBaseComponent {
  component: "TimePicker"
  value: A2UIStringOrPath // HH:mm format
  label?: string
  placeholder?: string
  required?: boolean
}

/**
 * DateTimePicker component
 */
export interface A2UIDateTimePickerComponent extends A2UIBaseComponent {
  component: "DateTimePicker"
  value: A2UIStringOrPath // ISO datetime string
  label?: string
  placeholder?: string
  minDate?: string
  maxDate?: string
  required?: boolean
}

/**
 * Card component
 */
export interface A2UICardComponent extends A2UIBaseComponent {
  component: "Card"
  title?: A2UIStringOrPath
  description?: A2UIStringOrPath
  image?: A2UIStringOrPath
  children?: string[] // Child component IDs
  footer?: string[] // Footer component IDs
  clickAction?: string
}

/**
 * Row layout component
 */
export interface A2UIRowComponent extends A2UIBaseComponent {
  component: "Row"
  children: string[] // Child component IDs
  gap?: number | string
  align?: "start" | "center" | "end" | "stretch"
  justify?: "start" | "center" | "end" | "between" | "around" | "evenly"
  wrap?: boolean
}

/**
 * Column layout component
 */
export interface A2UIColumnComponent extends A2UIBaseComponent {
  component: "Column"
  children: string[] // Child component IDs
  gap?: number | string
  align?: "start" | "center" | "end" | "stretch"
}

/**
 * List component with template support
 */
export interface A2UIListTemplate {
  itemId: string // Template component ID for each item
  dataPath: string // JSON Pointer to array data
}

export interface A2UIListComponent extends A2UIBaseComponent {
  component: "List"
  items?: unknown[] | A2UIPathValue<unknown[]>
  children?: string[] // Static children OR
  template?: A2UIListTemplate // Dynamic template for data-bound lists
  emptyText?: string
  dividers?: boolean
  gap?: number | string
  ordered?: boolean
  itemClickAction?: string
}

/**
 * Image component
 */
export interface A2UIImageComponent extends A2UIBaseComponent {
  component: "Image"
  src: A2UIStringOrPath
  alt?: string
  width?: number | string
  height?: number | string
  aspectRatio?: string
  objectFit?: "contain" | "cover" | "fill" | "none"
  fallback?: string
}

/**
 * Chart component
 */
export interface A2UIChartDataPoint {
  name: string
  value: number
  [key: string]: string | number
}

export interface A2UIChartComponent extends A2UIBaseComponent {
  component: "Chart"
  chartType: A2UIChartType
  data: A2UIChartDataPoint[] | A2UIPathValue<A2UIChartDataPoint[]>
  title?: string
  xKey?: string
  yKeys?: string[]
  xAxisLabel?: string
  yAxisLabel?: string
  height?: number
  showLegend?: boolean
  showLabels?: boolean
  showGrid?: boolean
  colors?: string[]
  clickAction?: string
}

/**
 * Table component
 */
export interface A2UITableColumn {
  key: string
  header: string
  width?: number | string
  align?: "left" | "center" | "right"
  sortable?: boolean
  type?: "string" | "number" | "date" | "boolean"
  render?: (value: unknown, row: Record<string, unknown>) => React.ReactNode
}

/**
 * Table i18n labels
 */
export interface A2UITableLocale {
  empty?: string
  showing?: string // "Showing {start} to {end} of {total} entries"
  previous?: string
  next?: string
  page?: string // "Page {current} of {total}"
  selectAll?: string
  selectRow?: string
}

export interface A2UITableComponent extends A2UIBaseComponent {
  component: "Table"
  columns: A2UITableColumn[]
  data: Record<string, unknown>[] | A2UIPathValue<Record<string, unknown>[]>
  title?: string
  description?: A2UIStringOrPath
  rowKey?: string
  selectable?: boolean
  selectedRows?: A2UIArrayOrPath<string>
  selectAction?: string
  rowClickAction?: string
  sortAction?: string
  /**
   * When set, sort column lives in dataModel at this JSON Pointer path
   * instead of in local component state. Writes go through onDataChange.
   * Pairs with `sortDirectionPath` for full path-bound sort control.
   */
  sortKeyPath?: string
  sortDirectionPath?: string
  /** Extra metadata merged into emitted sortAction payloads. */
  actionMeta?: Record<string, unknown>
  pageChangeAction?: string
  emptyMessage?: string
  pageSize?: number
  pagination?: boolean
  locale?: A2UITableLocale
}

/**
 * Dialog component
 */
export interface A2UIDialogComponent extends A2UIBaseComponent {
  component: "Dialog"
  open: A2UIBooleanOrPath
  title?: A2UIStringOrPath
  description?: A2UIStringOrPath
  children: string[] // Content component IDs
  actions?: string[] // Action button component IDs
  closable?: boolean
  closeAction?: string
}

/**
 * Divider component
 */
export interface A2UIDividerComponent extends A2UIBaseComponent {
  component: "Divider"
  orientation?: "horizontal" | "vertical"
  text?: string
}

/**
 * Spacer component
 */
export interface A2UISpacerComponent extends A2UIBaseComponent {
  component: "Spacer"
  size?: number | string
}

/**
 * Progress component
 */
export interface A2UIProgressComponent extends A2UIBaseComponent {
  component: "Progress"
  value: A2UINumberOrPath
  max?: number
  label?: A2UIStringOrPath
  showValue?: boolean
  showLabel?: boolean
  variant?: "linear" | "circular"
}

/**
 * Badge component
 */
export interface A2UIBadgeComponent extends A2UIBaseComponent {
  component: "Badge"
  text: A2UIStringOrPath
  variant?: "default" | "secondary" | "destructive" | "outline"
}

/**
 * Alert component
 */
export interface A2UIAlertComponent extends A2UIBaseComponent {
  component: "Alert"
  title?: A2UIStringOrPath
  message: A2UIStringOrPath
  variant?: A2UIAlertVariant
  showIcon?: boolean
  dismissible?: boolean
  dismissAction?: string
}

/**
 * Link component
 */
export interface A2UILinkComponent extends A2UIBaseComponent {
  component: "Link"
  text: A2UIStringOrPath
  href?: string
  action?: string // Alternative to href - triggers userAction
  external?: boolean
}

/**
 * Icon component
 */
export interface A2UIIconComponent extends A2UIBaseComponent {
  component: "Icon"
  name: string // Lucide icon name
  size?: number
  color?: string
}

/**
 * Tabs component
 */
export interface A2UITabItem {
  id: string
  label: string
  children: string[] // Component IDs for tab content
  icon?: string
  disabled?: boolean
}

export interface A2UITabsComponent extends A2UIBaseComponent {
  component: "Tabs"
  tabs: A2UITabItem[]
  defaultTab?: string
  activeTab?: A2UIStringOrPath
  tabChangeAction?: string
}

/**
 * Accordion component
 */
export interface A2UIAccordionItem {
  id: string
  title: string
  children: string[] // Component IDs for accordion content
  defaultOpen?: boolean
}

export interface A2UIAccordionComponent extends A2UIBaseComponent {
  component: "Accordion"
  items: A2UIAccordionItem[]
  multiple?: boolean // Allow multiple open at once
  collapsible?: boolean
}

/**
 * Toggle component
 */
export interface A2UIToggleComponent extends A2UIBaseComponent {
  component: "Toggle"
  label?: A2UIStringOrPath
  pressed?: A2UIBooleanOrPath
  variant?: "default" | "outline"
  size?: "default" | "sm" | "lg"
  action?: string
}

export interface A2UIRichOutputItem {
  id: string
  title: string
  description?: string
  value?: string
  badge?: string
}

export interface A2UIComparisonCardItem extends A2UIRichOutputItem {
  footer?: string
}

export interface A2UIRichOutputStep {
  id: string
  title: string
  description?: string
  body?: string
}

export interface A2UIRichOutputTableColumn {
  key: string
  label: string
  numeric?: boolean
}

export interface A2UIRichOutputChartDataset {
  label: string
  data: number[]
  borderColor?: string
  backgroundColor?: string
}

export interface A2UIRichOutputChartData {
  labels: string[]
  datasets: A2UIRichOutputChartDataset[]
}

export interface A2UIRichOutputGraphNode {
  id: string
  label: string
  group?: string
}

export interface A2UIRichOutputGraphEdge {
  source: string
  target: string
  value?: number
}

export interface A2UIRichOutputPlotPoint {
  x: number
  y: number
}

export interface A2UIRichOutputComponent extends A2UIBaseComponent {
  component: "RichOutput"
  profileId: A2UIStringOrPath
  title?: A2UIStringOrPath
  description?: A2UIStringOrPath
  content?: A2UIStringOrPath
  fallbackContent?: A2UIStringOrPath
  codeLanguage?: ArtifactLanguage
  items?: A2UIArrayOrPath<A2UIRichOutputItem>
  steps?: A2UIArrayOrPath<A2UIRichOutputStep>
  currentStep?: A2UINumberOrPath
  currentStepPath?: string
  stepChangeAction?: string
  tableColumns?: A2UIRichOutputTableColumn[]
  tableRows?: A2UIArrayOrPath<Record<string, unknown>>
  sortKeyPath?: string
  sortDirectionPath?: string
  sortAction?: string
  chartData?: A2UIRichOutputChartData | A2UIPathValue<A2UIRichOutputChartData>
  networkNodes?: A2UIRichOutputGraphNode[] | A2UIPathValue<A2UIRichOutputGraphNode[]>
  networkEdges?: A2UIRichOutputGraphEdge[] | A2UIPathValue<A2UIRichOutputGraphEdge[]>
  plotPoints?: A2UIRichOutputPlotPoint[] | A2UIPathValue<A2UIRichOutputPlotPoint[]>
  simulationConfig?: Record<string, unknown> | A2UIPathValue<Record<string, unknown>>
  scenePrompt?: A2UIStringOrPath
  audioPrompt?: A2UIStringOrPath
  height?: number
  allowAdvancedProfiles?: boolean
}

export interface A2UIComparisonCardsComponent extends A2UIBaseComponent {
  component: "ComparisonCards"
  title?: A2UIStringOrPath
  description?: A2UIStringOrPath
  items: A2UIArrayOrPath<A2UIComparisonCardItem>
  itemClickAction?: string
  emptyText?: string
}

export interface A2UIStepperShellComponent extends A2UIBaseComponent {
  component: "StepperShell"
  title?: A2UIStringOrPath
  description?: A2UIStringOrPath
  steps: A2UIArrayOrPath<A2UIRichOutputStep>
  currentStep?: A2UINumberOrPath
  currentStepPath?: string
  stepChangeAction?: string
  actionMeta?: Record<string, unknown>
  previousLabel?: string
  nextLabel?: string
}

export interface A2UIMockupFrameComponent extends A2UIBaseComponent {
  component: "MockupFrame"
  title?: A2UIStringOrPath
  caption?: A2UIStringOrPath
  frameStyle?: "browser" | "mobile" | "desktop"
  children: string[]
}

export interface A2UISwitchComponent extends A2UIBaseComponent {
  component: "Switch"
  checked: A2UIBooleanOrPath
  label?: string
  description?: string
}

export interface A2UILoadingComponent extends A2UIBaseComponent {
  component: "Loading"
  text?: A2UIStringOrPath
  size?: "sm" | "md" | "lg"
}

export interface A2UIErrorComponent extends A2UIBaseComponent {
  component: "Error"
  title?: A2UIStringOrPath
  message: A2UIStringOrPath
  retryAction?: string
}

export interface A2UIEmptyComponent extends A2UIBaseComponent {
  component: "Empty"
  title?: string
  message?: string
  icon?: string
  actionLabel?: string
  action?: string
}

export interface A2UIAnimationComponent extends A2UIBaseComponent {
  component: "Animation"
  src: string
  autoplay?: boolean
  loop?: boolean
}

export interface A2UIInteractiveGuideComponent extends A2UIBaseComponent {
  component: "InteractiveGuide"
  steps: string[]
  currentStep?: A2UINumberOrPath
}

export interface A2UIAvatarComponent extends A2UIBaseComponent {
  component: "Avatar"
  src?: A2UIStringOrPath
  alt?: string
  fallback?: string
  size?: "sm" | "md" | "lg"
}

export interface A2UITooltipComponent extends A2UIBaseComponent {
  component: "Tooltip"
  text: A2UIStringOrPath
  children: string[]
  side?: "top" | "right" | "bottom" | "left"
  delayDuration?: number
}

export interface A2UISkeletonComponent extends A2UIBaseComponent {
  component: "Skeleton"
  variant?: "text" | "circular" | "rectangular"
  width?: number | string
  height?: number | string
  lines?: number
}

export interface A2UISpinnerComponent extends A2UIBaseComponent {
  component: "Spinner"
  size?: "sm" | "md" | "lg"
  label?: string
}

export interface A2UIToastComponent extends A2UIBaseComponent {
  component: "Toast"
  message: A2UIStringOrPath
  description?: A2UIStringOrPath
  variant?: "default" | "success" | "error" | "warning" | "info" | "loading"
  duration?: number
  actionLabel?: string
  action?: string
}

export interface A2UIComboboxOption {
  value: string
  label: string
  disabled?: boolean
}

export interface A2UIComboboxComponent extends A2UIBaseComponent {
  component: "Combobox"
  options: A2UIComboboxOption[] | A2UIPathValue<A2UIComboboxOption[]>
  value: A2UIStringOrPath
  placeholder?: string
  emptyText?: string
  searchPlaceholder?: string
  label?: string
}

export interface A2UIDropdownMenuItem {
  id: string
  label: string
  action?: string
  icon?: string
  disabled?: boolean
  danger?: boolean
  separator?: boolean
}

export interface A2UIDropdownMenuComponent extends A2UIBaseComponent {
  component: "DropdownMenu"
  trigger: string
  items: A2UIDropdownMenuItem[]
  label?: string
  align?: "start" | "center" | "end"
  side?: "top" | "right" | "bottom" | "left"
}

export interface A2UIContextMenuComponent extends A2UIBaseComponent {
  component: "ContextMenu"
  trigger: string
  items: A2UIDropdownMenuItem[]
  label?: string
}

export interface A2UIPopoverComponent extends A2UIBaseComponent {
  component: "Popover"
  trigger: string
  children: string[]
  align?: "start" | "center" | "end"
  side?: "top" | "right" | "bottom" | "left"
}

export interface A2UIHoverCardComponent extends A2UIBaseComponent {
  component: "HoverCard"
  trigger: string
  children: string[]
  align?: "start" | "center" | "end"
  side?: "top" | "right" | "bottom" | "left"
  openDelay?: number
}

export interface A2UIBreadcrumbItem {
  label: string
  href?: string
  current?: boolean
  ellipsis?: boolean
}

export interface A2UIBreadcrumbComponent extends A2UIBaseComponent {
  component: "Breadcrumb"
  items: A2UIBreadcrumbItem[]
}

export interface A2UICarouselComponent extends A2UIBaseComponent {
  component: "Carousel"
  children: string[]
  showControls?: boolean
  loop?: boolean
}

export interface A2UIDrawerComponent extends A2UIBaseComponent {
  component: "Drawer"
  trigger: string
  title?: A2UIStringOrPath
  description?: A2UIStringOrPath
  children: string[]
  open?: A2UIBooleanOrPath
}

export interface A2UISheetComponent extends A2UIBaseComponent {
  component: "Sheet"
  trigger: string
  title?: A2UIStringOrPath
  description?: A2UIStringOrPath
  children: string[]
  side?: "top" | "right" | "bottom" | "left"
  open?: A2UIBooleanOrPath
}

export interface A2UIScrollAreaComponent extends A2UIBaseComponent {
  component: "ScrollArea"
  children: string[]
  height?: number | string
}

export interface A2UIPaginationComponent extends A2UIBaseComponent {
  component: "Pagination"
  currentPage: A2UINumberOrPath
  totalPages: number
  siblingCount?: number
  pageChangeAction?: string
}

export interface A2UISidebarNavItem {
  id: string
  label: string
  icon?: string
  action?: string
  active?: boolean
}

export interface A2UISidebarGroup {
  id: string
  label?: string
  items: A2UISidebarNavItem[]
}

export interface A2UISidebarComponent extends A2UIBaseComponent {
  component: "Sidebar"
  groups: A2UISidebarGroup[]
  header?: string
  footer?: string
  collapsed?: boolean
  side?: "left" | "right"
}

export interface A2UIInputOTPComponent extends A2UIBaseComponent {
  component: "InputOTP"
  value: A2UIStringOrPath
  maxLength?: number
  label?: string
  disabled?: boolean
}

export interface A2UIToggleGroupOption {
  value: string
  label: string
  disabled?: boolean
}

export interface A2UIToggleGroupComponent extends A2UIBaseComponent {
  component: "ToggleGroup"
  options: A2UIToggleGroupOption[]
  value: string[] | A2UIPathValue<string[]>
  label?: string
  multiple?: boolean
  size?: "sm" | "default" | "lg"
}

export interface A2UIButtonGroupComponent extends A2UIBaseComponent {
  component: "ButtonGroup"
  children: string[]
  orientation?: "horizontal" | "vertical"
}

export interface A2UIInputGroupComponent extends A2UIBaseComponent {
  component: "InputGroup"
  children: string[]
}

export interface A2UICollapsibleComponent extends A2UIBaseComponent {
  component: "Collapsible"
  title: A2UIStringOrPath
  children: string[]
  open?: A2UIBooleanOrPath
}

export interface A2UIWidgetStatusComponent extends A2UIBaseComponent {
  component: "WidgetStatus"
  status: A2UIWidgetStatus
  title?: A2UIStringOrPath
  message: A2UIStringOrPath
  detail?: A2UIStringOrPath
  action?: string
  actionLabel?: A2UIStringOrPath
}

/**
 * Union type of all component definitions
 */
export type A2UIComponent =
  | A2UITextComponent
  | A2UIButtonComponent
  | A2UITextFieldComponent
  | A2UITextAreaComponent
  | A2UISelectComponent
  | A2UICheckboxComponent
  | A2UIRadioComponent
  | A2UIRadioGroupComponent
  | A2UISliderComponent
  | A2UIDatePickerComponent
  | A2UITimePickerComponent
  | A2UIDateTimePickerComponent
  | A2UICardComponent
  | A2UIRowComponent
  | A2UIColumnComponent
  | A2UIListComponent
  | A2UIImageComponent
  | A2UIChartComponent
  | A2UITableComponent
  | A2UIDialogComponent
  | A2UIDividerComponent
  | A2UISpacerComponent
  | A2UIProgressComponent
  | A2UIBadgeComponent
  | A2UIAlertComponent
  | A2UILinkComponent
  | A2UIIconComponent
  | A2UITabsComponent
  | A2UIAccordionComponent
  | A2UIToggleComponent
  | A2UIRichOutputComponent
  | A2UIComparisonCardsComponent
  | A2UIStepperShellComponent
  | A2UIMockupFrameComponent
  | A2UIWidgetStatusComponent
  | A2UISwitchComponent
  | A2UILoadingComponent
  | A2UIErrorComponent
  | A2UIEmptyComponent
  | A2UIAnimationComponent
  | A2UIInteractiveGuideComponent
  | A2UIAvatarComponent
  | A2UITooltipComponent
  | A2UISkeletonComponent
  | A2UISpinnerComponent
  | A2UIToastComponent
  | A2UIComboboxComponent
  | A2UIDropdownMenuComponent
  | A2UIContextMenuComponent
  | A2UIPopoverComponent
  | A2UIHoverCardComponent
  | A2UIBreadcrumbComponent
  | A2UICarouselComponent
  | A2UIDrawerComponent
  | A2UISheetComponent
  | A2UIScrollAreaComponent
  | A2UIPaginationComponent
  | A2UISidebarComponent
  | A2UIInputOTPComponent
  | A2UIToggleGroupComponent
  | A2UIButtonGroupComponent
  | A2UIInputGroupComponent
  | A2UICollapsibleComponent
  | A2UIBaseComponent // Fallback for custom components

// =============================================================================
// Message Types (Server to Client)
// =============================================================================

/**
 * Create a new surface
 */
export interface A2UICreateSurfaceMessage {
  type: "createSurface"
  surfaceId: string
  surfaceType: A2UISurfaceType
  catalogId?: string
  title?: string
  widget?: A2UIWidgetMetadata
}

/**
 * Update components on a surface
 */
export interface A2UIUpdateComponentsMessage {
  type: "updateComponents"
  surfaceId: string
  components: A2UIComponent[]
}

/**
 * Update the data model
 */
export interface A2UIUpdateDataModelMessage {
  type: "dataModelUpdate"
  surfaceId: string
  data: Record<string, unknown>
  merge?: boolean // If true, merge with existing data; if false, replace
}

/**
 * Delete a surface
 */
export interface A2UIDeleteSurfaceMessage {
  type: "deleteSurface"
  surfaceId: string
}

/**
 * Surface ready signal
 */
export interface A2UISurfaceReadyMessage {
  type: "surfaceReady"
  surfaceId: string
}

/**
 * Union of all server-to-client message types
 */
export type A2UIServerMessage =
  | A2UICreateSurfaceMessage
  | A2UIUpdateComponentsMessage
  | A2UIUpdateDataModelMessage
  | A2UIDeleteSurfaceMessage
  | A2UISurfaceReadyMessage

// =============================================================================
// Message Types (Client to Server)
// =============================================================================

/**
 * User action event - sent when user interacts with A2UI components
 */
export interface A2UIUserAction {
  type: "userAction"
  surfaceId: string
  action: string // Action identifier from component
  componentId: string
  data?: Record<string, unknown> // Additional action data
  timestamp: number
}

/**
 * Data model change event - sent when user modifies form values
 */
export interface A2UIDataModelChange {
  type: "dataModelChange"
  surfaceId: string
  path: string // JSON Pointer path that changed
  value: unknown
  timestamp: number
}

/**
 * Union of all client-to-server message types
 */
export type A2UIClientMessage = A2UIUserAction | A2UIDataModelChange

// =============================================================================
// Surface State
// =============================================================================

/**
 * Complete state of an A2UI surface
 */
export interface A2UISurface {
  id: string
  type: A2UISurfaceType
  catalogId?: string
  title?: string
  widget?: A2UIWidgetMetadata
  components: Map<string, A2UIComponent>
  dataModel: Record<string, unknown>
  rootId: string // ID of root component
  createdAt: number
  updatedAt: number
  ready: boolean
}

/**
 * A2UI surface state for store
 */
export interface A2UISurfaceState {
  id: string
  type: A2UISurfaceType
  catalogId?: string
  title?: string
  widget?: A2UIWidgetMetadata
  components: Record<string, A2UIComponent>
  dataModel: Record<string, unknown>
  rootId: string
  createdAt: number
  updatedAt: number
  ready: boolean
}

// =============================================================================
// Component Catalog
// =============================================================================

/**
 * Component catalog entry - maps A2UI type to React component
 */
export interface A2UICatalogEntry {
  type: A2UIComponentType
  component: React.ComponentType<A2UIComponentProps<A2UIComponent>>
  description?: string
  schema?: Record<string, unknown> // JSON Schema for validation
}

/**
 * Component catalog
 */
export interface A2UIComponentCatalog {
  id: string
  name: string
  version: string
  components: Record<string, A2UICatalogEntry>
}

// =============================================================================
// React Component Props
// =============================================================================

/**
 * Props passed to A2UI React components
 */
export interface A2UIComponentProps<T extends A2UIComponent = A2UIComponent> {
  component: T
  surfaceId: string
  dataModel: Record<string, unknown>
  onAction: (action: string, data?: Record<string, unknown>) => void
  onDataChange: (path: string, value: unknown) => void
  renderChild: (componentId: string) => React.ReactNode
}

/**
 * Props for A2UI surface container
 */
export interface A2UISurfaceProps {
  surfaceId: string
  className?: string
  onAction?: (action: A2UIUserAction) => void
  onDataChange?: (change: A2UIDataModelChange) => void
}

// =============================================================================
// Integration Types
// =============================================================================

/**
 * A2UI content detected in AI response
 */
export interface A2UIMessageContent {
  type: "a2ui"
  surfaceId: string
  messages: A2UIServerMessage[]
  widget?: A2UIWidgetMetadata
}

/**
 * A2UI tool output metadata
 */
export interface A2UIToolOutputMeta {
  a2ui: true
  surfaceId: string
  template?: string // Predefined template name
  widget?: A2UIWidgetMetadata
}

/**
 * Options for A2UI renderer
 */
export interface A2UIRendererOptions {
  catalog?: A2UIComponentCatalog
  theme?: "light" | "dark" | "system"
  locale?: string
  onError?: (error: Error, componentId: string) => void
}

// =============================================================================
// Backward-compat: stub template types kept from the cognia-next pre-port phase.
// `custom-mode-store` references these for its template-picker UI; the full
// `A2UIComponent` union now satisfies the open-ended shape it used to allow.
// =============================================================================

export type A2UITemplateId = string

export interface A2UITemplate {
  id: A2UITemplateId
  name: string
  description?: string
  thumbnailUrl?: string
}
