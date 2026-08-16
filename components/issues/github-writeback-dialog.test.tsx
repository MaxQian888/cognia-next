/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockToastSuccess = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => mockToastSuccess(...a) } }))

const mockResolveAccount = jest.fn()
const mockRunWriteback = jest.fn()
jest.mock("@/lib/issues/github-writeback", () => {
  class GithubWritebackError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.name = "GithubWritebackError"
      this.code = code
    }
  }
  return {
    GithubWritebackError,
    resolveGithubWritebackAccount: (...a: unknown[]) => mockResolveAccount(...a),
    runGithubWriteback: (...a: unknown[]) => mockRunWriteback(...a),
  }
})

import userEvent from "@testing-library/user-event"
import { render, screen, waitFor } from "@testing-library/react"
import { GithubWritebackDialog } from "./github-writeback-dialog"
import { GithubWritebackError } from "@/lib/issues/github-writeback"

const TARGET = { repoFullName: "acme/one", number: 7 }

function renderDialog(overrides: Partial<React.ComponentProps<typeof GithubWritebackDialog>> = {}) {
  const props: React.ComponentProps<typeof GithubWritebackDialog> = {
    open: true,
    onOpenChange: jest.fn(),
    kind: "comment",
    target: TARGET,
    ...overrides,
  }
  return { ...render(<GithubWritebackDialog {...props} />), props }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockResolveAccount.mockResolvedValue({ id: "acct-1", label: "acme (PAT)", enabled: true })
  mockRunWriteback.mockResolvedValue({ id: "job-1", status: "succeeded" })
})

async function accountResolved() {
  await waitFor(() =>
    expect(screen.getByTestId("writeback-account")).toHaveTextContent("writeback.account")
  )
}

it("names the account the write goes out on before anything is sent", async () => {
  renderDialog()
  // Two connected accounts is normal; which one is about to comment publicly is
  // exactly what a user cannot recover from getting wrong.
  await accountResolved()
})

it("blocks confirmation entirely when no account is connected", async () => {
  mockResolveAccount.mockResolvedValue(null)
  const user = userEvent.setup()
  renderDialog()

  await waitFor(() =>
    expect(screen.getByTestId("writeback-account")).toHaveTextContent("writeback.error.no-account")
  )
  await user.type(screen.getByTestId("writeback-body"), "looks good")
  expect(screen.getByTestId("writeback-confirm")).toBeDisabled()
})

it("requires a non-empty comment", async () => {
  const user = userEvent.setup()
  renderDialog()
  await accountResolved()

  expect(screen.getByTestId("writeback-confirm")).toBeDisabled()
  await user.type(screen.getByTestId("writeback-body"), "looks good")
  expect(screen.getByTestId("writeback-confirm")).toBeEnabled()
})

it("passes the confirmation through as the approval — nothing else may", async () => {
  const user = userEvent.setup()
  const onCompleted = jest.fn()
  const { props } = renderDialog({ onCompleted })
  await accountResolved()

  await user.type(screen.getByTestId("writeback-body"), "looks good")
  await user.click(screen.getByTestId("writeback-confirm"))

  await waitFor(() => expect(mockRunWriteback).toHaveBeenCalled())
  expect(mockRunWriteback).toHaveBeenCalledWith({
    target: TARGET,
    action: { kind: "comment", body: "looks good" },
    approval: "user-confirmed",
  })
  expect(mockToastSuccess).toHaveBeenCalledWith("writeback.success")
  expect(onCompleted).toHaveBeenCalledTimes(1)
  expect(props.onOpenChange).toHaveBeenCalledWith(false)
})

it("splits comma-separated labels and drops the empties", async () => {
  const user = userEvent.setup()
  renderDialog({ kind: "label" })
  await accountResolved()

  await user.type(screen.getByTestId("writeback-labels"), " bug , , needs-triage ")
  await user.click(screen.getByTestId("writeback-confirm"))

  await waitFor(() => expect(mockRunWriteback).toHaveBeenCalled())
  expect(mockRunWriteback.mock.calls[0][0].action).toEqual({
    kind: "label",
    labels: ["bug", "needs-triage"],
  })
})

it("refuses a label write with nothing but separators", async () => {
  const user = userEvent.setup()
  renderDialog({ kind: "label" })
  await accountResolved()

  await user.type(screen.getByTestId("writeback-labels"), " , , ")
  expect(screen.getByTestId("writeback-confirm")).toBeDisabled()
})

it("closes as `completed` by default and keeps `not_planned` distinct", async () => {
  const user = userEvent.setup()
  renderDialog({ kind: "close" })
  await accountResolved()

  // A close needs no input, so it is confirmable immediately.
  await user.click(screen.getByTestId("writeback-confirm"))
  await waitFor(() => expect(mockRunWriteback).toHaveBeenCalled())
  expect(mockRunWriteback.mock.calls[0][0].action).toEqual({
    kind: "close",
    reason: "completed",
  })
})

it("sends the chosen close reason", async () => {
  const user = userEvent.setup()
  renderDialog({ kind: "close" })
  await accountResolved()

  await user.click(screen.getByTestId("writeback-reason"))
  await user.click(await screen.findByRole("option", { name: "writeback.reason.not_planned" }))
  await user.click(screen.getByTestId("writeback-confirm"))

  await waitFor(() => expect(mockRunWriteback).toHaveBeenCalled())
  expect(mockRunWriteback.mock.calls[0][0].action).toEqual({
    kind: "close",
    reason: "not_planned",
  })
})

it("localizes a known refusal instead of showing its raw message", async () => {
  const user = userEvent.setup()
  mockRunWriteback.mockRejectedValue(
    new GithubWritebackError("plugin-unavailable", 'Integration "github" is not registered')
  )
  const { props } = renderDialog()
  await accountResolved()

  await user.type(screen.getByTestId("writeback-body"), "hi")
  await user.click(screen.getByTestId("writeback-confirm"))

  await waitFor(() =>
    expect(screen.getByTestId("writeback-error")).toHaveTextContent(
      "writeback.error.plugin-unavailable"
    )
  )
  expect(props.onOpenChange).not.toHaveBeenCalledWith(false)
})

it("shows GitHub's own words for anything it cannot classify", async () => {
  const user = userEvent.setup()
  mockRunWriteback.mockRejectedValue(new Error("Validation Failed: label does not exist"))
  renderDialog({ kind: "label" })
  await accountResolved()

  await user.type(screen.getByTestId("writeback-labels"), "nope")
  await user.click(screen.getByTestId("writeback-confirm"))

  await waitFor(() =>
    expect(screen.getByTestId("writeback-error")).toHaveTextContent("label does not exist")
  )
})

it("does not fire the write-back at all until confirmed", async () => {
  renderDialog()
  await accountResolved()
  expect(mockRunWriteback).not.toHaveBeenCalled()
})
