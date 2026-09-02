/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { waitFor } from "@testing-library/react"

import { createChatTemplate } from "@/lib/db/chat-templates"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { TemplateCatalog } from "./catalog"
import {
  refreshCatalogOnlyTemplateAdapters,
  stopCatalogOnlyTemplateWatches,
} from "./catalog-only-adapters"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}, 30_000)

describe("catalog-only template adapters", () => {
  it("projects legacy domains into read-only published catalog entries", async () => {
    const catalog = new TemplateCatalog()
    const empty = async () => []

    const count = await refreshCatalogOnlyTemplateAdapters(catalog, {
      a2ui: async () => [
        {
          id: "dashboard",
          name: "Dashboard",
          payload: { components: [] },
          trust: "built-in",
        },
      ],
      goal: empty,
      scheduler: empty,
      prompt: empty,
      subscription: empty,
      document: empty,
      chatTemplate: empty,
    })

    expect(count).toBe(1)
    expect(catalog.get("catalog.a2ui.dashboard", "1.0.0")).toMatchObject({
      domain: "a2ui",
      status: "published",
      provenance: { source: "built-in", trust: "built-in" },
    })
  })
})

describe("the chatTemplate catalog-only domain", () => {
  const record = {
    id: "tpl_review_abc",
    name: "Review a PR",
    description: "How we ask here",
    payload: {
      name: "Review a PR",
      body: "review {{module}}",
      params: [{ id: "module", label: "module", required: true, kind: "string" }],
    },
    trust: "unsigned" as const,
    version: "3.0.0",
  }
  const empty = async () => []
  const otherDomains = {
    a2ui: empty,
    goal: empty,
    scheduler: empty,
    prompt: empty,
    subscription: empty,
    document: empty,
  }

  afterEach(() => {
    stopCatalogOnlyTemplateWatches()
  })

  it("projects a saved template read-only, keyed on its revision", async () => {
    const catalog = new TemplateCatalog()

    await refreshCatalogOnlyTemplateAdapters(catalog, {
      ...otherDomains,
      chatTemplate: async () => [record],
    })

    // The revision is spent as the version: two edits to one template are two
    // versions of one definition, not one row that silently replaced itself.
    expect(catalog.get("catalog.chatTemplate.tpl_review_abc", "3.0.0")).toMatchObject({
      domain: "chatTemplate",
      status: "published",
      provenance: { source: "user", trust: "unsigned" },
    })
  })

  /**
   * The projection used to be built once at boot, and templates are saved from
   * the COMPOSER, so anything saved after launch was invisible in the Studio
   * until the next one.
   */
  it("re-projects when the table changes, not only at boot", async () => {
    const catalog = new TemplateCatalog()
    let rows: (typeof record)[] = []

    await refreshCatalogOnlyTemplateAdapters(catalog, {
      ...otherDomains,
      chatTemplate: async () => rows,
    })
    expect(catalog.query({ domain: "chatTemplate" })).toEqual([])

    rows = [record]
    await createChatTemplate({ name: "anything", body: "x" })

    await waitFor(() => expect(catalog.query({ domain: "chatTemplate" })).toHaveLength(1))
  })

  it("stops re-projecting into a catalog nobody uses any more", async () => {
    const first = new TemplateCatalog()
    const second = new TemplateCatalog()
    let rows: (typeof record)[] = []
    const reader = async () => rows

    await refreshCatalogOnlyTemplateAdapters(first, { ...otherDomains, chatTemplate: reader })
    await refreshCatalogOnlyTemplateAdapters(second, { ...otherDomains, chatTemplate: reader })

    rows = [record]
    await createChatTemplate({ name: "anything", body: "x" })

    await waitFor(() => expect(second.query({ domain: "chatTemplate" })).toHaveLength(1))
    expect(first.query({ domain: "chatTemplate" })).toEqual([])
  })
})
