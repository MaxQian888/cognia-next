/**
 * Minimal A2UI artifact stubs.
 *
 * Cognia ships an "Agent-to-UI" rendering layer (a2ui) for dynamic
 * generative UIs in chat. cognia-next has not migrated it; the only
 * customer of these types here is the custom-mode editor's template
 * picker, which falls back gracefully when no a2ui template is set.
 */

export type A2UITemplateId = string

export interface A2UITemplate {
  id: A2UITemplateId
  name: string
  description?: string
  thumbnailUrl?: string
}

/**
 * Stub component shape referenced by `stores/agent/custom-mode-store/`.
 * Open-ended on purpose — the full a2ui rendering pipeline isn't
 * migrated yet, and Cognia's authoring helpers ship many ad-hoc
 * shapes (Container/Heading/Input/Action…). Allow any extra fields.
 */
export interface A2UIComponent {
  id: string
  /** Component kind tag (Cognia uses `component`; some shapes use `type`). */
  component?: string
  type?: string
  /** Free-form props bag. */
  props?: Record<string, unknown>
  /** Children may be component nodes OR string ids depending on shape. */
  children?: Array<A2UIComponent | string>
  /** Open-ended: any other authoring helpers attach more fields here. */
  [key: string]: unknown
}
