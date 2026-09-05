/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { PairFailurePanel } from "./pair-failure-panel"
import type { PairFailure } from "./pair-failure"

const mockWriteClipboardText = jest.fn()

jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (value: string) => mockWriteClipboardText(value),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0
      ? `${key}(${Object.entries(vars)
          .filter(([, value]) => value !== "" && value !== 0)
          .map(([name, value]) => `${name}=${String(value)}`)
          .join(",")})`
      : key,
}))

function failure(patch: Partial<PairFailure> = {}): PairFailure {
  return {
    stage: "register",
    kind: "origin_blocked",
    detail: "Failed to fetch",
    remedies: ["enableBrowserAccess", "allowlistOrigin"],
    retryable: false,
    invitationSpent: false,
    baseUrl: "http://127.0.0.1:27891",
    origin: "http://127.0.0.1:3000",
    loopbackUrl: "http://127.0.0.1:27891",
    ...patch,
  }
}

beforeEach(() => {
  mockWriteClipboardText.mockReset()
  mockWriteClipboardText.mockResolvedValue(undefined)
})

it("names the cause instead of echoing the browser's message", () => {
  render(<PairFailurePanel failure={failure()} />)
  expect(screen.getByTestId("pair-error-title")).toHaveTextContent("failure.title.origin_blocked")
  expect(screen.getByTestId("pair-error")).toHaveAttribute("data-kind", "origin_blocked")
  // The raw text is kept, but not as the headline.
  expect(screen.getByTestId("pair-error-title")).not.toHaveTextContent("Failed to fetch")
})

it("promotes the first remedy and holds the rest behind the disclosure", async () => {
  render(<PairFailurePanel failure={failure()} />)
  // A list of instructions has no first item the eye can find, so the first
  // one is lifted out and the remainder stay collapsed.
  expect(screen.getByTestId("pair-error-next-step")).toHaveTextContent(
    "failure.remedy.enableBrowserAccess"
  )
  expect(screen.queryByTestId("pair-error-remedies")).not.toBeInTheDocument()

  await userEvent.click(screen.getByTestId("pair-error-more-toggle"))
  const remedies = await screen.findByTestId("pair-error-remedies")
  expect(remedies).toHaveTextContent("failure.remedy.allowlistOrigin")
  expect(remedies).toHaveTextContent("origin=http://127.0.0.1:3000")
  // Numbering continues from the promoted step rather than restarting at 1.
  expect(remedies).toHaveTextContent("2")
})

it("offers exactly one button before the disclosure is opened", () => {
  render(
    <PairFailurePanel
      failure={failure({ retryable: true })}
      onRetry={jest.fn()}
      onStartOver={jest.fn()}
    />
  )
  // Retry wins the primary slot; "paste a new invitation" moves under More.
  expect(screen.getByTestId("pair-error-retry")).toBeInTheDocument()
  expect(screen.queryByTestId("pair-error-start-over")).not.toBeInTheDocument()
})

it("prefers a ready-made explanation when the caller has one", () => {
  render(
    <PairFailurePanel
      failure={failure({ kind: "scan_failed", bodyText: "Camera permission denied." })}
    />
  )
  expect(screen.getByTestId("pair-error")).toHaveTextContent("Camera permission denied.")
})

it("warns that a spent invitation cannot be resubmitted", () => {
  render(<PairFailurePanel failure={failure({ kind: "vault_locked", invitationSpent: true })} />)
  expect(screen.getByTestId("pair-invitation-spent")).toHaveTextContent("failure.invitationSpent")
})

it("offers Retry only when resubmitting could actually work", () => {
  const onRetry = jest.fn()
  const { rerender } = render(<PairFailurePanel failure={failure()} onRetry={onRetry} />)
  expect(screen.queryByTestId("pair-error-retry")).not.toBeInTheDocument()

  rerender(<PairFailurePanel failure={failure({ retryable: true })} onRetry={onRetry} />)
  expect(screen.getByTestId("pair-error-retry")).toBeInTheDocument()
})

it("keeps the technical detail available but out of the way", async () => {
  render(<PairFailurePanel failure={failure()} />)
  expect(screen.queryByTestId("pair-error-detail")).not.toBeInTheDocument()

  await userEvent.click(screen.getByTestId("pair-error-more-toggle"))
  const detail = await screen.findByTestId("pair-error-detail")
  expect(detail).toHaveTextContent("Failed to fetch")
  expect(detail).toHaveTextContent("stage: register")
})

it("copies the whole diagnostic block for a bug report", async () => {
  render(<PairFailurePanel failure={failure()} />)
  await userEvent.click(screen.getByTestId("pair-error-more-toggle"))
  await userEvent.click(await screen.findByTestId("pair-error-copy"))
  expect(mockWriteClipboardText).toHaveBeenCalledWith(
    expect.stringContaining("kind: origin_blocked")
  )
  expect(await screen.findByText("failure.diagnosticsCopied")).toBeInTheDocument()
})

it("gives a caller-owned action the primary slot", async () => {
  const onAction = jest.fn()
  const onRetry = jest.fn()
  render(
    <PairFailurePanel
      failure={failure({ retryable: true })}
      action={{ label: "Open Settings", onAction }}
      onRetry={onRetry}
    />
  )
  // A concrete affordance the caller owns beats a generic retry, which is
  // still reachable one disclosure away.
  expect(screen.getByTestId("pair-error-action")).toHaveTextContent("Open Settings")
  expect(screen.queryByTestId("pair-error-retry")).not.toBeInTheDocument()

  await userEvent.click(screen.getByRole("button", { name: "Open Settings" }))
  expect(onAction).toHaveBeenCalled()

  await userEvent.click(screen.getByTestId("pair-error-more-toggle"))
  await userEvent.click(await screen.findByTestId("pair-error-retry"))
  expect(onRetry).toHaveBeenCalled()
})
