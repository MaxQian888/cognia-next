// The Code tool presentation (ADR-0117 Phase 4), folded over an assembled
// native tool surface.

import type { ToolDefinition } from "../kernel/define.ts"
import { parseToolArgs, toolInputJsonSchema } from "../kernel/args.ts"
import { codeModeToolDefs } from "../builtin/run-code/index.ts"
import { isProgrammaticReadOnly } from "../builtin/run-code/eligibility.ts"
import { bareToolName } from "../../policy/confinement/classify.ts"

/**
 * Fold the Code presentation over an assembled native tool list.
 *
 * `native` (and anything unrecognised) returns the list untouched, so a turn
 * that never resolved a composition behaves exactly as it did before ADR-0117.
 * `code` replaces the surface with `run_code` alone; `both` appends it.
 *
 * When the host cannot sandbox, `codeModeToolDefs` returns an empty list, and
 * `code` presentation then yields NO tools at all rather than the native ones.
 * That is deliberate: silently handing back the native surface would be the
 * degraded fallback the ADR forbids, and it would do it invisibly.
 */
export function applyToolPresentation<D extends ToolDefinition>(
  nativeDefs: readonly D[],
  presentation: string | undefined
): readonly (D | ToolDefinition)[] {
  if (presentation !== "code" && presentation !== "both") return nativeDefs

  const byName = new Map(nativeDefs.map((def) => [bareToolName(def.name), def]))
  const callTool = async (name: string, input: unknown) => {
    const def = byName.get(name)
    if (!def) {
      // Reached when the tool is eligible in principle but its category is
      // switched off for this session. Saying so beats a generic failure.
      throw new Error(`tool "${name}" is not enabled in this session`)
    }
    // Parse before dispatch, exactly as the Anthropic, ai-sdk and MCP-bridge
    // rails do. Generated code is model-authored, so without this every
    // `.default()`/`.min()`/`.max()` on the def is inert here and nowhere else
    // — `content_search`'s `maxResults` cap would vanish (`length >= undefined`
    // is always false) — and a wrong-typed field would surface as a TypeError
    // deep inside a handler instead of a validation message the model can act
    // on. It also makes the declaration's "the same argument validation still
    // applies" claim true rather than aspirational.
    const parsed = parseToolArgs(def.inputSchema, input)
    if (!parsed.ok) throw new Error(`invalid arguments for "${name}": ${parsed.message}`)
    return await def.handler(parsed.value)
  }

  // The SDK declaration is rendered from the defs this session actually
  // assembled, so it advertises exactly what the broker can reach — a tool the
  // user disabled never appears in the API the model is shown. The defs carry
  // zod raw shapes; the renderer reads JSON Schema, so convert here or every
  // signature silently degrades to `input: unknown`.
  const sdkTools = nativeDefs
    .filter((def) => isProgrammaticReadOnly(bareToolName(def.name)))
    .map((def) => ({
      name: bareToolName(def.name),
      description: def.description,
      inputSchema: toolInputJsonSchema(def.inputSchema),
    }))

  const codeDefs = codeModeToolDefs({ callTool, sdkTools }) as ToolDefinition[]
  return presentation === "code" ? codeDefs : [...nativeDefs, ...codeDefs]
}
