/**
 * Library (ADR-0129): workflows, skills, memories, templates — the things a
 * user *made*. Each is a list provider over its store; selecting one opens the
 * owning page (deep-linked where the page supports it).
 */

import type { Skill } from "@cognia/agent-config-types"
import { BrainIcon, LayoutTemplateIcon, SparklesIcon, WorkflowIcon } from "lucide-react"

import { listMemories } from "@/lib/db/memories"
import { listSkills } from "@/lib/db/skills"
import { listWorkflowsByUpdated } from "@/lib/db/workflows"
import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"
import { templateCatalog } from "@/lib/templates/catalog"
import type { Memory } from "@/types/memory/memory"
import type { WorkflowRow } from "@/types/workflow/visual"
import { resolveCapabilityEnabled } from "@/lib/workspace/capability-overlay"
import { byProjectId } from "../workspace-scope"
import { excerptAround, highlightPositions } from "./helpers"
import { createListProvider } from "./list-provider"

export const WORKFLOWS_PROVIDER_ID = "builtin.workflows"
export const SKILLS_PROVIDER_ID = "builtin.skills"
export const MEMORIES_PROVIDER_ID = "builtin.memories"
export const TEMPLATES_PROVIDER_ID = "builtin.templates"

/** Memories are prose; cap what we scan per row so a giant note stays cheap. */
const MEMORY_SCAN_CHARS = 2_000

export interface LibraryProviderDeps {
  listWorkflows: () => Promise<WorkflowRow[]>
  listSkills: () => Promise<Skill[]>
  listMemories: () => Promise<Memory[]>
  listTemplates: () => readonly TemplateDefinitionEnvelope[]
}

export function createWorkflowsProvider(deps: Pick<LibraryProviderDeps, "listWorkflows">) {
  return createListProvider<WorkflowRow>({
    id: WORKFLOWS_PROVIDER_ID,
    kind: "workflow",
    load: () => deps.listWorkflows(),
    getTitle: (w) => w.name,
    getSecondary: (w) => w.description,
    getKeywords: (w) => [w.id],
    getTimestamp: (w) => w.updatedAt,
    toItem: ({ row, match }, ctx) => ({
      id: `workflow:${row.id}`,
      kind: "workflow",
      title: row.name,
      titlePositions: match.positions,
      subtitle: row.description?.trim() || undefined,
      meta: row.isTemplate ? ctx.t("globalSearch.library.workflowTemplate") : undefined,
      icon: { lucide: WorkflowIcon },
      score: match.score,
      timestamp: row.updatedAt,
      action: { type: "navigate", href: `/workflows/editor?id=${encodeURIComponent(row.id)}` },
    }),
    suggest: (rows, _ctx, limit) =>
      rows.slice(0, limit).map((row, index) => ({
        id: `workflow:${row.id}`,
        kind: "workflow" as const,
        title: row.name,
        subtitle: row.description?.trim() || undefined,
        icon: { lucide: WorkflowIcon },
        score: 1 - index / (limit + 1),
        timestamp: row.updatedAt,
        action: {
          type: "navigate" as const,
          href: `/workflows/editor?id=${encodeURIComponent(row.id)}`,
        },
      })),
  })
}

export function createSkillsProvider(deps: Pick<LibraryProviderDeps, "listSkills">) {
  return createListProvider<Skill>({
    id: SKILLS_PROVIDER_ID,
    kind: "skill",
    load: () => deps.listSkills(),
    getTitle: (s) => s.name,
    getSecondary: (s) => s.description,
    getKeywords: (s) => [s.id, s.slug ?? "", ...(s.tags ?? [])],
    getTimestamp: (s) => s.updatedAt,
    // A skill is defined once for the machine; a workspace only expresses a
    // preference about it. Hiding one this workspace switched off would produce
    // the worst possible result — "I know I have this and it is not there" — so
    // it ranks below the ones this workspace actually loads.
    workspaceScope: {
      mode: "demote",
      belongs: (row, ctx) =>
        resolveCapabilityEnabled(
          (row.status ?? "enabled") === "enabled",
          ctx.capabilityOverlay,
          "skill",
          row.id
        ),
    },
    toItem: ({ row, match }, ctx) => ({
      id: `skill:${row.id}`,
      kind: "skill",
      title: row.name,
      titlePositions: match.positions,
      subtitle: row.description?.trim() || undefined,
      meta:
        row.status === "disabled"
          ? ctx.t("globalSearch.library.disabled")
          : row.slug
            ? `/${row.slug}`
            : undefined,
      icon: { lucide: SparklesIcon },
      score: match.score,
      timestamp: row.updatedAt,
      action: { type: "navigate", href: `/skills?skill=${encodeURIComponent(row.id)}` },
    }),
  })
}

export function createMemoriesProvider(deps: Pick<LibraryProviderDeps, "listMemories">) {
  return createListProvider<Memory>({
    id: MEMORIES_PROVIDER_ID,
    kind: "memory",
    load: () => deps.listMemories(),
    include: (m) => m.status === "active",
    // A memory belongs to a workspace, so out of scope it is noise. Memories
    // with no workspace are shared and always in scope.
    workspaceScope: { mode: "filter", belongs: byProjectId<Memory>((m) => m.projectId) },
    // Titles are the memory text itself: substring only, a fuzzy subsequence in
    // a paragraph is noise.
    fuzzy: false,
    getTitle: (m) => m.text.slice(0, MEMORY_SCAN_CHARS),
    getKeywords: (m) => [m.key ?? "", ...m.tags],
    getTimestamp: (m) => m.updatedAt,
    toItem: ({ row, match }, ctx, query) => {
      // Highlight only when the body matched (a tag hit has nothing to mark).
      const needle = match.field === "title" ? query.needle : ""
      const title = excerptAround(row.text, needle)
      return {
        id: `memory:${row.id}`,
        kind: "memory",
        title,
        titlePositions: highlightPositions(title, needle),
        subtitle: row.tags.length > 0 ? row.tags.map((t) => `#${t}`).join(" ") : undefined,
        meta: ctx.t(`memory.types.${row.type}`),
        icon: { lucide: BrainIcon },
        score: match.score,
        timestamp: row.updatedAt,
        extra: { current: row.pinned },
        action: { type: "navigate", href: `/memory?id=${encodeURIComponent(row.id)}` },
      }
    },
  })
}

function templateName(definition: TemplateDefinitionEnvelope, locale: string): string {
  return definition.metadata.localized?.[locale]?.name ?? definition.metadata.name
}

function templateDescription(
  definition: TemplateDefinitionEnvelope,
  locale: string
): string | undefined {
  return definition.metadata.localized?.[locale]?.description ?? definition.metadata.description
}

export function createTemplatesProvider(deps: Pick<LibraryProviderDeps, "listTemplates">) {
  return createListProvider<TemplateDefinitionEnvelope>({
    id: TEMPLATES_PROVIDER_ID,
    kind: "template",
    // The catalog is an in-memory store with its own revision; no TTL needed.
    cache: false,
    load: () => deps.listTemplates(),
    include: (d) => d.status !== "deprecated",
    getTitle: (d, ctx) => templateName(d, ctx.locale),
    getSecondary: (d, ctx) => templateDescription(d, ctx.locale),
    getKeywords: (d) => [d.id, d.domain, ...(d.metadata.tags ?? []), d.metadata.category ?? ""],
    getTimestamp: (d) => d.updatedAt,
    toItem: ({ row, match }, ctx) => ({
      id: `template:${row.id}`,
      kind: "template",
      title: templateName(row, ctx.locale),
      titlePositions: match.positions,
      subtitle: templateDescription(row, ctx.locale)?.trim() || undefined,
      meta: ctx.t(`templateStudio.domains.${row.domain}`),
      icon: { lucide: LayoutTemplateIcon },
      score: match.score,
      timestamp: row.updatedAt,
      action: { type: "navigate", href: `/templates?definition=${encodeURIComponent(row.id)}` },
    }),
  })
}

export const workflowsProvider = createWorkflowsProvider({ listWorkflows: listWorkflowsByUpdated })
export const skillsProvider = createSkillsProvider({ listSkills })
export const memoriesProvider = createMemoriesProvider({ listMemories: () => listMemories() })
export const templatesProvider = createTemplatesProvider({
  listTemplates: () => templateCatalog.getSnapshot().definitions,
})
