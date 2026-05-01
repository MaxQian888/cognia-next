// Part type extensions specific to cognia-next.
//
// AI SDK's UIMessage parts is an open-ended array — registries that don't
// know our `type: "a2ui"` value will simply ignore it. We declare the shape
// here so adapter / message renderer / a2ui-part can share a single source
// of truth without leaking into the AI SDK's own typings.

/**
 * Source of an A2UI message inside a chat assistant turn.
 *
 * - `codeblock` — extracted from a fenced ```a2ui``` block (or generic JSON
 *   block whose content satisfies `detectA2UIContent`).
 * - `tool-result` — a tool-call result whose payload parsed as A2UI messages
 *   (replaces the bare tool result so the user sees the surface, not raw JSON).
 * - `acp-stream` — emitted as a JSON-line by an external ACP-over-stdio agent
 *   and sniffed by the external-agent-store's stdout handler.
 * - `mcp-bridge` — dispatched by the in-process / standalone MCP server when
 *   an agent calls one of the `a2ui_*` tools.
 */
export type A2UIPartSource = "codeblock" | "tool-result" | "acp-stream" | "mcp-bridge"

/**
 * A2UI message part attached to an assistant `UIMessage`. The surface itself
 * lives in `useA2UIStore`; this part only carries a pointer plus a copy of
 * the original payload so the surface can be re-hydrated on reload.
 */
export interface A2UIPart {
  type: "a2ui"
  /** Stable surface identifier — same one persisted in `a2uiSurfaces`. */
  surfaceId: string
  /**
   * Raw a2ui payload (codeblock body, tool-result text, or stringified
   * MCP tool args). The renderer feeds this back through `processMessage`
   * after a cold hydrate to rebuild the surface deterministically.
   */
  content: string
  source: A2UIPartSource
  /** Tool-call id when `source === "tool-result"`. */
  toolUseId?: string
}

export function isA2UIPart(part: unknown): part is A2UIPart {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "a2ui" &&
    typeof (part as { surfaceId?: unknown }).surfaceId === "string" &&
    typeof (part as { content?: unknown }).content === "string"
  )
}
