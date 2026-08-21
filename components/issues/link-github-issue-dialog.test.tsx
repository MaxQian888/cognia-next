/** @jest-environment jsdom */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const mockLink = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/issues", () => ({
  linkIssueToGithub: (...a: unknown[]) => mockLink(...a),
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

import userEvent from "@testing-library/user-event"
import { render, screen, waitFor } from "@testing-library/react"
import { LinkGithubIssueDialog } from "./link-github-issue-dialog"

function renderDialog(over: Partial<React.ComponentProps<typeof LinkGithubIssueDialog>> = {}) {
  const props: React.ComponentProps<typeof LinkGithubIssueDialog> = {
    open: true,
    onOpenChange: jest.fn(),
    issueId: "i1",
    repos: ["acme/mercury"],
    ...over,
  }
  return { props, ...render(<LinkGithubIssueDialog {...props} />) }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockLink.mockResolvedValue(undefined)
})

describe("LinkGithubIssueDialog", () => {
  it("renders nothing while shut", () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId("link-github-issue-dialog")).not.toBeInTheDocument()
  })

  it("cannot submit without a number", () => {
    renderDialog()
    expect(screen.getByTestId("link-github-submit")).toBeDisabled()
  })

  it("writes the ref, deriving the URL rather than asking for it", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByTestId("link-github-number"), "42")
    await user.click(screen.getByTestId("link-github-submit"))
    await waitFor(() =>
      expect(mockLink).toHaveBeenCalledWith(
        "i1",
        {
          repoFullName: "acme/mercury",
          number: 42,
          htmlUrl: "https://github.com/acme/mercury/issues/42",
        },
        { kind: "human" }
      )
    )
  })

  it("keeps the number field numeric", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByTestId("link-github-number"), "4a2")
    expect(screen.getByTestId("link-github-number")).toHaveValue("42")
  })

  it("refuses zero, which is not an issue number", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByTestId("link-github-number"), "0")
    expect(screen.getByTestId("link-github-submit")).toBeDisabled()
  })

  it("cannot submit with no bound repo to link against", () => {
    renderDialog({ repos: [] })
    expect(screen.getByTestId("link-github-submit")).toBeDisabled()
  })

  it("tells the caller so it can refresh the mirror", async () => {
    const user = userEvent.setup()
    const onLinked = jest.fn()
    renderDialog({ onLinked })
    await user.type(screen.getByTestId("link-github-number"), "7")
    await user.click(screen.getByTestId("link-github-submit"))
    await waitFor(() => expect(onLinked).toHaveBeenCalled())
  })

  it("stays open and reports a failed write", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    mockLink.mockRejectedValueOnce(new Error("gone"))
    renderDialog({ onOpenChange })
    await user.type(screen.getByTestId("link-github-number"), "7")
    await user.click(screen.getByTestId("link-github-submit"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("gone"))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
