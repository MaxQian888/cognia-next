/**
 * The plugin contract's share of `lib/connectors/a2ui-bridge/surface-builder.ts`, which re-exports these.
 */
import type { A2UIComponent, A2UISurfaceType } from "../../../types/a2ui/schema"
import type { A2UIMessageSegment, A2UISegmentContent } from "../../../types/connectors/segment"
import type { ConversationReference, OutboundRequest } from "../../../types/connectors"
import type { a2uiComponent } from "@/lib/connectors/a2ui-bridge/surface-builder"

/** Declarative input for {@link buildA2UISurfaceContent}. */
export interface A2UISurfaceInput {
  /** Flat list of components; ids must be unique. Order is irrelevant. */
  components: A2UIComponent[]
  /**
   * Id of the root component. Defaults to `"root"` when a component with that
   * id exists, otherwise the first component in the list.
   */
  rootId?: string
  /** Initial JSON-Pointer data model backing any `{ path }` bindings. */
  dataModel?: Record<string, unknown>
  /** Surface placement hint; defaults to `"inline"`. */
  surfaceType?: A2UISurfaceType
  title?: string
  catalogId?: string
  /** Widget metadata; `widget.fallbackText` overrides the generated mirror. */
  widget?: Record<string, unknown>
}

/** Input for {@link buildA2UIOutboundRequest} — a surface plus its destination. */
export interface A2UIMessageInput extends A2UISurfaceInput {
  /** Where to deliver the message. */
  conversationRef: ConversationReference
  /** Surface id carried with the segment; defaults to a fresh uuid. */
  surfaceId?: string
  /** Optional trailing markdown appended after the surface. */
  text?: string
  /** Idempotency key for the outbound; defaults to a fresh uuid. */
  idempotencyKey?: string
}

/** The shape of the A2UI builder exposed on `ctx.connectors.a2ui`. */
export interface PluginConnectorsA2UIBuilder {
  /** Assemble + validate an id-keyed surface payload from a component list. */
  surface(input: A2UISurfaceInput): A2UISegmentContent
  /** Wrap a surface payload into a transferable segment (auto plain-text mirror). */
  segment(surfaceId: string, content: A2UISegmentContent): A2UIMessageSegment
  /** One-shot: build an `OutboundRequest` carrying one surface, ready for `send()`. */
  message(input: A2UIMessageInput): OutboundRequest
  /** Typed component constructors (text / button / card / row / column / …). */
  component: typeof a2uiComponent
}
