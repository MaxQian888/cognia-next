import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

// The split sources, not the generated aggregates: `i18n/messages/*.json` are
// build output shared by every workstream, and these are the files a key is
// actually authored in.
import externalAgentEn from "@/i18n/messages/en/externalAgent.json"
import externalAgentZh from "@/i18n/messages/zh-CN/externalAgent.json"
import { ExternalAgentLifecycleError } from "@/types/agent/external-agent-lifecycle"
import type {
  ExternalAgentRuntimeStatus,
  ExternalAgentVersionVerdict,
} from "@/types/agent/external-agent-lifecycle"
import { EXTERNAL_AGENT_VERSION_VERDICTS } from "@/types/agent/external-agent-lifecycle"

import { RuntimeGovernancePanel } from "./runtime-governance-panel"

// The store is the only thing that decides which runtimes are listed.
const agents: Record<string, unknown> = {}
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector: (state: { agents: typeof agents }) => unknown) =>
    selector({ agents }),
}))

function setAgents(next: Record<string, unknown>) {
  for (const key of Object.keys(agents)) delete agents[key]
  Object.assign(agents, next)
}

function agent(id: string, runtimeId?: string) {
  return {
    id,
    name: id,
    runtimeBinding: runtimeId ? { runtimeId, ownership: "system" } : undefined,
  }
}

function status(overrides: Partial<ExternalAgentRuntimeStatus> = {}): ExternalAgentRuntimeStatus {
  return {
    runtimeId: "codex-app-server",
    ownership: "system",
    assessment: {
      runtimeId: "codex-app-server",
      verdict: "supported-uncertified",
      detectedVersion: "1.2.3",
      executablePath: "/usr/local/bin/codex",
      checkedAt: "2026-02-02T00:00:00.000Z",
    },
    referencedBy: ["agent-1"],
    activeSessionCount: 0,
    ...overrides,
  }
}

function renderPanel(props: Partial<Parameters<typeof RuntimeGovernancePanel>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ externalAgent: externalAgentEn }}>
      <RuntimeGovernancePanel hostSupported inspectRuntime={async () => status()} {...props} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  setAgents({})
})

// ---------------------------------------------------------------------------

describe("RuntimeGovernancePanel", () => {
  it("lists only the runtimes the saved agents actually bind to", async () => {
    setAgents({
      "agent-1": agent("agent-1", "codex-app-server"),
      "agent-2": agent("agent-2", "codex-app-server"),
      "agent-3": agent("agent-3"),
    })
    const inspectRuntime = jest.fn(async (runtimeId: string) => status({ runtimeId }))

    renderPanel({ inspectRuntime })

    await waitFor(() => expect(inspectRuntime).toHaveBeenCalledTimes(1))
    // Two agents share one runtime, and the unbound one probes nothing: a probe
    // spawns a process, so listing every catalogued runtime would spend a
    // minute of the user's machine on runtimes they do not use.
    expect(inspectRuntime).toHaveBeenCalledWith("codex-app-server")
    expect(await screen.findByTestId("runtime-row-codex-app-server")).toBeInTheDocument()
  })

  it("shows the empty state when nothing is bound", async () => {
    setAgents({ "agent-1": agent("agent-1") })
    const inspectRuntime = jest.fn()

    renderPanel({ inspectRuntime })

    expect(await screen.findByText("No runtimes to check yet")).toBeInTheDocument()
    expect(inspectRuntime).not.toHaveBeenCalled()
  })

  it("says the device cannot inspect, instead of reporting nothing installed", async () => {
    setAgents({ "agent-1": agent("agent-1", "codex-app-server") })
    const inspectRuntime = jest.fn()

    renderPanel({ hostSupported: false, inspectRuntime })

    expect(await screen.findByTestId("runtime-governance-unsupported")).toBeInTheDocument()
    // A browser shell has no standing to say a runtime is missing.
    expect(inspectRuntime).not.toHaveBeenCalled()
  })

  it("renders the detected version, range, executable and usage counts", async () => {
    setAgents({ "agent-1": agent("agent-1", "codex-app-server") })

    renderPanel({
      inspectRuntime: async () =>
        status({
          assessment: {
            runtimeId: "codex-app-server",
            verdict: "certified",
            detectedVersion: "2.0.0",
            supportedRange: "^2.0.0",
            executablePath: "/opt/codex",
            checkedAt: "2026-02-02T00:00:00.000Z",
          },
          referencedBy: ["agent-1", "agent-2"],
          activeSessionCount: 3,
        }),
    })

    expect(await screen.findByText("2.0.0")).toBeInTheDocument()
    expect(screen.getByText("^2.0.0")).toBeInTheDocument()
    expect(screen.getByText("/opt/codex")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("says a version was not detected rather than leaving the field blank", async () => {
    setAgents({ "agent-1": agent("agent-1", "codex-app-server") })

    renderPanel({
      inspectRuntime: async () =>
        status({
          assessment: {
            runtimeId: "codex-app-server",
            verdict: "missing",
            checkedAt: "2026-02-02T00:00:00.000Z",
          },
        }),
    })

    expect(await screen.findByText("Not detected")).toBeInTheDocument()
    expect(screen.getByText("Not yet certified by Cognia")).toBeInTheDocument()
  })

  it("warns that an unpinned runtime is re-fetched on every start", async () => {
    setAgents({ "agent-1": agent("agent-1", "codex-acp") })

    renderPanel({ inspectRuntime: async () => status({ runtimeId: "codex-acp" }) })

    // `codex-acp` launches through `npx -y`, so the version shown describes the
    // last run and can change without asking.
    expect(await screen.findByTestId("runtime-unpinned-codex-acp")).toBeInTheDocument()
  })

  it("does not warn about a runtime that launches its own executable", async () => {
    setAgents({ "agent-1": agent("agent-1", "codex-app-server") })

    renderPanel()

    await screen.findByTestId("runtime-row-codex-app-server")
    expect(screen.queryByTestId("runtime-unpinned-codex-app-server")).not.toBeInTheDocument()
  })

  it("keeps the other verdicts when one runtime fails to inspect", async () => {
    setAgents({
      "agent-1": agent("agent-1", "codex-app-server"),
      "agent-2": agent("agent-2", "droid"),
    })

    renderPanel({
      inspectRuntime: async (runtimeId: string) => {
        if (runtimeId === "droid") {
          throw new ExternalAgentLifecycleError("platform_unsupported", "no host")
        }
        return status({ runtimeId })
      },
    })

    expect(await screen.findByTestId("runtime-row-droid")).toHaveTextContent(
      "This agent cannot run on this device."
    )
    expect(screen.getByTestId("runtime-row-codex-app-server")).toBeInTheDocument()
  })

  it("re-checks on demand", async () => {
    setAgents({ "agent-1": agent("agent-1", "codex-app-server") })
    const inspectRuntime = jest.fn(async (runtimeId: string) => status({ runtimeId }))

    renderPanel({ inspectRuntime })
    await waitFor(() => expect(inspectRuntime).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByTestId("runtime-governance-refresh"))
    await waitFor(() => expect(inspectRuntime).toHaveBeenCalledTimes(2))
  })

  it("disables the re-check button when there is nothing to check", async () => {
    setAgents({ "agent-1": agent("agent-1") })
    renderPanel({ inspectRuntime: jest.fn() })

    expect(await screen.findByTestId("runtime-governance-refresh")).toBeDisabled()
  })
})

// --- key coverage ----------------------------------------------------------

describe("verdict message coverage", () => {
  // The verdict labels are looked up with a template key, which `lint:i18n`
  // cannot see. A verdict added to the union without its two strings would
  // render the raw key path to the user.
  it.each(["en", "zh-CN"])("%s has a label and an explanation for every verdict", (locale) => {
    const messages = (locale === "en" ? externalAgentEn : externalAgentZh) as unknown as {
      runtimes: {
        verdict: Record<string, string>
        verdictHelp: Record<string, string>
        ownership: Record<string, string>
      }
    }
    const { verdict, verdictHelp, ownership } = messages.runtimes

    const camel = (value: ExternalAgentVersionVerdict) =>
      value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())

    const missing: string[] = []
    for (const value of EXTERNAL_AGENT_VERSION_VERDICTS) {
      if (!verdict[camel(value)]) missing.push(`verdict.${camel(value)}`)
      if (!verdictHelp[camel(value)]) missing.push(`verdictHelp.${camel(value)}`)
    }
    for (const value of ["managed", "system", "remote"]) {
      if (!ownership[value]) missing.push(`ownership.${value}`)
    }
    expect(missing).toEqual([])
  })
})
