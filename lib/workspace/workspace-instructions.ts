/**
 * The workspace's own instructions, as a system-prompt section.
 *
 * `Project.customInstructions` has been part of the model since the plugin API
 * shipped (`createProject({ systemPrompt })` writes it), and the chat dock
 * counts it towards "context configured". Nothing sent it: the only reader was
 * the external-agent instruction stack, which has no caller. So a workspace
 * could be scored on instructions that never reached a model.
 *
 * Kept apart from the on-disk instruction files (CLAUDE.md / AGENTS.md). Those
 * belong to the repository and travel with it; these belong to this device's
 * workspace and are edited in the workspace manager. The heading says which
 * one the model is reading.
 */

import type { Project } from "@/types"

/** Upper bound on what one workspace can add to every turn's prompt. */
export const WORKSPACE_INSTRUCTIONS_MAX_CHARS = 8_000

export function buildWorkspaceInstructionsSection(
  project: Pick<Project, "name" | "customInstructions"> | null | undefined
): string {
  const text = project?.customInstructions?.trim()
  if (!text) return ""
  const body =
    text.length > WORKSPACE_INSTRUCTIONS_MAX_CHARS
      ? text.slice(0, WORKSPACE_INSTRUCTIONS_MAX_CHARS)
      : text
  const name = project?.name?.trim()
  const heading = name ? `## Workspace instructions (${name})` : "## Workspace instructions"
  return `${heading}\n\n${body}`
}
