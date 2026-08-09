export const A2UI_MAX_NODES = 500
export const A2UI_MAX_DEPTH = 32
export const A2UI_MAX_BYTES = 1024 * 1024

export interface TuiA2UINode {
  id: string
  component: string
  [key: string]: unknown
}

export interface TuiA2UISurface {
  surfaceId: string
  rootId: string
  components: Record<string, TuiA2UINode>
  dataModel: Record<string, unknown>
}

export type A2UISurfaceValidation =
  { ok: true; surface: TuiA2UISurface } | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function childIds(node: TuiA2UINode): string[] {
  const fields = [node.children, node.footer, node.actions]
  const ids = fields.flatMap((value) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  )
  if (Array.isArray(node.tabs)) {
    for (const tab of node.tabs) {
      if (isRecord(tab) && Array.isArray(tab.children)) {
        ids.push(...tab.children.filter((item): item is string => typeof item === "string"))
      }
    }
  }
  if (Array.isArray(node.items)) {
    for (const item of node.items) {
      if (isRecord(item) && Array.isArray(item.children)) {
        ids.push(...item.children.filter((child): child is string => typeof child === "string"))
      }
    }
  }
  return ids
}

export function validateA2UISurface(
  surfaceId: string,
  payload: Record<string, unknown>
): A2UISurfaceValidation {
  let serialized: string
  try {
    serialized = JSON.stringify(payload)
  } catch {
    return { ok: false, reason: "A2UI payload is not serializable" }
  }
  if (Buffer.byteLength(serialized, "utf8") > A2UI_MAX_BYTES) {
    return { ok: false, reason: "A2UI payload exceeds the 1 MiB limit" }
  }

  const rawComponents = payload.components
  const entries: Array<[string, unknown]> = Array.isArray(rawComponents)
    ? rawComponents.map((component, index) => [
        isRecord(component) && typeof component.id === "string" ? component.id : `#${index}`,
        component,
      ])
    : isRecord(rawComponents)
      ? Object.entries(rawComponents)
      : []
  if (entries.length === 0) return { ok: false, reason: "A2UI surface has no components" }
  if (entries.length > A2UI_MAX_NODES) {
    return { ok: false, reason: `A2UI surface exceeds the ${A2UI_MAX_NODES}-node limit` }
  }

  const components: Record<string, TuiA2UINode> = {}
  for (const [key, value] of entries) {
    if (!isRecord(value) || typeof value.component !== "string") {
      return { ok: false, reason: `A2UI component ${key} is malformed` }
    }
    const id = typeof value.id === "string" && value.id ? value.id : key
    components[id] = { ...value, id, component: value.component }
  }
  const rootId = typeof payload.rootId === "string" ? payload.rootId : ""
  if (!rootId || !components[rootId]) {
    return { ok: false, reason: "A2UI surface rootId is missing or unknown" }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string, depth: number): string | null => {
    if (depth > A2UI_MAX_DEPTH) return `A2UI surface exceeds depth ${A2UI_MAX_DEPTH}`
    if (visiting.has(id)) return `A2UI surface contains a component reference cycle at ${id}`
    if (visited.has(id)) return null
    const component = components[id]
    if (!component) return null
    visiting.add(id)
    for (const child of childIds(component)) {
      const error = visit(child, depth + 1)
      if (error) return error
    }
    visiting.delete(id)
    visited.add(id)
    return null
  }
  const graphError = visit(rootId, 1)
  if (graphError) return { ok: false, reason: graphError }

  return {
    ok: true,
    surface: {
      surfaceId,
      rootId,
      components,
      dataModel: isRecord(payload.dataModel) ? payload.dataModel : {},
    },
  }
}
