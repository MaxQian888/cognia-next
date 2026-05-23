/**
 * A2UI Event Handling
 * Manages user actions and data model changes from A2UI components
 */

import type {
  A2UIUserAction,
  A2UIDataModelChange,
  A2UIClientMessage,
  A2UIComponent,
} from "@/types/a2ui/schema"
import { getValueByPath, parseJsonPointer } from "@/lib/a2ui/data-model"
import { loggers } from "@/lib/logging"

const log = loggers.ui

/**
 * Event handler type for user actions
 */
export type A2UIActionHandler = (action: A2UIUserAction) => void | Promise<void>

/**
 * Event handler type for data model changes
 */
export type A2UIDataChangeHandler = (change: A2UIDataModelChange) => void | Promise<void>

/**
 * Event emitter for A2UI events
 */
export class A2UIEventEmitter {
  private actionHandlers: Set<A2UIActionHandler> = new Set()
  private dataChangeHandlers: Set<A2UIDataChangeHandler> = new Set()
  private allHandlers: Set<(event: A2UIClientMessage) => void> = new Set()
  private maxListeners = 50

  /**
   * Check listener count and warn if exceeding threshold (dev only)
   */
  private checkListenerLeak(type: string): void {
    if (process.env.NODE_ENV !== "production") {
      const count = this.listenerCount()
      if (count > this.maxListeners) {
        log.warn(
          `A2UI EventEmitter: ${count} listeners registered (max: ${this.maxListeners}). ` +
            `Possible memory leak after adding '${type}' handler. ` +
            `Ensure event subscriptions are cleaned up on component unmount.`
        )
      }
    }
  }

  /**
   * Get total number of registered listeners
   */
  listenerCount(): number {
    return this.actionHandlers.size + this.dataChangeHandlers.size + this.allHandlers.size
  }

  /**
   * Subscribe to user action events
   */
  onAction(handler: A2UIActionHandler): () => void {
    this.actionHandlers.add(handler)
    this.checkListenerLeak("action")
    return () => this.actionHandlers.delete(handler)
  }

  /**
   * Subscribe to data model change events
   */
  onDataChange(handler: A2UIDataChangeHandler): () => void {
    this.dataChangeHandlers.add(handler)
    this.checkListenerLeak("dataChange")
    return () => this.dataChangeHandlers.delete(handler)
  }

  /**
   * Subscribe to all events
   */
  onAny(handler: (event: A2UIClientMessage) => void): () => void {
    this.allHandlers.add(handler)
    this.checkListenerLeak("any")
    return () => this.allHandlers.delete(handler)
  }

  /**
   * Emit a user action event
   */
  emitAction(action: A2UIUserAction): void {
    for (const handler of this.actionHandlers) {
      try {
        handler(action)
      } catch (error) {
        log.error("A2UI: Error in action handler", error as Error)
      }
    }
    for (const handler of this.allHandlers) {
      try {
        handler(action)
      } catch (error) {
        log.error("A2UI: Error in event handler", error as Error)
      }
    }
  }

  /**
   * Emit a data model change event
   */
  emitDataChange(change: A2UIDataModelChange): void {
    for (const handler of this.dataChangeHandlers) {
      try {
        handler(change)
      } catch (error) {
        log.error("A2UI: Error in data change handler", error as Error)
      }
    }
    for (const handler of this.allHandlers) {
      try {
        handler(change)
      } catch (error) {
        log.error("A2UI: Error in event handler", error as Error)
      }
    }
  }

  /**
   * Remove all handlers
   */
  clear(): void {
    this.actionHandlers.clear()
    this.dataChangeHandlers.clear()
    this.allHandlers.clear()
  }
}

/**
 * Global event emitter instance
 */
export const globalEventEmitter = new A2UIEventEmitter()

/**
 * Create a user action payload
 */
export function createUserAction(
  surfaceId: string,
  action: string,
  componentId: string,
  data?: Record<string, unknown>
): A2UIUserAction {
  return {
    type: "userAction",
    surfaceId,
    action,
    componentId,
    data,
    timestamp: Date.now(),
  }
}

/**
 * Create a data model change payload
 */
export function createDataModelChange(
  surfaceId: string,
  path: string,
  value: unknown
): A2UIDataModelChange {
  return {
    type: "dataModelChange",
    surfaceId,
    path,
    value,
    timestamp: Date.now(),
  }
}

/**
 * Action types for common interactions
 */
export const ActionTypes = {
  // Button actions
  CLICK: "click",
  SUBMIT: "submit",
  CANCEL: "cancel",
  CONFIRM: "confirm",
  DISMISS: "dismiss",

  // Navigation actions
  NAVIGATE: "navigate",
  BACK: "back",
  NEXT: "next",
  CLOSE: "close",

  // Selection actions
  SELECT: "select",
  DESELECT: "deselect",
  TOGGLE: "toggle",

  // List actions
  ITEM_CLICK: "item_click",
  ITEM_SELECT: "item_select",
  LOAD_MORE: "load_more",
  REFRESH: "refresh",

  // Table actions
  ROW_CLICK: "row_click",
  ROW_SELECT: "row_select",
  SORT: "sort",
  FILTER: "filter",
  PAGE_CHANGE: "page_change",

  // Form actions
  FORM_SUBMIT: "form_submit",
  FORM_RESET: "form_reset",
  FIELD_CHANGE: "field_change",
  VALIDATE: "validate",

  // Chart actions
  DATA_POINT_CLICK: "data_point_click",
  LEGEND_CLICK: "legend_click",
  ZOOM: "zoom",

  // Dialog actions
  DIALOG_OPEN: "dialog_open",
  DIALOG_CLOSE: "dialog_close",
} as const

/**
 * Extract action from component definition
 */
export function getComponentAction(component: A2UIComponent): string | undefined {
  if ("action" in component) {
    return (component as { action?: string }).action
  }
  if ("clickAction" in component) {
    return (component as { clickAction?: string }).clickAction
  }
  if ("closeAction" in component) {
    return (component as { closeAction?: string }).closeAction
  }
  if ("dismissAction" in component) {
    return (component as { dismissAction?: string }).dismissAction
  }
  return undefined
}

/**
 * Build action data from component and interaction
 */
export function buildActionData(
  component: A2UIComponent,
  interactionData?: Record<string, unknown>
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    componentType: component.component,
    ...interactionData,
  }

  // Include relevant component properties
  if ("value" in component && typeof component.value !== "object") {
    data.value = component.value
  }
  if ("text" in component && typeof component.text === "string") {
    data.text = component.text
  }

  return data
}

/**
 * Format action event for AI message
 */
export function formatActionForAI(action: A2UIUserAction): string {
  const parts = [`User action: ${action.action}`]

  if (action.data) {
    const dataStr = Object.entries(action.data)
      .filter(([key]) => key !== "componentType")
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(", ")

    if (dataStr) {
      parts.push(`Data: { ${dataStr} }`)
    }
  }

  return parts.join("\n")
}

/**
 * Format data change for AI message
 */
export function formatDataChangeForAI(change: A2UIDataModelChange): string {
  return `Field updated: ${change.path} = ${JSON.stringify(change.value)}`
}

/**
 * Batch multiple events into a single AI message
 */
export function batchEventsForAI(events: A2UIClientMessage[]): string {
  if (events.length === 0) {
    return ""
  }

  if (events.length === 1) {
    const event = events[0]
    return event.type === "userAction" ? formatActionForAI(event) : formatDataChangeForAI(event)
  }

  const parts: string[] = ["Multiple form interactions:"]

  for (const event of events) {
    if (event.type === "userAction") {
      parts.push(`- ${formatActionForAI(event)}`)
    } else {
      parts.push(`- ${formatDataChangeForAI(event)}`)
    }
  }

  return parts.join("\n")
}

/**
 * Collect form data from data model for submission
 */
export function collectFormData(
  dataModel: Record<string, unknown>,
  fieldPaths: string[]
): Record<string, unknown> {
  const formData: Record<string, unknown> = {}

  for (const path of fieldPaths) {
    const segments = parseJsonPointer(path)
    const fieldName = segments[segments.length - 1] ?? path
    const current = getValueByPath(dataModel, path)

    if (current !== undefined) {
      formData[fieldName] = current
    }
  }

  return formData
}

/**
 * Validate form data before submission
 */
export interface ValidationResult {
  valid: boolean
  errors: Record<string, string>
}

export function validateFormData(
  data: Record<string, unknown>,
  rules: Record<string, { required?: boolean; pattern?: string; min?: number; max?: number }>
): ValidationResult {
  const errors: Record<string, string> = {}

  for (const [field, rule] of Object.entries(rules)) {
    const value = data[field]

    if (rule.required && (value === undefined || value === null || value === "")) {
      errors[field] = "This field is required"
      continue
    }

    if (value !== undefined && value !== null && value !== "") {
      if (rule.pattern && typeof value === "string") {
        const regex = new RegExp(rule.pattern)
        if (!regex.test(value)) {
          errors[field] = "Invalid format"
        }
      }

      if (rule.min !== undefined) {
        if (typeof value === "number" && value < rule.min) {
          errors[field] = `Must be at least ${rule.min}`
        }
        if (typeof value === "string" && value.length < rule.min) {
          errors[field] = `Must be at least ${rule.min} characters`
        }
      }

      if (rule.max !== undefined) {
        if (typeof value === "number" && value > rule.max) {
          errors[field] = `Must be at most ${rule.max}`
        }
        if (typeof value === "string" && value.length > rule.max) {
          errors[field] = `Must be at most ${rule.max} characters`
        }
      }
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  }
}
