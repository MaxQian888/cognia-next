/**
 * Agent Team template teammates as Prompt Center resources (ADR-0236 §5.1).
 *
 * A team template is a recipe: instantiating it copies each teammate's prompt
 * (`systemPrompt ?? config.systemPrompt`) into the new team, so the template is
 * where that text is owned, one resource per teammate. The user's own
 * templates are saved in place through the team store, writing only the
 * teammate's `systemPrompt`, which wins over `config.systemPrompt` exactly as
 * instantiation reads it; the teammate's tools, capabilities and governance
 * stay as they are. Teams already created keep the copy they were made with.
 * Every write is mirrored to the template platform, as the templates screen
 * mirrors it, because Use instantiates the platform's definition.
 *
 * Built-in templates (seeded into the store, which refuses to update them) and
 * plugin templates (the overlay registry, projected the same way the templates
 * screen projects them) are changed through a custom copy: the whole template
 * is duplicated, as the screen's Duplicate does, with this teammate's prompt
 * replaced, so nothing else about the team is lost. A disabled plugin's
 * template is gone from the registry and from this list.
 */

import { nanoid } from "nanoid"
import { projectPluginTemplate } from "@/lib/agent-team/project-plugin-template"
import { publishSquadTemplateToPlatform } from "@/lib/agent-team/publish-template-to-platform"
import { listAgentTeamTemplateEntries } from "@/lib/plugin/registries/agent-team-template-registry"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"
import {
  parseResourceKey,
  resourceKey,
  type OwnerPromptAdapter,
  type PromptResourceSummary,
} from "../resources"

/** `<template id>#<teammate index>`; template ids may contain colons (plugin ids do). */
function teammateId(templateId: string, index: number): string {
  return `${templateId}#${index}`
}

function partsOf(key: string): { templateId: string; index: number } {
  const { source, id } = parseResourceKey(key)
  const hash = id.lastIndexOf("#")
  const index = Number(id.slice(hash + 1))
  if (source !== "team-template" || hash <= 0 || !Number.isInteger(index) || index < 0) {
    throw new Error(`not a team template resource: ${key}`)
  }
  return { templateId: id.slice(0, hash), index }
}

interface TemplateRecord {
  template: AgentTeamTemplate
  /** Only the user's own store rows are written in place. */
  owned: boolean
  plugin: boolean
}

function allTemplates(): TemplateRecord[] {
  const stored = Object.values(useAgentTeamStore.getState().templates).map((template) => ({
    template,
    owned: !template.isBuiltIn,
    plugin: false,
  }))
  const contributed = listAgentTeamTemplateEntries().map((entry) => ({
    template: projectPluginTemplate(entry),
    owned: false,
    plugin: true,
  }))
  return [...stored, ...contributed]
}

function templateOf(templateId: string): TemplateRecord | undefined {
  return allTemplates().find((record) => record.template.id === templateId)
}

type Teammate = AgentTeamTemplate["teammates"][number]

function promptOf(teammate: Teammate): string {
  return teammate.systemPrompt ?? teammate.config?.systemPrompt ?? ""
}

function withPrompt(template: AgentTeamTemplate, index: number, text: string) {
  return template.teammates.map((teammate, at) =>
    at === index ? { ...teammate, systemPrompt: text } : { ...teammate }
  )
}

export const teamTemplatePromptAdapter: OwnerPromptAdapter = {
  source: "team-template",

  async list() {
    return allTemplates()
      .sort((a, b) => a.template.name.localeCompare(b.template.name))
      .flatMap(({ template, owned }) =>
        template.teammates.map((teammate, index): PromptResourceSummary => ({
          key: resourceKey("team-template", teammateId(template.id, index)),
          source: "team-template",
          kind: "role",
          operation: "legacy-replace",
          name: `${template.name} · ${teammate.name}`,
          builtIn: !owned,
          modified: false,
          edit: owned ? "source" : "custom-copy",
          ownerSection: "squads",
          ...(teammate.description ? { detail: teammate.description } : {}),
        }))
      )
  },

  async read(key) {
    const { templateId, index } = partsOf(key)
    const record = templateOf(templateId)
    const teammate = record?.template.teammates[index]
    if (!record || !teammate) return undefined
    return {
      key,
      text: promptOf(teammate),
      ...(record.owned ? {} : { readOnlyReason: record.plugin ? "plugin" : "built-in" }),
    }
  },

  async save(key, text) {
    const { templateId, index } = partsOf(key)
    const record = templateOf(templateId)
    if (!record?.template.teammates[index]) throw new Error(`Teammate ${key} not found`)
    if (!record.owned) {
      throw new Error(`Template ${templateId} is not yours to edit; edit a copy of it instead.`)
    }
    const teammates = withPrompt(record.template, index, text)
    useAgentTeamStore.getState().updateTemplate(templateId, { teammates })
    await publishSquadTemplateToPlatform({ ...record.template, teammates })
    return (await teamTemplatePromptAdapter.read(key, {}))!
  },

  async saveCustom(key, text, _ctx, options = {}) {
    const { templateId, index } = partsOf(key)
    const record = templateOf(templateId)
    if (!record?.template.teammates[index]) throw new Error(`Teammate ${key} not found`)
    const copy: AgentTeamTemplate = {
      ...record.template,
      id: nanoid(),
      name: options.name?.trim() || record.template.name,
      teammates: withPrompt(record.template, index, text),
      isBuiltIn: false,
    }
    useAgentTeamStore.getState().addTemplate(copy)
    await publishSquadTemplateToPlatform(copy)
    return resourceKey("team-template", teammateId(copy.id, index))
  },
}
