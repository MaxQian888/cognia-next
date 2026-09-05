import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { groupImageLineages, withImageEditVersion } from "@/lib/chat/image-edit/version"

import { VersionRail, railItemsFromLineages, type VersionRailItem } from "./version-rail"

const items: VersionRailItem[] = [
  {
    url: "cognia-media:a",
    displayUrl: "blob:a",
    lineageId: "cognia-media:a",
    depth: 0,
    operations: [],
  },
  {
    url: "cognia-media:b",
    displayUrl: "blob:b",
    lineageId: "cognia-media:a",
    depth: 1,
    operations: ["crop", "adjust"],
  },
]

describe("VersionRail", () => {
  it("renders nothing when there is nothing to show", () => {
    const { container } = render(<VersionRail items={[]} activeUrl={null} onSelect={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists every entry and marks the active one", () => {
    render(<VersionRail items={items} activeUrl="cognia-media:b" onSelect={() => {}} />)
    const rows = screen.getAllByTestId("workbench-version-item")
    expect(rows).toHaveLength(2)
    expect(rows[1]).toHaveAttribute("aria-pressed", "true")
    expect(rows[0]).toHaveAttribute("aria-pressed", "false")
  })

  it("labels the original so the untouched image is always identifiable", () => {
    render(<VersionRail items={items} activeUrl={null} onSelect={() => {}} />)
    expect(screen.getByText("Original")).toBeInTheDocument()
    expect(screen.getByLabelText("Original image")).toBeInTheDocument()
  })

  it("names a derived version by what was done to it", () => {
    render(<VersionRail items={items} activeUrl={null} onSelect={() => {}} />)
    expect(screen.getByLabelText("Version: crop, adjust")).toBeInTheDocument()
  })

  it("indents a version by its depth in the lineage", () => {
    render(<VersionRail items={items} activeUrl={null} onSelect={() => {}} />)
    const rows = screen.getAllByTestId("workbench-version-item")
    expect(rows[0].style.marginInlineStart).toBe("0")
    expect(rows[1]).toHaveStyle({ marginInlineStart: "6px" })
  })

  it("selects an entry when it is clicked", async () => {
    const onSelect = jest.fn()
    render(<VersionRail items={items} activeUrl={null} onSelect={onSelect} />)
    await userEvent.click(screen.getAllByTestId("workbench-version-item")[1])
    expect(onSelect).toHaveBeenCalledWith("cognia-media:b")
  })

  it("shows an unsaved marker while an edit is open", () => {
    render(<VersionRail items={items} activeUrl={null} onSelect={() => {}} draftLabel="Unsaved" />)
    expect(screen.getByTestId("workbench-version-draft")).toHaveTextContent("Unsaved")
  })
})

describe("railItemsFromLineages", () => {
  it("flattens grouped lineages into rows with their display urls", () => {
    const lineages = groupImageLineages([
      { type: "file", url: "cognia-media:a", mediaType: "image/png" },
      withImageEditVersion(
        { type: "file", url: "cognia-media:b", mediaType: "image/png" },
        {
          schemaVersion: 1,
          lineageId: "cognia-media:a",
          versionId: "v1",
          parentVersionId: null,
          operations: ["crop"],
          editedAt: 1,
        }
      ),
    ])
    const rows = railItemsFromLineages(lineages, (url) => `blob:${url}`)
    expect(rows).toEqual([
      {
        url: "cognia-media:a",
        displayUrl: "blob:cognia-media:a",
        lineageId: "cognia-media:a",
        depth: 0,
        operations: [],
      },
      {
        url: "cognia-media:b",
        displayUrl: "blob:cognia-media:b",
        lineageId: "cognia-media:a",
        depth: 1,
        operations: ["crop"],
      },
    ])
  })
})

describe("versions a model produced", () => {
  const withAi: VersionRailItem[] = [
    ...items,
    {
      url: "cognia-media:c",
      displayUrl: "blob:c",
      lineageId: "cognia-media:a",
      depth: 2,
      operations: ["ai.region"],
    },
  ]

  it("badges an AI version so it is distinguishable from a hand-made one", () => {
    render(<VersionRail items={withAi} activeUrl={null} onSelect={() => {}} />)
    const badges = screen.getAllByTestId("workbench-version-ai-badge")
    expect(badges).toHaveLength(1)
    expect(badges[0]).toHaveTextContent("AI")
  })

  it("names the model in the accessible label", () => {
    render(<VersionRail items={withAi} activeUrl={null} onSelect={() => {}} />)
    expect(screen.getByLabelText("Version made by a model: ai.region")).toBeInTheDocument()
    expect(screen.getByLabelText("Version: crop, adjust")).toBeInTheDocument()
  })
})
