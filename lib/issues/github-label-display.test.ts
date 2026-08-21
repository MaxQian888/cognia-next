import { statusCategoryOf } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import {
  buildGithubLabelRows,
  buildIssueLabelCatalogue,
  githubLabelName,
  isGithubLabelId,
} from "./github-label-display"

let seq = 0
function item(labelIds: string[], kind: UnifiedIssueItem["kind"] = "github"): UnifiedIssueItem {
  seq += 1
  return {
    unifiedId: `${kind}:s${seq}`,
    kind,
    sourceId: `s${seq}`,
    identifier: `KEY-${seq}`,
    title: `Issue ${seq}`,
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds,
    order: 0,
    createdAt: seq,
    updatedAt: seq,
    origin: { deepLinkHref: "/issues" },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
  }
}

const localLabel = (id: string, name: string): LabelRow => ({
  id,
  scope: "issue",
  name,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
})

beforeEach(() => {
  seq = 0
})

describe("isGithubLabelId / githubLabelName", () => {
  it("recognises the namespaced form", () => {
    expect(isGithubLabelId("github:bug")).toBe(true)
    expect(isGithubLabelId("lbl_local")).toBe(false)
  })

  it("strips the prefix", () => {
    expect(githubLabelName("github:good first issue")).toBe("good first issue")
  })

  it("returns null for a local id", () => {
    expect(githubLabelName("lbl_local")).toBeNull()
  })

  it("returns null for a prefix with no name behind it", () => {
    expect(githubLabelName("github:")).toBeNull()
  })

  it("keeps colons inside the label name", () => {
    expect(githubLabelName("github:area:ui")).toBe("area:ui")
  })
})

describe("buildGithubLabelRows", () => {
  it("returns nothing when no item carries a GitHub label", () => {
    expect(buildGithubLabelRows([item(["lbl_a"], "local")])).toEqual([])
  })

  it("recovers the human name, which is the bug: the raw id used to be shown", () => {
    const [row] = buildGithubLabelRows([item(["github:bug"])])
    expect(row.name).toBe("bug")
    expect(row.id).toBe("github:bug")
  })

  it("de-duplicates a label shared by several issues", () => {
    expect(buildGithubLabelRows([item(["github:bug"]), item(["github:bug"])])).toHaveLength(1)
  })

  it("sorts by name, not by which issue loaded first", () => {
    const rows = buildGithubLabelRows([item(["github:zeta", "github:alpha"])])
    expect(rows.map((row) => row.name)).toEqual(["alpha", "zeta"])
  })

  it("gives every label a colour so no swatch renders blank", () => {
    expect(buildGithubLabelRows([item(["github:bug"])])[0].color).toBeTruthy()
  })

  it("gives the same name the same colour across calls", () => {
    const first = buildGithubLabelRows([item(["github:bug"])])[0].color
    const second = buildGithubLabelRows([item(["github:bug"])])[0].color
    expect(first).toBe(second)
  })

  it("marks the rows builtin so no management UI offers to rename GitHub's labels", () => {
    expect(buildGithubLabelRows([item(["github:bug"])])[0].builtin).toBe(true)
  })

  it("ignores local ids mixed into the same item", () => {
    const rows = buildGithubLabelRows([item(["github:bug", "lbl_local"])])
    expect(rows.map((row) => row.id)).toEqual(["github:bug"])
  })
})

describe("buildIssueLabelCatalogue", () => {
  it("resolves both local and GitHub ids through one map", () => {
    const catalogue = buildIssueLabelCatalogue(
      [localLabel("lbl_a", "feature")],
      [item(["github:bug"])]
    )
    expect(catalogue.get("lbl_a")?.name).toBe("feature")
    expect(catalogue.get("github:bug")?.name).toBe("bug")
  })

  it("keeps unknown ids unresolved rather than inventing a row", () => {
    expect(buildIssueLabelCatalogue([], [item(["lbl_ghost"], "local")]).has("lbl_ghost")).toBe(
      false
    )
  })

  it("lets a local row win an id collision", () => {
    const catalogue = buildIssueLabelCatalogue(
      [localLabel("github:bug", "mine")],
      [item(["github:bug"])]
    )
    expect(catalogue.get("github:bug")?.name).toBe("mine")
    expect(catalogue.get("github:bug")?.builtin).toBeUndefined()
  })
})
