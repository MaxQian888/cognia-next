/**
 * Plugin-facing A2UI surface builder.
 *
 * Plugins that want to send rich, interactive content through a connector
 * (`ctx.connectors.send`) need an `A2UIMessageSegment` whose `content` is a
 * valid {@link A2UISegmentContent} — an **id-keyed** component graph
 * (`{components, dataModel, rootId}`). Hand-authoring that graph (keying by
 * id, wiring child references, minting a plain-text mirror) is exactly the
 * friction this module removes.
 *
 * It reuses, never re-implements, the existing bridge seams:
 *   - {@link buildA2UISegment} (`a2ui-bridge/a2ui-to-segments.ts`) wraps the
 *     content into a transferable segment and bakes the `plainTextMirror`.
 *   - The component shapes are the canonical `A2UIComponent` types from
 *     `types/a2ui/schema.ts` — the same types the renderer + every platform
 *     mapper already consume.
 *
 * Construction is pure (no side effects, no platform I/O), so the plugin API
 * exposes it ungated; the side-effecting `send()` it feeds remains gated by
 * `connectors:send`.
 */

import type { A2UIComponent } from "@/types/a2ui/schema"
import type { A2UIMessageSegment, A2UISegmentContent } from "@/types/connectors/segment"
import type { OutboundRequest } from "@/types/connectors"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import { buildA2UISegment } from "./a2ui-to-segments"
import type {
  A2UIMessageInput,
  A2UISurfaceInput,
  PluginConnectorsA2UIBuilder,
} from "@cognia/plugin-contract/lib/connectors/a2ui-bridge/surface-builder"
import { a2uiComponent } from "@cognia/plugin-contract/lib/connectors/a2ui-bridge/surface-builder"
export { a2uiComponent } from "@cognia/plugin-contract/lib/connectors/a2ui-bridge/surface-builder"
export type {
  A2UIMessageInput,
  A2UISurfaceInput,
  PluginConnectorsA2UIBuilder,
} from "@cognia/plugin-contract/lib/connectors/a2ui-bridge/surface-builder"

/** Thrown when a surface graph is malformed (bad root, dangling ref, dup id). */
export class A2UISurfaceBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "A2UISurfaceBuildError"
  }
}

/** Container fields that hold child-component-id references. */
function collectChildRefs(component: A2UIComponent): string[] {
  const refs: string[] = []
  const c = component as unknown as Record<string, unknown>
  for (const field of ["children", "footer", "actions"]) {
    const v = c[field]
    if (Array.isArray(v)) {
      for (const id of v) if (typeof id === "string") refs.push(id)
    }
  }
  // Tabs / Accordion nest their child ids inside an object array.
  for (const field of ["tabs", "items"]) {
    const v = c[field]
    if (Array.isArray(v)) {
      for (const entry of v) {
        const children = (entry as Record<string, unknown>)?.children
        if (Array.isArray(children)) {
          for (const id of children) if (typeof id === "string") refs.push(id)
        }
      }
    }
  }
  return refs
}

/**
 * Resolve and validate the root id, asserting unique ids and that every
 * child reference points at a component that exists. Throws
 * {@link A2UISurfaceBuildError} on any structural problem.
 */
export function validateA2UISurfaceComponents(
  components: A2UIComponent[],
  rootId?: string
): string {
  if (components.length === 0) {
    throw new A2UISurfaceBuildError("a surface needs at least one component")
  }

  const ids = new Set<string>()
  for (const component of components) {
    if (!component.id) {
      throw new A2UISurfaceBuildError("every component needs a non-empty id")
    }
    if (ids.has(component.id)) {
      throw new A2UISurfaceBuildError(`duplicate component id: ${component.id}`)
    }
    ids.add(component.id)
  }

  const resolvedRoot = rootId ?? (ids.has("root") ? "root" : components[0].id)
  if (!ids.has(resolvedRoot)) {
    throw new A2UISurfaceBuildError(`rootId "${resolvedRoot}" is not among the components`)
  }

  for (const component of components) {
    for (const ref of collectChildRefs(component)) {
      if (!ids.has(ref)) {
        throw new A2UISurfaceBuildError(
          `component "${component.id}" references unknown child "${ref}"`
        )
      }
    }
  }

  return resolvedRoot
}

/**
 * Assemble a validated, id-keyed {@link A2UISegmentContent} from a flat
 * component list. The inverse of how the renderer stores a surface
 * (`A2UISurfaceState.components` is also an id-keyed record).
 */
export function buildA2UISurfaceContent(input: A2UISurfaceInput): A2UISegmentContent {
  const resolvedRoot = validateA2UISurfaceComponents(input.components, input.rootId)

  const components: Record<string, A2UIComponent> = {}
  for (const component of input.components) {
    components[component.id] = component
  }

  const content: A2UISegmentContent = {
    components,
    dataModel: input.dataModel ?? {},
    rootId: resolvedRoot,
  }
  if (input.surfaceType) content.surfaceType = input.surfaceType
  if (input.catalogId) content.catalogId = input.catalogId
  if (input.widget) content.widget = input.widget
  if (input.title) content.title = input.title
  return content
}

/**
 * Build a single A2UI message segment (content + plain-text mirror) from a
 * declarative surface input. Reuses {@link buildA2UISegment} for the mirror.
 */
export function buildA2UIMessageSegment(
  surfaceId: string,
  input: A2UISurfaceInput
): A2UIMessageSegment {
  return buildA2UISegment(surfaceId, buildA2UISurfaceContent(input))
}

/**
 * One-shot: build a complete {@link OutboundRequest} carrying a single A2UI
 * surface (plus optional trailing markdown), ready to hand straight to
 * `ctx.connectors.send()`. Mints a surface id and idempotency key when not
 * supplied.
 */
export function buildA2UIOutboundRequest(input: A2UIMessageInput): OutboundRequest {
  const surfaceId = input.surfaceId ?? `plugin-a2ui-${newIdempotencyKey()}`
  const segment = buildA2UIMessageSegment(surfaceId, input)
  const segments: OutboundRequest["segments"] = [segment]
  if (input.text && input.text.trim().length > 0) {
    segments.push({ type: "markdown", md: input.text })
  }
  return {
    conversationRef: input.conversationRef,
    segments,
    metadata: { idempotencyKey: input.idempotencyKey ?? newIdempotencyKey() },
  }
}

/** Build the `ctx.connectors.a2ui` namespace. Pure — no permission needed. */
export function createA2UIBuilder(): PluginConnectorsA2UIBuilder {
  return {
    surface: buildA2UISurfaceContent,
    segment: buildA2UISegment,
    message: buildA2UIOutboundRequest,
    component: a2uiComponent,
  }
}
