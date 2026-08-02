import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TagPanel } from "./tag-panel"
import type { GitTag } from "@/types/git"

const gitTags = jest.fn<Promise<GitTag[]>, [string]>()
jest.mock("@/lib/git/commands", () => ({
  gitTags: (rp: string) => gitTags(rp),
}))

const tags: GitTag[] = [
  { name: "v1.0", targetHash: "abcdef1234567890", message: null, isAnnotated: false },
  { name: "v2.0", targetHash: "1234567890abcdef", message: "release two", isAnnotated: true },
]

function makeActions() {
  return {
    createTag: jest.fn().mockResolvedValue(undefined),
    deleteTag: jest.fn().mockResolvedValue(undefined),
    pushTag: jest.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  gitTags.mockResolvedValue(tags)
})

describe("TagPanel", () => {
  it("loads and lists tags when opened", async () => {
    render(<TagPanel open rootDir="/repo" onOpenChange={() => {}} actions={makeActions()} />)
    await waitFor(() => expect(gitTags).toHaveBeenCalledWith("/repo"))
    expect(await screen.findByTestId("tag-entry-v1.0")).toBeInTheDocument()
    expect(screen.getByTestId("tag-entry-v2.0")).toHaveTextContent("release two")
  })

  it("creates an annotated tag and reloads", async () => {
    const actions = makeActions()
    render(<TagPanel open rootDir="/repo" onOpenChange={() => {}} actions={actions} />)
    await waitFor(() => expect(gitTags).toHaveBeenCalled())
    fireEvent.change(screen.getByTestId("tag-name"), { target: { value: "v3.0" } })
    fireEvent.change(screen.getByTestId("tag-message"), { target: { value: "third" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("tag-create"))
    })
    expect(actions.createTag).toHaveBeenCalledWith("v3.0", "third")
    expect(gitTags).toHaveBeenCalledTimes(2)
  })

  it("keeps tag input intact and does not reload after a failed create", async () => {
    const actions = makeActions()
    actions.createTag.mockResolvedValue({ kind: "commandFailed", detail: "tag exists" })
    render(<TagPanel open rootDir="/repo" onOpenChange={() => {}} actions={actions} />)
    await waitFor(() => expect(gitTags).toHaveBeenCalled())
    fireEvent.change(screen.getByTestId("tag-name"), { target: { value: "v3.0" } })
    fireEvent.change(screen.getByTestId("tag-message"), { target: { value: "keep me" } })

    await act(async () => {
      fireEvent.click(screen.getByTestId("tag-create"))
    })

    expect(screen.getByTestId("tag-name")).toHaveValue("v3.0")
    expect(screen.getByTestId("tag-message")).toHaveValue("keep me")
    expect(gitTags).toHaveBeenCalledTimes(1)
  })

  it("creates a lightweight tag with no message", async () => {
    const actions = makeActions()
    render(<TagPanel open rootDir="/repo" onOpenChange={() => {}} actions={actions} />)
    await waitFor(() => expect(gitTags).toHaveBeenCalled())
    fireEvent.change(screen.getByTestId("tag-name"), { target: { value: "v3.0" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("tag-create"))
    })
    expect(actions.createTag).toHaveBeenCalledWith("v3.0", undefined)
  })

  it("disables create with an empty name", async () => {
    render(<TagPanel open rootDir="/repo" onOpenChange={() => {}} actions={makeActions()} />)
    await waitFor(() => expect(gitTags).toHaveBeenCalled())
    expect(screen.getByTestId("tag-create")).toBeDisabled()
  })

  it("deletes a tag and reloads", async () => {
    const actions = makeActions()
    render(<TagPanel open rootDir="/repo" onOpenChange={() => {}} actions={actions} />)
    expect(await screen.findByTestId("tag-entry-v1.0")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByTestId("tag-delete-v1.0"))
    })
    expect(actions.deleteTag).toHaveBeenCalledWith("v1.0")
    expect(gitTags).toHaveBeenCalledTimes(2)
  })

  it("pushes a tag to the remote", async () => {
    const actions = makeActions()
    render(<TagPanel open rootDir="/repo" onOpenChange={() => {}} actions={actions} />)
    expect(await screen.findByTestId("tag-entry-v1.0")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("tag-push-v1.0"))
    expect(actions.pushTag).toHaveBeenCalledWith("v1.0")
  })

  it("shows empty state with no tags", async () => {
    gitTags.mockResolvedValue([])
    render(<TagPanel open rootDir="/repo" onOpenChange={() => {}} actions={makeActions()} />)
    await waitFor(() => expect(gitTags).toHaveBeenCalled())
    expect(screen.getByTestId("tag-panel")).toBeInTheDocument()
  })
})
