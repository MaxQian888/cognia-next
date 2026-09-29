import { act, fireEvent, render, screen } from "@testing-library/react"

import en from "@/i18n/messages/en.json"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/browser/client", () => ({ browserClient: { embedEvaluate: jest.fn() } }))
jest.mock("@/lib/browser/local-client", () => ({ localBrowser: { rpc: jest.fn() } }))
jest.mock("@/lib/browser/passwords", () => ({
  ...jest.requireActual("@/lib/browser/passwords"),
  matchCredentials: jest.fn(),
  fillCredential: jest.fn(),
}))

import { toast } from "sonner"
import type { BrowserBackend } from "@/lib/browser/backend-availability"
import { browserClient } from "@/lib/browser/client"
import { localBrowser } from "@/lib/browser/local-client"
import { fillCredential, matchCredentials, type CredentialMeta } from "@/lib/browser/passwords"

import { autofillTarget, BrowserAutofillPrompt } from "./browser-autofill-prompt"

const copy = en.browserVault.autofill
const URL_A = "https://github.com/login"

function meta(id: string, username: string): CredentialMeta {
  return {
    id,
    origin: "https://github.com",
    realm: null,
    username,
    source: "manual",
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    note: null,
  }
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms)
  })
  // Let the detect → match promise chain settle.
  await act(async () => {
    await Promise.resolve()
  })
}

function renderPrompt(
  props: Partial<{ backend: BrowserBackend; sessionId: string; pageId: string; url: string }> = {}
) {
  return render(<BrowserAutofillPrompt backend="embedded" url={URL_A} {...props} />)
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  ;(browserClient.embedEvaluate as jest.Mock).mockResolvedValue({
    ok: true,
    value: { forms: [{ ref: "f1", passwordRef: "p1", origin: "https://github.com" }] },
  })
  ;(localBrowser.rpc as jest.Mock).mockResolvedValue({ forms: [{ ref: "f1", passwordRef: "p1" }] })
  ;(matchCredentials as jest.Mock).mockResolvedValue([meta("c1", "octocat")])
  ;(fillCredential as jest.Mock).mockResolvedValue({
    filled: true,
    username: "octocat",
    reason: null,
  })
})

afterEach(() => {
  jest.useRealTimers()
})

describe("autofillTarget", () => {
  it("fills only where Rust can reach the page", () => {
    expect(autofillTarget("embedded")).toBe("embedded")
    expect(autofillTarget("local-chromium")).toBe("local")
    expect(autofillTarget("user-chrome")).toBe("local")
    expect(autofillTarget("remote")).toBeNull()
    expect(autofillTarget("web-fallback")).toBeNull()
  })
})

it("offers a match on an embedded login form and fills through Rust", async () => {
  renderPrompt()
  expect(screen.queryByRole("region")).toBeNull()
  await advance(400)
  expect(browserClient.embedEvaluate).toHaveBeenCalledWith(
    expect.stringContaining("__cogniaDetectLogin")
  )
  expect(matchCredentials).toHaveBeenCalledWith(URL_A)
  expect(screen.getByRole("region", { name: copy.region })).toHaveTextContent("octocat")

  fireEvent.click(screen.getByRole("button", { name: copy.fill }))
  await advance(0)
  expect(fillCredential).toHaveBeenCalledWith({
    target: "embedded",
    credentialId: "c1",
    url: URL_A,
  })
  expect(toast.success).toHaveBeenCalledWith("Signed-in details filled for octocat.")
  expect(screen.queryByRole("region")).toBeNull()
})

it("detects through the local runtime and lets the user choose among several accounts", async () => {
  ;(matchCredentials as jest.Mock).mockResolvedValue([meta("c1", "octocat"), meta("c2", "hubot")])
  renderPrompt({ backend: "local-chromium", sessionId: "s1", pageId: "p1" })
  await advance(400)
  expect(localBrowser.rpc).toHaveBeenCalledWith("browser.forms.detect-login", {
    sessionId: "s1",
    pageId: "p1",
  })
  fireEvent.change(screen.getByRole("combobox", { name: copy.account }), {
    target: { value: "c2" },
  })
  fireEvent.click(screen.getByRole("button", { name: copy.fill }))
  await advance(0)
  expect(fillCredential).toHaveBeenCalledWith({
    target: "local",
    sessionId: "s1",
    pageId: "p1",
    credentialId: "c2",
    url: URL_A,
  })
})

it("retries detection while the page renders its form", async () => {
  ;(browserClient.embedEvaluate as jest.Mock)
    .mockResolvedValueOnce({ ok: true, value: { forms: [] } })
    .mockRejectedValueOnce(new Error("navigating"))
  renderPrompt()
  await advance(400)
  await advance(1100)
  expect(screen.queryByRole("region")).toBeNull()
  await advance(2500)
  expect(browserClient.embedEvaluate).toHaveBeenCalledTimes(3)
  expect(screen.getByRole("region", { name: copy.region })).toBeInTheDocument()
})

it("stays hidden when nothing matches", async () => {
  ;(matchCredentials as jest.Mock).mockResolvedValue([])
  renderPrompt()
  await advance(5000)
  expect(screen.queryByRole("region")).toBeNull()
})

it.each([
  ["no_login_form", copy.reason.no_login_form],
  ["ambiguous", copy.reason.ambiguous],
  [null, copy.failed],
])("explains a fill that did not happen (%s)", async (reason, message) => {
  ;(fillCredential as jest.Mock).mockResolvedValue({ filled: false, username: null, reason })
  renderPrompt()
  await advance(400)
  fireEvent.click(screen.getByRole("button", { name: copy.fill }))
  await advance(0)
  expect(toast.error).toHaveBeenCalledWith(message)
  expect(screen.getByRole("region")).toBeInTheDocument()
})

it("reports a rejected fill", async () => {
  ;(fillCredential as jest.Mock).mockRejectedValue(new Error("owner lease"))
  renderPrompt()
  await advance(400)
  fireEvent.click(screen.getByRole("button", { name: copy.fill }))
  await advance(0)
  expect(toast.error).toHaveBeenCalledWith(copy.failed)
})

it("can be dismissed, and a new URL drops the stale prompt", async () => {
  const { rerender } = renderPrompt()
  await advance(400)
  fireEvent.click(screen.getByRole("button", { name: copy.dismiss }))
  expect(screen.queryByRole("region")).toBeNull()

  rerender(<BrowserAutofillPrompt backend="embedded" url="https://github.com/session" />)
  await advance(400)
  expect(screen.getByRole("region")).toBeInTheDocument()
  rerender(<BrowserAutofillPrompt backend="embedded" url="https://example.com/" />)
  expect(screen.queryByRole("region")).toBeNull()
})

it.each([
  ["remote", undefined, URL_A],
  ["web-fallback", undefined, URL_A],
  ["local-chromium", undefined, URL_A],
  ["embedded", undefined, "about:blank"],
] as const)("does not detect on %s (session %s, url %s)", async (backend, sessionId, url) => {
  renderPrompt({ backend, sessionId, url })
  await advance(5000)
  expect(browserClient.embedEvaluate).not.toHaveBeenCalled()
  expect(localBrowser.rpc).not.toHaveBeenCalled()
  expect(screen.queryByRole("region")).toBeNull()
})
