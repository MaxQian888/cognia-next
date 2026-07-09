import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { RuntimeBadge } from "./runtime-badge"
import type { TeammateRuntime } from "@/types/agent/agent-team"

const messages = {
  agentTeamsWorkspace: {
    chat: {
      runtime: {
        claude: "Claude",
        codex: "Codex",
        claudeCode: "Claude Code",
        geminiCli: "Gemini",
        cursorCli: "Cursor",
      },
    },
  },
}

function renderBadge(runtime: TeammateRuntime, iconOnly = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <RuntimeBadge runtime={runtime} iconOnly={iconOnly} />
    </NextIntlClientProvider>
  )
}

describe("RuntimeBadge", () => {
  it("renders the Claude label with default icon-and-text layout", () => {
    renderBadge("claude")
    expect(screen.getByText("Claude")).toBeInTheDocument()
    const badge = screen.getByTestId("runtime-badge-claude")
    expect(badge).toHaveAttribute("data-runtime", "claude")
  })

  it("renders the Codex label", () => {
    renderBadge("codex")
    expect(screen.getByText("Codex")).toBeInTheDocument()
  })

  it("renders the Claude Code label", () => {
    renderBadge("claude-code")
    expect(screen.getByText("Claude Code")).toBeInTheDocument()
  })

  it("renders the Gemini label", () => {
    renderBadge("gemini-cli")
    expect(screen.getByText("Gemini")).toBeInTheDocument()
  })

  it("renders the Cursor label", () => {
    renderBadge("cursor-cli")
    expect(screen.getByText("Cursor")).toBeInTheDocument()
  })

  it("hides text when iconOnly is true but keeps the title attribute", () => {
    renderBadge("codex", true)
    const badge = screen.getByTestId("runtime-badge-codex")
    expect(badge).toHaveAttribute("title", "Codex")
    expect(badge.querySelector("span")).toBeNull()
  })

  it("renders a badge for every executable runtime (RUNTIME_META is exhaustive)", () => {
    const runtimes: TeammateRuntime[] = [
      "codex-app-server",
      "copilot-cli",
      "kiro",
      "qwen-code",
      "pi",
      "droid",
      "opencode-server",
      "opencode-remote",
    ]
    for (const runtime of runtimes) {
      const { unmount } = renderBadge(runtime)
      // Missing i18n keys fall back to the runtime literal, but the badge (and
      // its per-runtime icon/color meta) must resolve — a missing RUNTIME_META
      // entry would throw here.
      expect(screen.getByTestId(`runtime-badge-${runtime}`)).toBeInTheDocument()
      unmount()
    }
  })
})
