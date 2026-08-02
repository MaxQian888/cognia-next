import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { RestoreDialog } from "./restore-dialog"
import type { GitRef } from "@/types/git"

const gitRefs = jest.fn<Promise<GitRef[]>, [string]>()
jest.mock("@/lib/git/commands", () => ({
  gitRefs: (rp: string) => gitRefs(rp),
}))

function makeActions() {
  return { restore: jest.fn().mockResolvedValue(undefined) }
}

beforeEach(() => {
  jest.clearAllMocks()
  gitRefs.mockResolvedValue([
    { name: "main", kind: "branch", targetHash: "a" },
    { name: "v1", kind: "tag", targetHash: "b" },
  ])
})

describe("RestoreDialog", () => {
  it("stays closed when path is null", () => {
    render(
      <RestoreDialog rootDir="/r" path={null} onOpenChange={() => {}} actions={makeActions()} />
    )
    expect(screen.queryByTestId("restore-dialog")).not.toBeInTheDocument()
  })

  it("opens for a path and loads source refs", async () => {
    render(
      <RestoreDialog rootDir="/r" path="a.ts" onOpenChange={() => {}} actions={makeActions()} />
    )
    expect(await screen.findByTestId("restore-dialog")).toBeInTheDocument()
    await waitFor(() => expect(gitRefs).toHaveBeenCalledWith("/r"))
  })

  it("restores from HEAD by default", async () => {
    const actions = makeActions()
    render(<RestoreDialog rootDir="/r" path="a.ts" onOpenChange={() => {}} actions={actions} />)
    await screen.findByTestId("restore-dialog")
    await act(async () => {
      fireEvent.click(screen.getByTestId("restore-confirm"))
    })
    expect(actions.restore).toHaveBeenCalledWith(["a.ts"], false, "HEAD")
  })

  it("restores from a chosen source ref", async () => {
    const actions = makeActions()
    render(<RestoreDialog rootDir="/r" path="a.ts" onOpenChange={() => {}} actions={actions} />)
    await screen.findByTestId("restore-dialog")
    fireEvent.change(screen.getByTestId("restore-source-input"), { target: { value: "v1" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("restore-confirm"))
    })
    expect(actions.restore).toHaveBeenCalledWith(["a.ts"], false, "v1")
  })

  it("closes after a successful restore", async () => {
    const onOpenChange = jest.fn()
    render(
      <RestoreDialog rootDir="/r" path="a.ts" onOpenChange={onOpenChange} actions={makeActions()} />
    )
    await screen.findByTestId("restore-dialog")
    await act(async () => {
      fireEvent.click(screen.getByTestId("restore-confirm"))
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("stays open after a failed restore so the source can be corrected", async () => {
    const actions = makeActions()
    actions.restore.mockResolvedValue({ kind: "notFound", detail: "unknown revision" })
    const onOpenChange = jest.fn()
    render(<RestoreDialog rootDir="/r" path="a.ts" onOpenChange={onOpenChange} actions={actions} />)
    await screen.findByTestId("restore-dialog")

    await act(async () => {
      fireEvent.click(screen.getByTestId("restore-confirm"))
    })

    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByTestId("restore-dialog")).toBeInTheDocument()
  })
})
