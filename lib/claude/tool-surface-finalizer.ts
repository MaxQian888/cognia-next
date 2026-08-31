import type { SendOptions, ToolFilterConfig } from "@cognia/agent-config-types"

type ToolSurfaceProjection = Pick<SendOptions, "allowedTools" | "disallowedTools" | "toolSurface">

/**
 * Seal the model-visible tool surface after every candidate contributor and
 * plugin hook has run. This function only narrows: it never grants a tool.
 */
export function finalizeToolSurface(
  projection: ToolSurfaceProjection,
  filter: ToolFilterConfig | null | undefined
): ToolSurfaceProjection {
  const hadRestrictiveAllowList = projection.allowedTools !== undefined
  let allowed = projection.allowedTools ? new Set(projection.allowedTools) : null
  const denied = new Set(projection.disallowedTools ?? [])

  if (filter?.mode === "allow" && (filter.tools?.length ?? 0) > 0) {
    const ceiling = new Set(filter.tools)
    allowed = allowed ? new Set([...allowed].filter((tool) => ceiling.has(tool))) : new Set(ceiling)
  } else if (filter?.mode === "deny") {
    for (const tool of filter.tools ?? []) denied.add(tool)
  }

  if (allowed) {
    for (const tool of denied) allowed.delete(tool)
  }

  const allowedTools = allowed ? [...allowed].sort() : undefined
  const disallowedTools = denied.size > 0 ? [...denied].sort() : undefined
  const denyAll = Boolean(
    allowedTools &&
    allowedTools.length === 0 &&
    (hadRestrictiveAllowList || filter?.mode === "allow")
  )

  return {
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(denyAll
      ? { toolSurface: "none" }
      : projection.toolSurface
        ? { toolSurface: projection.toolSurface }
        : {}),
  }
}
