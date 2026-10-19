/**
 * A workspace's own instructions (`Project.customInstructions`) as a Prompt
 * Center resource (ADR-0236 §5.1).
 *
 * These belong to this device's workspace record, not to the repository
 * (that is the instruction files' job), and the send path appends them as the
 * "Workspace instructions" section. The project store stays their only writer;
 * the workspace manager edits the same field.
 */

import { WORKSPACE_INSTRUCTIONS_MAX_CHARS } from "@/lib/workspace/workspace-instructions"
import { useProjectStore } from "@/stores/project/project-store"
import {
  parseResourceKey,
  resourceKey,
  type OwnerPromptAdapter,
  type PromptResourceContext,
} from "../resources"

function idOf(key: string): string {
  const { source, id } = parseResourceKey(key)
  if (source !== "workspace-instructions" || !id) {
    throw new Error(`not a workspace instructions resource: ${key}`)
  }
  return id
}

function projectOf(id: string, ctx: PromptResourceContext) {
  const fromStore = useProjectStore.getState().projects.find((project) => project.id === id)
  if (fromStore)
    return { id, name: fromStore.name, customInstructions: fromStore.customInstructions }
  return ctx.workspace?.id === id ? ctx.workspace : undefined
}

export const workspaceInstructionsPromptAdapter: OwnerPromptAdapter = {
  source: "workspace-instructions",

  async list(ctx) {
    if (!ctx.workspace) return []
    const project = projectOf(ctx.workspace.id, ctx)
    return [
      {
        key: resourceKey("workspace-instructions", ctx.workspace.id),
        source: "workspace-instructions",
        kind: "project-rule",
        operation: "append-rules",
        name: project?.name ?? ctx.workspace.name,
        builtIn: false,
        modified: Boolean(project?.customInstructions?.trim()),
        edit: "source",
      },
    ]
  },

  async read(key, ctx) {
    const project = projectOf(idOf(key), ctx)
    if (!project) return undefined
    return { key, text: project.customInstructions ?? "" }
  },

  async save(key, text, _version, ctx) {
    const id = idOf(key)
    if (!projectOf(id, ctx)) throw new Error(`Workspace ${id} not found`)
    if (text.length > WORKSPACE_INSTRUCTIONS_MAX_CHARS) {
      throw new Error(
        `Workspace instructions are limited to ${WORKSPACE_INSTRUCTIONS_MAX_CHARS} characters.`
      )
    }
    useProjectStore.getState().updateProject(id, { customInstructions: text.trim() || undefined })
    return (await workspaceInstructionsPromptAdapter.read(key, ctx))!
  },
}
