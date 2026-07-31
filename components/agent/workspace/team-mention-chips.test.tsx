import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TeamMentionChips } from "./team-mention-chips"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"

const messages = {
  agentTeamsWorkspace: {
    chat: {
      mentionAgents: "Mention an agent",
      runtime: {
        claude: "Claude",
        codex: "Codex",
        claudeCode: "Claude Code",
        geminiCli: "Gemini",
        cursorCli: "Cursor",
      },
      runtimeStatus: {
        missingKey: "Set an API key in settings",
        noAgent: "No agent configured for {runtime}",
        disconnected: "{runtime} not connected",
      },
    },
  },
}

const targets: MentionTarget[] = [
  {
    kind: "virtual",
    id: "__virtual_claude__",
    name: "claude",
    runtime: "claude",
    description: "Anthropic Claude API",
  },
  {
    kind: "virtual",
    id: "__virtual_codex__",
    name: "codex",
    runtime: "codex",
    description: "OpenAI Codex CLI",
  },
  {
    kind: "teammate",
    id: "tm-1",
    name: "Alice",
    runtime: "claude-code",
    description: "Frontend",
    nameCollision: false,
    teammate: { name: "Alice" } as never,
  },
]

function renderChips(onPick: jest.Mock) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <TeamMentionChips targets={targets} onPick={onPick} />
    </NextIntlClientProvider>
  )
}

describe("TeamMentionChips", () => {
  it("renders one chip per target with the @name label", () => {
    renderChips(jest.fn())
    expect(screen.getByText("@claude")).toBeInTheDocument()
    expect(screen.getByText("@codex")).toBeInTheDocument()
    expect(screen.getByText("@Alice")).toBeInTheDocument()
  })

  it("calls onPick with the matching target when a chip is clicked", () => {
    const onPick = jest.fn()
    renderChips(onPick)
    fireEvent.click(screen.getByTestId("mention-chip-__virtual_codex__"))
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0].id).toBe("__virtual_codex__")
  })

  it("renders nothing when targets is empty", () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <TeamMentionChips targets={[]} onPick={jest.fn()} />
      </NextIntlClientProvider>
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders the heading from i18n", () => {
    renderChips(jest.fn())
    expect(screen.getByText("Mention an agent")).toBeInTheDocument()
  })

  it("dims chips for unavailable runtimes and exposes the status data attribute", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <TeamMentionChips
          targets={targets}
          onPick={jest.fn()}
          availability={{
            claude: "missing-key",
            codex: "no-agent",
            "claude-code": "ready",
            "gemini-cli": "ready",
            "cursor-cli": "ready",
          }}
        />
      </NextIntlClientProvider>
    )
    const claudeChip = screen.getByTestId("mention-chip-__virtual_claude__")
    expect(claudeChip).toHaveAttribute("data-runtime-status", "missing-key")
    // Tooltip resolves from the real i18n key (no hard-coded English fallback);
    // jest.setup mocks next-intl onto the compiled en.json bundle, so a missing
    // key would surface as the bare key string here.
    expect(claudeChip.getAttribute("title")).toBe(
      "Set an Anthropic API key in Settings → Providers to enable @claude."
    )

    const codexChip = screen.getByTestId("mention-chip-__virtual_codex__")
    expect(codexChip).toHaveAttribute("data-runtime-status", "no-agent")
    // {runtime} interpolation resolves through next-intl.
    expect(codexChip.getAttribute("title")).toContain("codex")

    // Alice runs on claude-code which is ready in this map.
    expect(screen.getByTestId("mention-chip-tm-1")).toHaveAttribute("data-runtime-status", "ready")
  })

  it("resolves the disconnected tooltip from i18n (with {runtime} interpolation)", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <TeamMentionChips
          targets={targets}
          onPick={jest.fn()}
          availability={{ "claude-code": "disconnected" }}
        />
      </NextIntlClientProvider>
    )
    const aliceChip = screen.getByTestId("mention-chip-tm-1")
    expect(aliceChip).toHaveAttribute("data-runtime-status", "disconnected")
    // Localized key resolves (no hard-coded fallback) and interpolates the runtime.
    expect(aliceChip.getAttribute("title")).toContain("claude-code")
    expect(aliceChip.getAttribute("title")).toMatch(/not connected/i)
  })

  it("defaults to ready when no availability map is provided", () => {
    renderChips(jest.fn())
    targets.forEach((t) => {
      expect(screen.getByTestId(`mention-chip-${t.id}`)).toHaveAttribute(
        "data-runtime-status",
        "ready"
      )
    })
  })
})
