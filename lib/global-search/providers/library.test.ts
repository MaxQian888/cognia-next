import type { Skill } from "@cognia/agent-config-types"

import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"
import type { Memory } from "@/types/memory/memory"
import type { WorkflowRow } from "@/types/workflow/visual"

import { __resetGlobalSearchCachesForTesting } from "../cache"
import { makeProviderInput, makeTestContext, TEST_NOW } from "../testing"
import {
  createMemoriesProvider,
  createSkillsProvider,
  createTemplatesProvider,
  createWorkflowsProvider,
} from "./library"

jest.mock("@/lib/db/memories", () => ({ listMemories: jest.fn(async () => []) }))
jest.mock("@/lib/db/skills", () => ({ listSkills: jest.fn(async () => []) }))
jest.mock("@/lib/db/workflows", () => ({ listWorkflowsByUpdated: jest.fn(async () => []) }))
jest.mock("@/lib/templates/catalog", () => ({
  templateCatalog: { getSnapshot: () => ({ revision: 0, definitions: [] }) },
}))

const workflows = [
  { id: "w1", name: "Deploy site", description: "ci", updatedAt: TEST_NOW - 1 },
  { id: "w2", name: "Nightly", updatedAt: TEST_NOW - 2, isTemplate: true },
] as WorkflowRow[]

const skills = [
  {
    id: "s1",
    name: "Summarize",
    slug: "summarize",
    description: "tl;dr",
    updatedAt: TEST_NOW,
    tags: ["text"],
  },
  { id: "s2", name: "Broken", status: "disabled", updatedAt: TEST_NOW },
] as Skill[]

const memories = [
  {
    id: "m1",
    text: `${"lorem ".repeat(40)}the deploy key lives in vault ${"ipsum ".repeat(40)}`,
    tags: ["ops"],
    type: "semantic",
    status: "active",
    updatedAt: TEST_NOW,
    pinned: true,
  },
  {
    id: "m2",
    text: "invalidated deploy note",
    tags: [],
    type: "episodic",
    status: "invalidated",
    updatedAt: TEST_NOW,
  },
  {
    id: "m3",
    text: "unrelated",
    tags: ["deploy"],
    key: "k",
    type: "procedural",
    status: "active",
    updatedAt: TEST_NOW,
  },
] as Memory[]

const templates = [
  {
    id: "t1",
    domain: "workflow",
    status: "published",
    updatedAt: TEST_NOW,
    metadata: {
      name: "Release train",
      description: "weekly",
      localized: { "zh-CN": { name: "发布列车" } },
      tags: ["release"],
    },
  },
  {
    id: "t2",
    domain: "skill",
    status: "deprecated",
    updatedAt: TEST_NOW,
    metadata: { name: "Old release" },
  },
] as unknown as TemplateDefinitionEnvelope[]

describe("library providers", () => {
  afterEach(() => __resetGlobalSearchCachesForTesting())

  it("workflows: matches, marks templates, deep-links to the editor and suggests", async () => {
    const provider = createWorkflowsProvider({ listWorkflows: async () => workflows })
    const out = await provider.search(makeProviderInput("deploy"))
    expect(out.items[0]).toMatchObject({
      id: "workflow:w1",
      subtitle: "ci",
      meta: undefined,
      action: { type: "navigate", href: "/workflows/editor?id=w1" },
    })
    const tpl = await provider.search(makeProviderInput("nightly"))
    expect(tpl.items[0]!.meta).toBe("globalSearch.library.workflowTemplate")
    const items = await provider.suggest!({
      ctx: makeTestContext(),
      limit: 5,
      signal: new AbortController().signal,
    })
    expect(items.map((i) => i.id)).toEqual(["workflow:w1", "workflow:w2"])
  })

  it("skills: matches slug / tags, flags disabled ones", async () => {
    const provider = createSkillsProvider({ listSkills: async () => skills })
    const bySlug = await provider.search(makeProviderInput("summarize"))
    expect(bySlug.items[0]).toMatchObject({
      id: "skill:s1",
      meta: "/summarize",
      action: { href: "/skills?skill=s1" },
    })
    const byTag = await provider.search(makeProviderInput("text"))
    expect(byTag.items[0]!.id).toBe("skill:s1")
    const disabled = await provider.search(makeProviderInput("broken"))
    expect(disabled.items[0]!.meta).toBe("globalSearch.library.disabled")
  })

  it("memories: substring only over active rows, excerpt with highlight, tag hits unhighlighted", async () => {
    const provider = createMemoriesProvider({ listMemories: async () => memories })
    const out = await provider.search(makeProviderInput("deploy key"))
    expect(out.items.map((i) => i.id)).toEqual(["memory:m1"])
    const item = out.items[0]!
    expect(item.title).toContain("deploy key")
    expect(item.title.length).toBeLessThan(130)
    expect(item.titlePositions!.length).toBe("deploy key".length)
    expect(item).toMatchObject({
      subtitle: "#ops",
      meta: "memory.types.semantic",
      extra: { current: true },
      action: { href: "/memory?id=m1" },
    })
    // Tag-only match: still returned, no highlight.
    const byTag = await provider.search(makeProviderInput("deploy"))
    const m3 = byTag.items.find((i) => i.id === "memory:m3")!
    expect(m3.titlePositions).toEqual([])
    expect(m3.subtitle).toBe("#deploy")
    // Fuzzy is off for prose.
    const fuzzy = await provider.search(makeProviderInput("dpky"))
    expect(fuzzy.items).toEqual([])
  })

  it("templates: localized name, deprecated hidden, domain label meta, no cache", async () => {
    const provider = createTemplatesProvider({ listTemplates: () => templates })
    expect(provider.cache).toBeNull()
    const en = await provider.search(makeProviderInput("release"))
    expect(en.items.map((i) => i.id)).toEqual(["template:t1"])
    expect(en.items[0]).toMatchObject({
      title: "Release train",
      subtitle: "weekly",
      meta: "templateStudio.domains.workflow",
      action: { href: "/templates?definition=t1" },
    })
    const zh = await provider.search(
      makeProviderInput("发布", { ctx: makeTestContext({ locale: "zh-CN" }) })
    )
    expect(zh.items[0]!.title).toBe("发布列车")
    expect(zh.items[0]!.subtitle).toBe("weekly")
  })
})
