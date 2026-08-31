/**
 * Palette sub-sections for the node catalog.
 *
 * `WorkflowNodeCategory` (types/workflow/visual.ts) is a seven-way split
 * consumed by validation and the runtime, and it is deliberately coarse. The
 * palette inherited it as its only grouping, which put **124 of 177** entries
 * into a single flat "Actions" list: an author looking for the agent node
 * scrolled past every scheduler, git, connector and mobile node to find it.
 *
 * Sections are a presentation layer on top, derived the same way the category
 * is: from the kind's own prefix, so a new kind lands in the right place
 * without a second table to remember. Only the categories that are genuinely
 * too big get sections. The others render flat, exactly as before.
 */

import type { WorkflowNodeKind } from "@/types/workflow/visual"

/** Ordered section ids. The palette renders them in this order. */
export const PALETTE_SECTIONS = [
  "agents",
  "plans",
  "goals",
  "memory",
  "skills-tools",
  "connectors",
  "human",
  "scheduler",
  "desktop",
  "files-git",
  "terminal",
  "sites",
  "mobile",
  "eval",
  "other",
] as const

export type PaletteSection = (typeof PALETTE_SECTIONS)[number]

/**
 * Second segment of an `action.*` kind to its section. Anything unmapped falls
 * through to `other`, which is what `palette-sections.test.ts` refuses to let
 * grow silently.
 */
const ACTION_SEGMENT_SECTION: Record<string, PaletteSection> = {
  agent: "agents",
  team: "agents",
  character: "agents",
  plan: "plans",
  goal: "goals",
  memory: "memory",
  twin: "memory",
  skill: "skills-tools",
  mcp: "skills-tools",
  plugin: "skills-tools",
  connector: "connectors",
  approval: "human",
  humanInput: "human",
  scheduler: "scheduler",
  desktop: "desktop",
  pet: "desktop",
  system: "desktop",
  git: "files-git",
  stack: "files-git",
  artifact: "files-git",
  canvas: "files-git",
  editor: "files-git",
  terminal: "terminal",
  site: "sites",
  mobile: "mobile",
}

/**
 * The section a kind belongs to, or `null` when its category is small enough
 * to render flat (triggers, ai, flow, data, io, annotation).
 */
export function paletteSection(kind: WorkflowNodeKind | string): PaletteSection | null {
  const [head, segment] = kind.split(".")
  // Ultracode multi-agent orchestration reads as an agent node rather than an
  // anonymous action. It is categorised `action` only because the category map
  // has nowhere else to put it.
  if (head === "pattern") return "agents"
  if (head === "eval") return "eval"
  if (head !== "action") return null
  return ACTION_SEGMENT_SECTION[segment ?? ""] ?? "other"
}
