/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"
import type { BotCredentialCandidate } from "@/lib/bot/console/credential-candidates"

const bindCredential = jest.fn(
  async (_installationId: string, _slotId: string, _candidate: BotCredentialCandidate | null) =>
    undefined
)
let failed = false
let readiness = { availability: { state: "available", reason: "local-host" }, can: true }
let candidates: BotCredentialCandidate[] = []

jest.mock("@/hooks/bots/use-bot-lifecycle-actions", () => ({
  useBotLifecycleReadiness: () => readiness,
  useBotLifecycleActions: () => ({
    pending: new Set<string>(),
    bindCredential: (
      installationId: string,
      slotId: string,
      candidate: BotCredentialCandidate | null
    ) => bindCredential(installationId, slotId, candidate),
  }),
}))
jest.mock("@/hooks/bots/use-credential-candidates", () => ({
  useCredentialCandidates: () => ({ forSlot: () => candidates, loading: false, failed }),
}))

import { BotCredentialsSection } from "./credentials-section"

function candidate(over: Partial<BotCredentialCandidate> = {}): BotCredentialCandidate {
  return {
    value: "iacc_1",
    kind: "integration-account",
    label: "Octocat",
    detail: "github",
    disabled: false,
    ...over,
  }
}

beforeEach(() => {
  failed = false
  bindCredential.mockClear()
  readiness = { availability: { state: "available", reason: "local-host" }, can: true }
  candidates = [candidate()]
})

function row(over: Partial<BotConsoleRow> = {}): BotConsoleRow {
  return {
    id: "boti_1",
    definitionId: "acme:review",
    source: "plugin",
    name: "Review",
    executor: "handler",
    status: "needs_setup",
    scope: { kind: "account" },
    orphaned: false,
    problems: [],
    triggers: [],
    armedTriggers: 0,
    unboundSlots: ["token"],
    requiredSlots: [],
    credentials: [
      { id: "token", label: "GitHub token", optional: false, bound: false, integration: "github" },
      {
        id: "chat",
        label: "Chat account",
        optional: false,
        bound: true,
        adapterId: "adp_7",
      },
      { id: "extra", label: "Analytics", optional: true, bound: false },
    ],
    config: {},
    deadLetters: 0,
    updatedAt: 10,
    ...over,
  }
}

describe("BotCredentialsSection", () => {
  it("flags the required slot that is unbound, which is why the status says needs_setup", () => {
    render(<BotCredentialsSection row={row()} />)
    const token = screen.getByTestId("bot-credential-token")
    expect(token).toHaveAttribute("data-bound", "false")
    expect(token).toHaveTextContent("Needs binding")
  })

  it("does not flag an unbound OPTIONAL slot", () => {
    // The Bot runs fine without it, and marking it would put a permanent
    // amber dot on a working installation.
    render(<BotCredentialsSection row={row()} />)
    const extra = screen.getByTestId("bot-credential-extra")
    expect(extra).toHaveTextContent("Optional")
    expect(extra).not.toHaveTextContent("Needs binding")
  })

  it("shows the id a binding points at, never a secret", () => {
    render(<BotCredentialsSection row={row()} />)
    expect(screen.getByTestId("bot-credential-chat")).toHaveTextContent("Bound to adp_7")
  })

  it("names the integration a slot must belong to", () => {
    render(<BotCredentialsSection row={row()} />)
    expect(screen.getByTestId("bot-credential-token")).toHaveTextContent("github")
  })

  it("distinguishes a Bot that needs no credentials from one with no definition", () => {
    const { unmount } = render(<BotCredentialsSection row={row({ credentials: [] })} />)
    expect(screen.getByText("No credentials needed")).toBeInTheDocument()
    unmount()

    render(<BotCredentialsSection row={row({ credentials: [], orphaned: true })} />)
    expect(screen.getByText("Definition missing")).toBeInTheDocument()
  })
})

describe("binding a credential", () => {
  it("writes exactly one id, and only for the slot that was changed", async () => {
    const user = userEvent.setup()
    render(<BotCredentialsSection row={row()} />)
    await user.click(screen.getByTestId("bot-credential-select-token"))
    await user.click(await screen.findByRole("option", { name: /Octocat/ }))
    expect(bindCredential).toHaveBeenCalledWith("boti_1", "token", candidate())
  })

  it("clears a binding rather than leaving an empty object behind", async () => {
    const user = userEvent.setup()
    render(<BotCredentialsSection row={row()} />)
    await user.click(screen.getByTestId("bot-credential-select-chat"))
    await user.click(await screen.findByRole("option", { name: "Not bound" }))
    expect(bindCredential).toHaveBeenCalledWith("boti_1", "chat", null)
  })

  it("renders the picker DISABLED with a reason rather than hiding it", async () => {
    // Hiding it would collapse "this Bot needs no credentials", "you cannot
    // bind from here" and "it is bound already" into one blank space.
    readiness = {
      availability: { state: "unsupported", reason: "requires-companion" },
      can: false,
    }
    render(<BotCredentialsSection row={row()} />)
    expect(screen.getByTestId("bot-credential-select-token")).toBeDisabled()
    expect(screen.getByTestId("bot-credentials-blocked")).toHaveTextContent(
      "This browser cannot run Bots"
    )
  })

  it("refuses on an orphan and says why, because the write would refuse too", () => {
    render(<BotCredentialsSection row={row({ orphaned: true })} />)
    expect(screen.getByTestId("bot-credential-select-token")).toBeDisabled()
    expect(screen.getByTestId("bot-credentials-blocked")).toHaveTextContent(
      "nothing left to check them against"
    )
  })

  it("tells an empty candidate list apart from a disallowed write", () => {
    // Nothing to pick and not being allowed to pick need different remedies.
    candidates = []
    render(<BotCredentialsSection row={row()} />)
    expect(screen.queryByTestId("bot-credential-select-token")).not.toBeInTheDocument()
    expect(screen.getByTestId("bot-credential-empty-token")).toHaveTextContent(
      "No account for this integration yet"
    )
  })

  it("marks a switched-off candidate without removing it from the list", async () => {
    // Binding to a disabled account is a legitimate way to prepare a Bot.
    const user = userEvent.setup()
    candidates = [candidate({ disabled: true })]
    render(<BotCredentialsSection row={row()} />)
    await user.click(screen.getByTestId("bot-credential-select-token"))
    expect(await screen.findByRole("option", { name: /switched off/ })).toBeInTheDocument()
  })
})

it("shows a host read failure instead of empty credential choices", () => {
  failed = true
  render(<BotCredentialsSection row={row()} />)
  expect(screen.getByRole("alert")).toBeInTheDocument()
})
