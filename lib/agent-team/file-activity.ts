export interface AgentFileActivity {
  path: string
  line?: number
  column?: number
  timing: "start" | "success"
}

type ToolInput = Record<string, unknown>

const READ_TOOLS = new Set(["read", "readfile", "fsreadworkspacefile"])
const WRITE_TOOLS = new Set([
  "write",
  "writefile",
  "fswriteworkspacefile",
  "edit",
  "multiedit",
  "notebookedit",
])

function normalizeToolName(name: string): string {
  const bare = name.split("__").at(-1) ?? name
  return bare
    .replace(/^tool-/, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
}

function parseInput(input: string | ToolInput | undefined): ToolInput | null {
  if (!input) return null
  if (typeof input === "object") return input
  try {
    const parsed: unknown = JSON.parse(input)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ToolInput)
      : null
  } catch {
    return null
  }
}

function positiveInteger(input: ToolInput, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  }
  return undefined
}

export function extractAgentFileActivity(
  toolName: string,
  rawInput: string | ToolInput | undefined
): AgentFileActivity | null {
  const normalizedName = normalizeToolName(toolName)
  const timing = READ_TOOLS.has(normalizedName)
    ? "start"
    : WRITE_TOOLS.has(normalizedName)
      ? "success"
      : null
  if (!timing) return null

  const input = parseInput(rawInput)
  if (!input) return null
  const path = [input.file_path, input.path, input.notebook_path].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  )
  if (!path) return null

  const line = positiveInteger(input, ["line", "line_number", "start_line", "offset"])
  if ("offset" in input && input.offset !== undefined && line === undefined) return null
  const column = positiveInteger(input, ["column", "column_number", "start_column"])

  return {
    path,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    timing,
  }
}
