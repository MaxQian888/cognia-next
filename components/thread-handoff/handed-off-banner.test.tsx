/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import type { ThreadHandoffTicket } from "@cognia/agent-config-types/thread-handoff"

// next-intl is globally mocked against en.json in jest.setup.ts.

const CHECKOUT_ID = "0190e0e0-1111-7222-8333-444455556666"

let ticket: ThreadHandoffTicket | undefined
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => ticket }))
jest.mock("@/lib/db/thread-handoff-tickets", () => ({ getThreadHandoffTicket: jest.fn() }))

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: jest.fn(() => true),
}))

const hosts: Array<{ id: string; label: string; featureManifest: unknown }> = []
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: (select: (state: { hosts: typeof hosts }) => unknown) => select({ hosts }),
}))

const bringChangesBack = jest.fn()
const resultPullRequestAvailable = jest.fn()
const openResultPullRequest = jest.fn()
jest.mock("@/lib/remote-host/code-supply/result-return", () => {
  const actual = jest.requireActual("@/lib/remote-host/code-supply/result-return")
  return {
    ...actual,
    bringChangesBack: (...args: unknown[]) => bringChangesBack(...args),
    resultPullRequestAvailable: (...args: unknown[]) => resultPullRequestAvailable(...args),
    openResultPullRequest: (...args: unknown[]) => openResultPullRequest(...args),
  }
})
jest.mock("@/lib/review/github-runtime", () => ({
  createGitHubPullRequestProvider: () => ({ id: "github" }),
}))
const openExternal = jest.fn(async () => {})
const revealInExplorer = jest.fn(async () => {})
jest.mock("@/lib/tauri/opener", () => ({
  openExternal: (...args: unknown[]) => openExternal(...(args as [])),
  revealInExplorer: (...args: unknown[]) => revealInExplorer(...(args as [])),
}))
const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

import { HandedOffBanner } from "./handed-off-banner"

const { isTauri } = jest.requireMock("@/lib/platform/detect") as { isTauri: jest.Mock }

const OPERATIONS = ["code_checkout_export", "code_result_read_chunk", "code_result_discard"]

function host(operations = OPERATIONS) {
  return {
    id: "host-1",
    label: "Studio Mac",
    featureManifest: {
      schemaVersion: 2,
      features: { "always-on.code-supply": { version: 1, operations } },
      operations: operations.map((name) => ({ name, healthy: true })),
    },
  }
}

function session(state: "frozen" | "committed" | null = "committed"): ChatSession {
  return {
    id: "s1",
    title: "Fix login",
    createdAt: 0,
    updatedAt: 0,
    ...(state
      ? { handoffLock: { ticketId: "ticket-1", state, targetHostRef: "host-1", at: 1 } }
      : {}),
  } as ChatSession
}

function sourceTicket(withCode = true): ThreadHandoffTicket {
  return {
    ticketId: "ticket-1",
    role: "source",
    state: "committed",
    target: { hostRef: "host-1", kind: "desktop", label: "Studio Mac" },
    project: withCode ? { codeCheckout: { checkoutId: CHECKOUT_ID } } : {},
  } as unknown as ThreadHandoffTicket
}

const brought = {
  result: {
    checkoutId: CHECKOUT_ID,
    kind: "branch",
    branch: "cognia/cognia-444455556666",
    commit: "c".repeat(40),
    baseCommit: "b".repeat(40),
    baseRef: "main",
    remoteUrl: "https://github.com/acme/app",
    subdir: "",
    files: 2,
    pushError: null,
    transfer: null,
  },
  applied: {
    path: "/data/returns/x",
    workingDir: "/data/returns/x",
    branch: "cognia/cognia-444455556666",
    commit: "c".repeat(40),
    reused: false,
  },
}

beforeEach(() => {
  ticket = sourceTicket()
  isTauri.mockReturnValue(true)
  hosts.splice(0, hosts.length, host())
  bringChangesBack.mockReset()
  resultPullRequestAvailable.mockReset().mockResolvedValue(false)
  openResultPullRequest.mockReset()
  openExternal.mockClear()
  revealInExplorer.mockClear()
  toastSuccess.mockClear()
  toastError.mockClear()
})

describe("HandedOffBanner", () => {
  it("renders nothing until the handoff is committed", () => {
    const { container, rerender } = render(<HandedOffBanner session={session(null)} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<HandedOffBanner session={session("frozen")} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("says where the conversation went and offers the work back", () => {
    render(<HandedOffBanner session={session()} />)
    const banner = screen.getByTestId("handed-off-banner")
    expect(banner).toHaveAttribute("role", "status")
    expect(banner).toHaveTextContent("This conversation continues on Studio Mac")
    expect(banner).toHaveTextContent("This copy is read-only.")
    expect(screen.getByTestId("handed-off-bring-back")).toHaveTextContent("Bring the changes back")
    expect(screen.getByTestId("handed-off-progress")).toHaveTextContent(
      "Puts what was done on Studio Mac into a new worktree here."
    )
  })

  it("offers nothing to bring back for a handoff without code, or off the desktop", () => {
    ticket = sourceTicket(false)
    const { rerender } = render(<HandedOffBanner session={session()} />)
    expect(screen.getByTestId("handed-off-banner")).toBeInTheDocument()
    expect(screen.queryByTestId("handed-off-bring-back")).not.toBeInTheDocument()
    ticket = sourceTicket()
    isTauri.mockReturnValue(false)
    rerender(<HandedOffBanner session={{ ...session() }} />)
    expect(screen.queryByTestId("handed-off-bring-back")).not.toBeInTheDocument()
  })

  it("asks for a host update when the host cannot export", () => {
    hosts.splice(0, hosts.length, host(["code_checkout_export"]))
    render(<HandedOffBanner session={session()} />)
    expect(screen.queryByTestId("handed-off-bring-back")).not.toBeInTheDocument()
    expect(screen.getByTestId("handed-off-unsupported")).toHaveTextContent(
      "Update Studio Mac to bring its changes back here."
    )
  })

  it("brings the work back, shows where it landed, and opens a pull request", async () => {
    bringChangesBack.mockImplementation(
      async (
        _s: unknown,
        _h: unknown,
        _host: unknown,
        options: { onProgress: (progress: unknown) => void }
      ) => {
        options.onProgress({ step: "download", receivedBytes: 1024, totalBytes: 2048 })
        return brought
      }
    )
    resultPullRequestAvailable.mockResolvedValue(true)
    openResultPullRequest.mockResolvedValue({
      number: 7,
      url: "https://github.com/acme/app/pull/7",
    })
    render(<HandedOffBanner session={session()} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId("handed-off-bring-back"))
    })
    const [, handed, usedHost] = bringChangesBack.mock.calls[0]
    expect(handed).toEqual({
      ticketId: "ticket-1",
      hostRef: "host-1",
      hostLabel: "Studio Mac",
      checkoutId: CHECKOUT_ID,
    })
    expect(usedHost).toMatchObject({ id: "host-1" })
    expect(toastSuccess).toHaveBeenCalledWith("The changes from Studio Mac are in a new worktree.")
    expect(screen.getByTestId("handed-off-result")).toHaveTextContent(
      "Branch cognia/cognia-444455556666, in /data/returns/x"
    )
    expect(screen.queryByTestId("handed-off-not-pushed")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("handed-off-reveal"))
    expect(revealInExplorer).toHaveBeenCalledWith("/data/returns/x")

    await act(async () => {
      fireEvent.click(await screen.findByTestId("handed-off-open-pull-request"))
    })
    expect(openResultPullRequest).toHaveBeenCalledWith(
      brought,
      {
        title: "Fix login",
        body: "Work from a conversation continued on Studio Mac with Cognia.",
      },
      { id: "github" },
      // The receipt for the person's write is filed under this conversation.
      { sessionId: "s1" }
    )
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/app/pull/7")
    expect(screen.getByTestId("handed-off-pull-request-link")).toHaveTextContent("Pull request #7")
  })

  it("says when the branch could not be pushed and the work came over directly", async () => {
    bringChangesBack.mockResolvedValue({
      ...brought,
      result: { ...brought.result, kind: "bundle", pushError: "denied" },
      applied: { ...brought.applied, reused: true },
    })
    render(<HandedOffBanner session={session()} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("handed-off-bring-back"))
    })
    expect(toastSuccess).toHaveBeenCalledWith(
      "Nothing new since last time; this is the same worktree."
    )
    expect(screen.getByTestId("handed-off-not-pushed")).toHaveTextContent(
      "Studio Mac could not push the branch"
    )
    expect(screen.queryByTestId("handed-off-open-pull-request")).not.toBeInTheDocument()
  })

  it("explains a failure in terms the person can act on", async () => {
    bringChangesBack.mockRejectedValue(new Error("code_result_unchanged: nothing"))
    render(<HandedOffBanner session={session()} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("handed-off-bring-back"))
    })
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Nothing has changed on Studio Mac since the conversation moved there."
      )
    )
    expect(screen.getByTestId("handed-off-bring-back")).not.toBeDisabled()
    expect(screen.queryByTestId("handed-off-result")).not.toBeInTheDocument()
  })
})
