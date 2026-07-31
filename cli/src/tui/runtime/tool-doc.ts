/**
 * Shared markdown builder for tool-detail documents — renders a list of tools
 * (name, optional category badge, description, and JSON input schema) into the
 * markdown body the {@link DocumentViewer} pages through. Reused by the MCP,
 * plugin, and built-in tool viewers so they all read identically.
 */

export interface ToolDocEntry {
  name: string
  description?: string
  category?: string
  /** JSON-Schema for the tool's input, rendered as a fenced ```json block. */
  schema?: unknown
}

/** Pretty-print a JSON-Schema, tolerant of values that can't be stringified. */
function renderSchema(schema: unknown): string | null {
  if (schema === undefined || schema === null) return null
  if (typeof schema === "object" && Object.keys(schema as object).length === 0) return null
  try {
    return JSON.stringify(schema, null, 2)
  } catch {
    return null
  }
}

/**
 * Build the markdown body for a tool list. `summary` is an optional lead line
 * (e.g. "3 tools advertised by server foo"). Each tool becomes a `###` section.
 */
export function buildToolsDocument(tools: ToolDocEntry[], summary?: string): string {
  const lines: string[] = []
  if (summary) lines.push(summary, "")
  if (tools.length === 0) {
    lines.push("_No tools._")
    return lines.join("\n")
  }
  for (const tool of tools) {
    const heading = tool.category ? `### ${tool.name}  \`${tool.category}\`` : `### ${tool.name}`
    lines.push(heading)
    if (tool.description) lines.push("", tool.description.trim())
    const schema = renderSchema(tool.schema)
    if (schema) lines.push("", "```json", schema, "```")
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

export interface ResourceDocEntry {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

/** Build the markdown body for an MCP server's advertised resources. */
export function buildResourcesDocument(resources: ResourceDocEntry[], summary?: string): string {
  const lines: string[] = []
  if (summary) lines.push(summary, "")
  if (resources.length === 0) {
    lines.push("_No resources._")
    return lines.join("\n")
  }
  for (const r of resources) {
    lines.push(`### ${r.name ?? r.uri}`)
    const meta: string[] = [`\`${r.uri}\``]
    if (r.mimeType) meta.push(r.mimeType)
    lines.push("", meta.join("  ·  "))
    if (r.description) lines.push("", r.description.trim())
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

export interface PromptDocEntry {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

/** Build the markdown body for an MCP server's advertised prompts. */
export function buildPromptsDocument(prompts: PromptDocEntry[], summary?: string): string {
  const lines: string[] = []
  if (summary) lines.push(summary, "")
  if (prompts.length === 0) {
    lines.push("_No prompts._")
    return lines.join("\n")
  }
  for (const p of prompts) {
    lines.push(`### ${p.name}`)
    if (p.description) lines.push("", p.description.trim())
    for (const a of p.arguments ?? []) {
      const req = a.required ? " _(required)_" : ""
      lines.push("", `- \`${a.name}\`${req}${a.description ? ` — ${a.description.trim()}` : ""}`)
    }
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}
