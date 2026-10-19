/**
 * The user's subagent templates as Prompt Center resources (ADR-0236 §5.1).
 *
 * A template's prompt is what both delegation rails send:
 * `config.systemPrompt ?? taskTemplate ?? description`. Saving writes
 * `config.systemPrompt` through the subagent store, so the saved text is what
 * runs, and leaves the template's tools, model, turn budget, context policy and
 * external backing alone.
 *
 * The seeded built-in templates are fork sources the resolvers skip; they are
 * changed by forking them, which here creates the user's own template with the
 * edited prompt, the same copy the Subagents screen makes. Plugin-contributed
 * subagents are not templates: their prompt is a namespaced override slot
 * (`plugin-prompts.ts`), because a template cannot carry their effort or
 * disallowed tools.
 */

import { nanoid } from "nanoid"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgentTemplate } from "@/types/agent/sub-agent"
import {
  parseResourceKey,
  resourceKey,
  type OwnerPromptAdapter,
  type PromptResourceSummary,
} from "../resources"

function idOf(key: string): string {
  const { source, id } = parseResourceKey(key)
  if (source !== "subagent-template" || !id) throw new Error(`not a subagent template: ${key}`)
  return id
}

function templateOf(id: string): SubAgentTemplate | undefined {
  return useSubagentRuntimeStore.getState().templates[id]
}

function promptOf(template: SubAgentTemplate): string {
  return template.config.systemPrompt ?? template.taskTemplate ?? template.description
}

export const subagentTemplatePromptAdapter: OwnerPromptAdapter = {
  source: "subagent-template",

  async list() {
    return Object.values(useSubagentRuntimeStore.getState().templates)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((template): PromptResourceSummary => ({
        key: resourceKey("subagent-template", template.id),
        source: "subagent-template",
        kind: "role",
        operation: "legacy-replace",
        name: template.name,
        builtIn: template.isBuiltIn === true,
        modified: false,
        edit: template.isBuiltIn ? "custom-copy" : "source",
        ownerSection: "subagents",
        ...(template.description ? { detail: template.description } : {}),
      }))
  },

  async read(key) {
    const template = templateOf(idOf(key))
    if (!template) return undefined
    return {
      key,
      text: promptOf(template),
      ...(template.isBuiltIn ? { readOnlyReason: "built-in" as const } : {}),
    }
  },

  async save(key, text) {
    const id = idOf(key)
    const template = templateOf(id)
    if (!template) throw new Error(`Subagent template ${id} not found`)
    if (template.isBuiltIn) throw new Error(`Subagent template ${id} is built in; fork it instead.`)
    useSubagentRuntimeStore
      .getState()
      .updateTemplate(id, { config: { ...template.config, systemPrompt: text } })
    return (await subagentTemplatePromptAdapter.read(key, {}))!
  },

  async saveCustom(key, text, _ctx, options = {}) {
    const id = idOf(key)
    const template = templateOf(id)
    if (!template) throw new Error(`Subagent template ${id} not found`)
    const copy: SubAgentTemplate = {
      ...template,
      id: nanoid(),
      name: options.name?.trim() || template.name,
      config: { ...template.config, systemPrompt: text },
      isBuiltIn: false,
      createdAt: new Date(),
    }
    useSubagentRuntimeStore.getState().addTemplate(copy)
    return resourceKey("subagent-template", copy.id)
  },
}
