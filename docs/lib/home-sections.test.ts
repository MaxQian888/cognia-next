import { findTopLevelPage, homeGroups, type TreeNode } from "./home-sections"

const page = (name: string, url: string): TreeNode => ({ type: "page", name, url })

const tree: TreeNode[] = [
  { type: "separator", name: "Getting started" },
  page("Overview", "/en/docs"),
  page("Getting started", "/en/docs/getting-started"),
  { type: "separator", name: "Core architecture" },
  {
    type: "folder",
    name: "Core Architecture",
    children: [
      page("Architecture", "/en/docs/core/architecture"),
      page("Runtime", "/en/docs/core/runtime"),
      page("Sidecar", "/en/docs/core/sidecar"),
      page("Extra", "/en/docs/core/extra"),
    ],
  },
  { type: "separator", name: "Technical reference" },
  {
    type: "folder",
    name: "ADR",
    index: { type: "page", name: "ADR index", url: "/en/docs/adr" },
    children: [
      page("0001", "/en/docs/adr/0001"),
      {
        type: "folder",
        name: "Nested",
        children: [page("Deep", "/en/docs/adr/nested/deep")],
      },
    ],
  },
  { type: "folder", name: "Empty", children: [] },
]

describe("homeGroups", () => {
  it("groups top-level folders under the separator that precedes them", () => {
    const groups = homeGroups(tree)
    expect(groups.map((group) => group.label)).toEqual(["Core architecture", "Technical reference"])
    expect(groups[0].sections.map((section) => section.title)).toEqual(["Core Architecture"])
  })

  it("drops a group whose only entries are top-level pages", () => {
    expect(homeGroups(tree).some((group) => group.label === "Getting started")).toBe(false)
  })

  it("links an area to its index page, else its first page", () => {
    const [core, reference] = homeGroups(tree)
    expect(core.sections[0].href).toBe("/en/docs/core/architecture")
    expect(reference.sections[0].href).toBe("/en/docs/adr")
  })

  it("counts nested pages and previews only the first three titles", () => {
    const [core, reference] = homeGroups(tree)
    expect(core.sections[0].pageCount).toBe(4)
    expect(core.sections[0].preview).toEqual(["Architecture", "Runtime", "Sidecar"])
    expect(reference.sections[0].pageCount).toBe(3)
  })

  it("skips folders with no pages instead of rendering a dead card", () => {
    const titles = homeGroups(tree).flatMap((group) => group.sections.map((s) => s.title))
    expect(titles).not.toContain("Empty")
  })

  it("keeps folders that appear before any separator in an unlabelled group", () => {
    const groups = homeGroups([
      { type: "folder", name: "Loose", children: [page("A", "/en/docs/a")] },
    ])
    expect(groups).toEqual([
      {
        label: null,
        sections: [{ title: "Loose", href: "/en/docs/a", pageCount: 1, preview: ["A"] }],
      },
    ])
  })
})

describe("findTopLevelPage", () => {
  it("finds a top-level page by its last path segment", () => {
    expect(findTopLevelPage(tree, "getting-started")).toBe("/en/docs/getting-started")
  })

  it("returns null when no top-level page matches", () => {
    expect(findTopLevelPage(tree, "architecture")).toBeNull()
  })
})
