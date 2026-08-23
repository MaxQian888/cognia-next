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

it("interpolates this tab's own origin into the allowlist remedy", () => {
  render(<PairFailurePanel failure={failure()} />)
  const remedies = screen.getByTestId("pair-error-remedies")
  expect(remedies).toHaveTextContent("failure.remedy.enableBrowserAccess")
  expect(remedies).toHaveTextContent("origin=http://127.0.0.1:3000")
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
  expect(screen.getByTestId("pair-invitation-spent")).toHaveTextContent(
    "failure.invitationSpent"
  )
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

  await userEvent.click(screen.getByTestId("pair-error-detail-toggle"))
  const detail = await screen.findByTestId("pair-error-detail")
  expect(detail).toHaveTextContent("Failed to fetch")
  expect(detail).toHaveTextContent("stage: register")
})

it("copies the whole diagnostic block for a bug report", async () => {
  render(<PairFailurePanel failure={failure()} />)
  await userEvent.click(screen.getByTestId("pair-error-copy"))
  expect(mockWriteClipboardText).toHaveBeenCalledWith(
    expect.stringContaining("kind: origin_blocked")
  )
  expect(await screen.findByText("failure.diagnosticsCopied")).toBeInTheDocument()
})

it("renders a caller-owned action alongside the remedies", async () => {
  const onAction = jest.fn()
  render(
    <PairFailurePanel failure={failure()} action={{ label: "Open Settings", onAction }} />
  )
  await userEvent.click(screen.getByRole("button", { name: "Open Settings" }))
  expect(onAction).toHaveBeenCalled()
})
