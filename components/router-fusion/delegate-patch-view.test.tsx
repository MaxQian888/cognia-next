/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Monaco does not run in jsdom; the diff viewer's contract here is that it is
// handed the workspace's content and the patch's, which the stub records.
jest.mock("@/components/source-control/diff-viewer", () => ({
  DiffViewer: ({ diff }: { diff: { path: string; oldContent: string; newContent: string } }) => (
    <pre data-testid={`diff-${diff.path}`}>
      {diff.oldContent}|{diff.newContent}
    </pre>
  ),
}))

import { DelegatePatchView } from "./delegate-patch-view"
import type { DelegatePatchView as DelegatePatchModel } from "./delegate-review-model"

function patch(over: Partial<DelegatePatchModel> = {}): DelegatePatchModel {
  return {
    patchSetId: "patch-1",
    baseRevision: "git:abc",
    resultRevision: "staged:def",
    patchSha256: "a".repeat(64),
    patchArtifactId: "artifact-1",
    fileCount: 2,
    paths: ["src/a.ts", "src/gone.ts"],
    delivery: "patch_only",
    appliedRevision: null,
    appliedAt: null,
    document: "{}",
    comparedRevision: "git:abc",
    comparedAtBase: true,
    files: [
      {
        path: "src/a.ts",
        action: "write",
        newContent: "next\n",
        baseContent: "previous\n",
        baseState: "read",
        unchanged: false,
      },
      {
        path: "src/gone.ts",
        action: "delete",
        newContent: null,
        baseContent: null,
        baseState: "read",
        unchanged: false,
      },
    ],
    ...over,
  }
}

describe("DelegatePatchView", () => {
  it("renders each written file in the source-control diff viewer", () => {
    render(<DelegatePatchView patch={patch()} />)
    expect(screen.getByTestId("diff-src/a.ts")).toHaveTextContent(/previous\s*\|\s*next/)
    // A delete has no content to diff; it is labelled instead.
    expect(screen.queryByTestId("diff-src/gone.ts")).not.toBeInTheDocument()
    expect(screen.getAllByTestId("delegate-patch-file")).toHaveLength(2)
    expect(screen.getByTestId("delegate-patch")).toHaveTextContent(
      "Compared against your workspace, which is still at the patch's base revision."
    )
  })

  it("[ACC:DEL-04] warns when the workspace has moved away from the patch's base", () => {
    render(
      <DelegatePatchView patch={patch({ comparedRevision: "git:moved", comparedAtBase: false })} />
    )
    expect(screen.getByTestId("delegate-patch")).toHaveTextContent(
      "Your workspace has moved to git:moved since this patch was made against git:abc"
    )
  })

  it("says a file's base could not be read instead of showing a silent all-added diff", () => {
    render(
      <DelegatePatchView
        patch={patch({
          comparedRevision: null,
          comparedAtBase: false,
          files: [
            {
              path: "src/a.ts",
              action: "write",
              newContent: "next\n",
              baseContent: null,
              baseState: "unavailable",
              unchanged: false,
            },
          ],
        })}
      />
    )
    const view = screen.getByTestId("delegate-patch")
    expect(view).toHaveTextContent("Your workspace could not be read on this device")
    expect(view).toHaveTextContent("The current file could not be read here")
    expect(screen.getByTestId("diff-src/a.ts")).toHaveTextContent("|next")
  })

  it("reports the delivery and whether the patch was written into the workspace", () => {
    render(
      <DelegatePatchView
        patch={patch({ delivery: "workspace_updated", appliedRevision: "git:zzz" })}
      />
    )
    const view = screen.getByTestId("delegate-patch")
    expect(view).toHaveTextContent("Applied to your workspace")
    expect(screen.getByTestId("delegate-patch-applied")).toHaveTextContent(
      "Written into your workspace at git:zzz"
    )
  })

  it("offers the download only while the patch document is still stored", async () => {
    const user = userEvent.setup()
    const onDownload = jest.fn()
    const { rerender } = render(<DelegatePatchView patch={patch()} onDownload={onDownload} />)
    await user.click(screen.getByRole("button", { name: "Download patch" }))
    expect(onDownload).toHaveBeenCalledTimes(1)

    rerender(<DelegatePatchView patch={patch({ document: null })} onDownload={onDownload} />)
    expect(screen.queryByRole("button", { name: "Download patch" })).not.toBeInTheDocument()
    expect(screen.getByTestId("delegate-patch-expired")).toHaveTextContent(
      "The patch document is no longer stored"
    )
  })

  it("says the run staged no patch when there is none", () => {
    render(<DelegatePatchView patch={null} />)
    expect(screen.getByTestId("delegate-patch")).toHaveTextContent("This run staged no patch.")
  })
})
