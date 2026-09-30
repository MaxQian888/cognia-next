/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}))

const mockPublish = jest.fn()
jest.mock("@/lib/issues/publish", () => ({
  publishIssue: (...a: unknown[]) => mockPublish(...a),
}))
jest.mock("@/lib/issues/github-writeback", () => {
  class GithubWritebackError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
  return { GithubWritebackError }
})

const toastError = jest.fn()
const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}))

import userEvent from "@testing-library/user-event"
import { render, screen, waitFor } from "@testing-library/react"
import { GithubWritebackError } from "@/lib/issues/github-writeback"
import type { PublishTarget } from "@/lib/issues/publish"
import type { IssueSyncBinding } from "@/lib/issues/sync/types"
import { PublishIssueDialog } from "./publish-issue-dialog"

const github: PublishTarget = { kind: "github", id: "github:acme/app", repoFullName: "acme/app" }
const lark: PublishTarget = {
  kind: "binding",
  id: "lark-task:tl-1",
  providerId: "lark-task",
  providerLabel: "Lark tasks",
  resourceName: "Sprint board",
  binding: { key: "tl-1" } as IssueSyncBinding,
}

function renderDialog(over: Partial<React.ComponentProps<typeof PublishIssueDialog>> = {}) {
  const props: React.ComponentProps<typeof PublishIssueDialog> = {
    open: true,
    onOpenChange: jest.fn(),
    issue: { id: "i1", title: "Crash on save", description: "Steps to reproduce" },
    targets: [github, lark],
    onPublished: jest.fn(),
    ...over,
  }
  return { props, ...render(<PublishIssueDialog {...props} />) }
}

beforeEach(() => jest.clearAllMocks())

describe("PublishIssueDialog", () => {
  it("shows exactly what will be created before anything is sent", () => {
    renderDialog()
    expect(screen.getByTestId("publish-issue-preview-title")).toHaveTextContent("Crash on save")
    expect(screen.getByText("Steps to reproduce")).toBeInTheDocument()
    expect(mockPublish).not.toHaveBeenCalled()
  })

  it("says when there is no description", () => {
    renderDialog({ issue: { id: "i1", title: "T" } })
    expect(screen.getByText("publish.noDescription")).toBeInTheDocument()
  })

  it("publishes to the first target by default and closes", async () => {
    const user = userEvent.setup()
    mockPublish.mockResolvedValue({
      provider: "github",
      externalId: "acme/app#9",
      label: "acme/app#9",
    })
    const { props } = renderDialog()
    await user.click(screen.getByTestId("publish-issue-submit"))
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false))
    expect(mockPublish).toHaveBeenCalledWith("i1", github, { kind: "human" })
    expect(props.onPublished).toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("acme/app#9"))
  })

  it("translates an actionable GitHub refusal and stays open", async () => {
    const user = userEvent.setup()
    mockPublish.mockRejectedValue(new GithubWritebackError("no-account", "raw"))
    const { props } = renderDialog()
    await user.click(screen.getByTestId("publish-issue-submit"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("writeback.error.no-account"))
    expect(props.onOpenChange).not.toHaveBeenCalled()
  })

  it("reports any other failure with its reason", async () => {
    const user = userEvent.setup()
    mockPublish.mockRejectedValue(new Error("Lark returned 403"))
    renderDialog()
    await user.click(screen.getByTestId("publish-issue-submit"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Lark returned 403"))
    )
  })
})
