/**
 * @jest-environment jsdom
 */
import { render, screen, within } from "@testing-library/react"
import type { ToolUIPart } from "ai"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 20 })),
    getTotalSize: () => count * 20,
    measureElement: jest.fn(),
    scrollToIndex: jest.fn(),
  }),
}))
jest.mock("./workbench-review-button", () => ({
  WorkbenchReviewButton: ({
    sessionId,
    absolutePath,
  }: {
    sessionId?: string
    absolutePath: string
  }) =>
    sessionId ? (
      <button data-testid="workbench-review" data-path={absolutePath}>
        review
      </button>
    ) : null,
}))

import { ApplyPatchCard, PatchFilesPreview, applyPatchFiles } from "./apply-patch-card"

const PATCH = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-const a = 1",
  "+const a = 2",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1 @@",
  "+hello",
  "--- a/old.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
].join("\n")

const part = (state: ToolUIPart["state"], patch = PATCH, output?: string): ToolUIPart =>
  ({
    type: "tool-apply_patch",
    toolCallId: "c1",
    state,
    input: { patch },
    output,
  }) as unknown as ToolUIPart

describe("ApplyPatchCard", () => {
  it("shows one section per file with its change, path, counts and hunks", () => {
    render(<ApplyPatchCard part={part("output-available")} sessionId="s1" />)
    const files = screen.getAllByTestId("mcp-apply-patch-file")
    expect(files.map((f) => f.getAttribute("data-change"))).toEqual([
      "modified",
      "added",
      "deleted",
    ])
    expect(within(files[0]).getByText("src/a.ts")).toBeInTheDocument()
    expect(within(files[0]).getByText("change.modified")).toBeInTheDocument()
    expect(within(files[0]).getByText("+1")).toBeInTheDocument()
    expect(within(files[0]).getAllByTestId("line-diff-line")).toHaveLength(3)
    expect(within(files[0]).getByTestId("line-diff-header")).toHaveTextContent("@@ -1,2 +1,2 @@")
  })

  it("offers review per file only after a multi-file patch landed", () => {
    const { rerender } = render(<ApplyPatchCard part={part("input-available")} sessionId="s1" />)
    expect(screen.queryByTestId("workbench-review")).toBeNull()
    rerender(<ApplyPatchCard part={part("output-available")} sessionId="s1" />)
    expect(
      screen.getAllByTestId("workbench-review").map((b) => b.getAttribute("data-path"))
    ).toEqual(["src/a.ts", "src/new.ts", "old.ts"])
  })

  it("leaves review to the row for a one-file patch", () => {
    const one = PATCH.split("\n").slice(0, 6).join("\n")
    render(<ApplyPatchCard part={part("output-available", one)} sessionId="s1" />)
    expect(screen.getAllByTestId("mcp-apply-patch-file")).toHaveLength(1)
    expect(screen.queryByTestId("workbench-review")).toBeNull()
  })

  it("shows the first line of the tool's result", () => {
    render(
      <ApplyPatchCard
        part={part("output-available", PATCH, "Applied patch to 3 files:\nupdated a\ncreated b")}
      />
    )
    expect(screen.getByTestId("mcp-apply-patch-result")).toHaveTextContent(
      "Applied patch to 3 files:"
    )
  })

  it("renders nothing for a payload without a parsable patch", () => {
    const { container } = render(<ApplyPatchCard part={part("output-available", "not a diff")} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe("PatchFilesPreview", () => {
  it("says why a file has no lines", () => {
    render(
      <PatchFilesPreview
        files={applyPatchFiles({
          patch: [
            "diff --git a/x.png b/x.png",
            "Binary files a/x.png and b/x.png differ",
            "diff --git a/a.ts b/b.ts",
            "rename from a.ts",
            "rename to b.ts",
          ].join("\n"),
        })}
      />
    )
    expect(screen.getByText("binary")).toBeInTheDocument()
    expect(screen.getByText("noTextChanges")).toBeInTheDocument()
    expect(screen.getByText("a.ts → b.ts")).toBeInTheDocument()
  })
})

describe("applyPatchFiles", () => {
  it("reads the patch input and ignores anything else", () => {
    expect(applyPatchFiles({ patch: PATCH })).toHaveLength(3)
    expect(applyPatchFiles({})).toEqual([])
    expect(applyPatchFiles(null)).toEqual([])
  })
})
