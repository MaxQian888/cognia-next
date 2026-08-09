export const SPAWN_TASK_TOOL_NAME = "spawn_task"
export const SIDECHAT_PANEL_ID = "session-sidechat"
export type SpawnTaskMode = "aside" | "inherit"

export interface SpawnedTaskBrief {
  title: string
  tldr: string
  situation: string
  codeLocations: string[]
  solution: string
  caveats: string[]
  mode: SpawnTaskMode
}

export const SPAWN_TASK_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["title", "tldr", "situation", "code_locations", "solution", "caveats"],
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: 60,
      description: "Imperative task title, starting with a verb.",
    },
    tldr: {
      type: "string",
      minLength: 1,
      description: "One or two plain-language sentences describing what and why.",
    },
    situation: {
      type: "string",
      minLength: 1,
      description: "What was found, how it was found, and its impact.",
    },
    code_locations: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Relevant path:line locations; may be empty.",
    },
    solution: { type: "string", minLength: 1, description: "Recommended implementation approach." },
    caveats: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Constraints and traps; may be empty.",
    },
    mode: {
      type: "string",
      enum: ["aside", "inherit"],
      default: "aside",
      description:
        "Use aside for a self-contained handoff; inherit only when the task needs the current conversation context.",
    },
  },
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmpty)
}

export function parseSpawnTaskArgs(
  args: Record<string, unknown>
): SpawnedTaskBrief | { error: string } {
  if (!nonEmpty(args.title)) return { error: "title must be a non-empty string" }
  if (args.title.trim().length > 60) return { error: "title must be 60 characters or fewer" }
  for (const key of ["tldr", "situation", "solution"] as const) {
    if (!nonEmpty(args[key])) return { error: `${key} must be a non-empty string` }
  }
  if (!stringArray(args.code_locations))
    return { error: "code_locations must be an array of non-empty strings" }
  if (!stringArray(args.caveats)) return { error: "caveats must be an array of non-empty strings" }
  if (args.mode !== undefined && args.mode !== "aside" && args.mode !== "inherit") {
    return { error: "mode must be aside or inherit" }
  }
  return {
    title: args.title.trim(),
    tldr: (args.tldr as string).trim(),
    situation: (args.situation as string).trim(),
    codeLocations: args.code_locations.map((value) => value.trim()),
    solution: (args.solution as string).trim(),
    caveats: args.caveats.map((value) => value.trim()),
    mode: (args.mode as SpawnTaskMode | undefined) ?? "aside",
  }
}

export function renderSpawnedTaskPrompt(brief: SpawnedTaskBrief): string {
  const locations =
    brief.codeLocations.length > 0
      ? brief.codeLocations.map((value) => `- \`${value}\``).join("\n")
      : "- None identified"
  const caveats =
    brief.caveats.length > 0 ? brief.caveats.map((value) => `- ${value}`).join("\n") : "- None"
  return `# ${brief.title}\n\n${brief.tldr}\n\n## Situation\n\n${brief.situation}\n\n## Code locations\n\n${locations}\n\n## Proposed solution\n\n${brief.solution}\n\n## Caveats\n\n${caveats}`
}

export function spawnTaskModelReply({
  taskSessionId,
  brief,
}: {
  taskSessionId: string
  brief: SpawnedTaskBrief
}) {
  return {
    ok: true as const,
    taskSessionId,
    ...brief,
    instruction:
      "The task is staged for the user to start in a sidechat. Do not continue working on it in the main thread.",
  }
}
