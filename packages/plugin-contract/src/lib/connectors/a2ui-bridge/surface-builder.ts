/**
 * The plugin contract's share of `lib/connectors/a2ui-bridge/surface-builder.ts`, which re-exports these.
 */
import type {
  A2UIAlertComponent,
  A2UIBadgeComponent,
  A2UIButtonComponent,
  A2UICardComponent,
  A2UIColumnComponent,
  A2UIComponent,
  A2UIDividerComponent,
  A2UIImageComponent,
  A2UILinkComponent,
  A2UIListComponent,
  A2UIPathValue,
  A2UIRowComponent,
  A2UISelectComponent,
  A2UISelectOption,
  A2UISurfaceType,
  A2UITextComponent,
  A2UITextFieldComponent,
} from "../../../types/a2ui/schema"
import type { A2UIMessageSegment, A2UISegmentContent } from "../../../types/connectors/segment"
import type { ConversationReference, OutboundRequest } from "../../../types/connectors"

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

// ───────────────────────────────────────────────────────────────────────────
// Component factories — thin, typed constructors that remove the boilerplate
// of writing `{ id, component, … }` literals by hand. Each returns the
// canonical `A2UIComponent` subtype, so the output is renderer- and
// mapper-ready with no further shaping.
// ───────────────────────────────────────────────────────────────────────────

type Extra<T> = Omit<T, "id" | "component">

export const a2uiComponent = {
  text(
    id: string,
    text: A2UITextComponent["text"],
    extra: Omit<Extra<A2UITextComponent>, "text"> = {}
  ): A2UITextComponent {
    return { id, component: "Text", text, ...extra }
  },
  button(
    id: string,
    text: A2UIButtonComponent["text"],
    action: string,
    extra: Omit<Extra<A2UIButtonComponent>, "text" | "action"> = {}
  ): A2UIButtonComponent {
    return { id, component: "Button", text, action, ...extra }
  },
  card(id: string, extra: Extra<A2UICardComponent> = {}): A2UICardComponent {
    return { id, component: "Card", ...extra }
  },
  row(
    id: string,
    children: string[],
    extra: Omit<Extra<A2UIRowComponent>, "children"> = {}
  ): A2UIRowComponent {
    return { id, component: "Row", children, ...extra }
  },
  column(
    id: string,
    children: string[],
    extra: Omit<Extra<A2UIColumnComponent>, "children"> = {}
  ): A2UIColumnComponent {
    return { id, component: "Column", children, ...extra }
  },
  alert(
    id: string,
    message: A2UIAlertComponent["message"],
    extra: Omit<Extra<A2UIAlertComponent>, "message"> = {}
  ): A2UIAlertComponent {
    return { id, component: "Alert", message, ...extra }
  },
  image(
    id: string,
    src: A2UIImageComponent["src"],
    extra: Omit<Extra<A2UIImageComponent>, "src"> = {}
  ): A2UIImageComponent {
    return { id, component: "Image", src, ...extra }
  },
  link(
    id: string,
    text: A2UILinkComponent["text"],
    extra: Omit<Extra<A2UILinkComponent>, "text"> = {}
  ): A2UILinkComponent {
    return { id, component: "Link", text, ...extra }
  },
  select(
    id: string,
    value: A2UISelectComponent["value"],
    options: A2UISelectOption[] | A2UIPathValue<A2UISelectOption[]>,
    extra: Omit<Extra<A2UISelectComponent>, "value" | "options"> = {}
  ): A2UISelectComponent {
    return { id, component: "Select", value, options, ...extra }
  },
  textField(
    id: string,
    value: A2UITextFieldComponent["value"],
    extra: Omit<Extra<A2UITextFieldComponent>, "value"> = {}
  ): A2UITextFieldComponent {
    return { id, component: "TextField", value, ...extra }
  },
  list(id: string, extra: Extra<A2UIListComponent> = {}): A2UIListComponent {
    return { id, component: "List", ...extra }
  },
  divider(id: string, extra: Extra<A2UIDividerComponent> = {}): A2UIDividerComponent {
    return { id, component: "Divider", ...extra }
  },
  badge(
    id: string,
    text: A2UIBadgeComponent["text"],
    extra: Omit<Extra<A2UIBadgeComponent>, "text"> = {}
  ): A2UIBadgeComponent {
    return { id, component: "Badge", text, ...extra }
  },
}
