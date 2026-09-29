import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/browser/local-client", () => ({ localBrowser: { onEvent: jest.fn() } }))
jest.mock("@/lib/browser/passwords", () => ({
  ...jest.requireActual("@/lib/browser/passwords"),
  getPendingSave: jest.fn(),
  resolvePendingSave: jest.fn(),
}))

import { toast } from "sonner"
import { localBrowser } from "@/lib/browser/local-client"
import { getPendingSave, resolvePendingSave } from "@/lib/browser/passwords"

import {
  asCredentialSubmitted,
  BrowserSavePasswordPrompt,
  pendingSaveDecision,
} from "./browser-save-password-prompt"

const copy = en.browserVault.savePrompt

let emit: (event: unknown) => void = () => undefined
const unlisten = jest.fn()

function submitted(overrides: Record<string, unknown> = {}) {
  return {
    type: "credential.submitted",
    sessionId: "s1",
    origin: "https://github.com",
    username: "octocat",
    pendingId: "p1",
    ...overrides,
  }
}

async function emitAndSettle(event: unknown) {
  await act(async () => {
    emit(event)
    await Promise.resolve()
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(localBrowser.onEvent as jest.Mock).mockImplementation(async (cb: (e: unknown) => void) => {
    emit = cb
    return unlisten
  })
  ;(getPendingSave as jest.Mock).mockImplementation(async (pendingId: string) => ({
    origin: "https://github.com",
    username: pendingId === "p2" ? "hubot" : "octocat",
    kind: "save",
  }))
  ;(resolvePendingSave as jest.Mock).mockResolvedValue(null)
})

describe("asCredentialSubmitted", () => {
  it("accepts only complete credential.submitted payloads without a password", () => {
    expect(asCredentialSubmitted(submitted())).toEqual({
      sessionId: "s1",
      origin: "https://github.com",
      username: "octocat",
      pendingId: "p1",
    })
    expect(asCredentialSubmitted(submitted({ password: "x" }))).not.toHaveProperty("password")
    expect(asCredentialSubmitted(submitted({ type: "pages.changed" }))).toBeNull()
    expect(asCredentialSubmitted(submitted({ pendingId: "" }))).toBeNull()
    expect(asCredentialSubmitted(submitted({ username: 1 }))).toBeNull()
    expect(asCredentialSubmitted(null)).toBeNull()
  })
})

it("asks to save a new credential and resolves the pending save", async () => {
  const user = userEvent.setup()
  render(<BrowserSavePasswordPrompt />)
  await waitFor(() => expect(localBrowser.onEvent).toHaveBeenCalled())
  await emitAndSettle(submitted())
  const region = await screen.findByRole("region", { name: copy.region })
  expect(region).toHaveTextContent(copy.saveTitle)
  expect(region).toHaveTextContent("Save the password for octocat on https://github.com?")
  expect(getPendingSave).toHaveBeenCalledWith("p1")
  await user.click(screen.getByRole("button", { name: copy.save }))
  await waitFor(() => expect(resolvePendingSave).toHaveBeenCalledWith("p1", "save"))
  expect(toast.success).toHaveBeenCalledWith(copy.saved)
  expect(screen.queryByRole("region")).toBeNull()
})

it("offers update when the username is already saved for the site", async () => {
  const user = userEvent.setup()
  ;(getPendingSave as jest.Mock).mockResolvedValue({
    origin: "https://github.com",
    username: "octocat",
    kind: "update",
    id: "c1",
  })
  render(<BrowserSavePasswordPrompt />)
  await waitFor(() => expect(localBrowser.onEvent).toHaveBeenCalled())
  await emitAndSettle(submitted())
  expect(await screen.findByText(copy.updateTitle)).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: copy.update }))
  await waitFor(() => expect(resolvePendingSave).toHaveBeenCalledWith("p1", "update"))
  expect(toast.success).toHaveBeenCalledWith(copy.updated)
})

it("queues submissions, resolves never / dismiss, and ignores duplicates", async () => {
  const user = userEvent.setup()
  render(<BrowserSavePasswordPrompt />)
  await waitFor(() => expect(localBrowser.onEvent).toHaveBeenCalled())
  await emitAndSettle(submitted())
  await emitAndSettle(submitted())
  await emitAndSettle(submitted({ pendingId: "p2", username: "hubot" }))
  expect(await screen.findByText(/^1 more waiting/)).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: copy.never }))
  await waitFor(() => expect(resolvePendingSave).toHaveBeenCalledWith("p1", "never"))
  expect(await screen.findByText(/hubot/)).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: copy.dismiss }))
  await waitFor(() => expect(resolvePendingSave).toHaveBeenCalledWith("p2", "dismiss"))
  expect(screen.queryByRole("region")).toBeNull()
  expect(toast.success).not.toHaveBeenCalled()
})

it("only prompts for its own session", async () => {
  render(<BrowserSavePasswordPrompt sessionId="s1" />)
  await waitFor(() => expect(localBrowser.onEvent).toHaveBeenCalled())
  await emitAndSettle(submitted({ sessionId: "other" }))
  expect(screen.queryByRole("region")).toBeNull()
  expect(getPendingSave).not.toHaveBeenCalled()
})

it("keeps the prompt when resolving fails", async () => {
  const user = userEvent.setup()
  ;(resolvePendingSave as jest.Mock).mockRejectedValue(new Error("expired"))
  render(<BrowserSavePasswordPrompt />)
  await waitFor(() => expect(localBrowser.onEvent).toHaveBeenCalled())
  await emitAndSettle(submitted())
  await user.click(await screen.findByRole("button", { name: copy.save }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy.failed))
  expect(screen.getByRole("region")).toBeInTheDocument()
})

it.each(["unchanged", "suppressed"])(
  "silently dismisses a %s submission without prompting",
  async (kind) => {
    ;(getPendingSave as jest.Mock).mockResolvedValue({
      origin: "https://github.com",
      username: "octocat",
      kind,
    })
    render(<BrowserSavePasswordPrompt />)
    await waitFor(() => expect(localBrowser.onEvent).toHaveBeenCalled())
    await emitAndSettle(submitted())
    await waitFor(() => expect(resolvePendingSave).toHaveBeenCalledWith("p1", "dismiss"))
    expect(screen.queryByRole("region")).toBeNull()
  }
)

it("skips an expired pending save", async () => {
  ;(getPendingSave as jest.Mock).mockResolvedValue(null)
  render(<BrowserSavePasswordPrompt />)
  await waitFor(() => expect(localBrowser.onEvent).toHaveBeenCalled())
  await emitAndSettle(submitted())
  await waitFor(() => expect(getPendingSave).toHaveBeenCalledWith("p1"))
  await act(async () => {
    await Promise.resolve()
  })
  expect(screen.queryByRole("region")).toBeNull()
  expect(resolvePendingSave).not.toHaveBeenCalled()
})

describe("pendingSaveDecision", () => {
  it("maps each classification to prompt, dismiss or skip", () => {
    const base = { origin: "https://a.com", username: "me" }
    expect(pendingSaveDecision({ ...base, kind: "save" })).toEqual({
      kind: "prompt",
      mode: "save",
    })
    expect(pendingSaveDecision({ ...base, kind: "update", id: "c1" })).toEqual({
      kind: "prompt",
      mode: "update",
    })
    expect(pendingSaveDecision({ ...base, kind: "unchanged" })).toEqual({ kind: "dismiss" })
    expect(pendingSaveDecision({ ...base, kind: "suppressed" })).toEqual({ kind: "dismiss" })
    expect(pendingSaveDecision(null)).toEqual({ kind: "skip" })
  })
})

it("falls back to save when classification fails", async () => {
  ;(getPendingSave as jest.Mock).mockRejectedValue(new Error("x"))
  render(<BrowserSavePasswordPrompt />)
  await waitFor(() => expect(localBrowser.onEvent).toHaveBeenCalled())
  await emitAndSettle(submitted())
  expect(await screen.findByText(copy.saveTitle)).toBeInTheDocument()
})

it("dismisses queued saves and unsubscribes on unmount", async () => {
  const { unmount } = render(<BrowserSavePasswordPrompt />)
  await waitFor(() => expect(localBrowser.onEvent).toHaveBeenCalled())
  await emitAndSettle(submitted())
  await screen.findByRole("region")
  unmount()
  expect(unlisten).toHaveBeenCalled()
  expect(resolvePendingSave).toHaveBeenCalledWith("p1", "dismiss")
})
