import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { RuntimeBadge, safeRuntimeLabel } from "./runtime-badge"
import { RUNTIME_OPTIONS } from "./runtime-options"
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
    expect(badge.querySelector("img")).toHaveAttribute("src", "/icons/lobe/claude-color.svg")
  })

  it("renders the Codex label", () => {
    renderBadge("codex")
    expect(screen.getByText("Codex")).toBeInTheDocument()
  })

  it("renders the Claude Code label", () => {
    renderBadge("claude-code")
    expect(screen.getByText("Claude Code")).toBeInTheDocument()
    expect(screen.getByTestId("runtime-badge-claude-code").querySelector("img")).toHaveAttribute(
      "src",
      "/icons/lobe/claudecode-color.svg"
    )
  })

  it("renders the Gemini label", () => {
    renderBadge("gemini-cli")
    expect(screen.getByText("Gemini")).toBeInTheDocument()
    expect(screen.getByTestId("runtime-badge-gemini-cli").querySelector("img")).toHaveAttribute(
      "src",
      "/icons/lobe/geminicli-color.svg"
    )
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

  // This used to iterate a hand-written 8-element literal while claiming to be
  // exhaustive, so it never covered `pi-rpc` when ADR-0119 added it and would
  // not have covered the DeepSeek Harness ids either. Drive it from
  // RUNTIME_OPTIONS — the same list the pickers offer — so a new runtime is
  // covered the moment it becomes selectable.
  it.each(RUNTIME_OPTIONS)("renders a badge for %s (colors are exhaustive)", (runtime) => {
    const { unmount } = renderBadge(runtime)
    // Missing i18n keys fall back to the runtime literal, but the badge and its
    // per-runtime color must resolve — a missing RUNTIME_CLASSES entry would
    // render an unstyled pill here.
    const badge = screen.getByTestId(`runtime-badge-${runtime}`)
    expect(badge).toBeInTheDocument()
    expect(badge.className).toMatch(/bg-/)
    unmount()
  })
})

// Tested directly rather than through the component: `jest.setup.ts` mocks
// next-intl to resolve against the real `en.json`, where every
// `RUNTIME_LABEL_KEYS` entry exists, so rendering can never take these paths.
describe("safeRuntimeLabel", () => {
  const t = (fn: (key: string) => string) => fn as never

  it("returns the translation when one resolves", () => {
    expect(
      safeRuntimeLabel(
        t(() => "Qwen Code"),
        "qwenCode",
        "qwen-code"
      )
    ).toBe("Qwen Code")
  })

  it("falls back when the lookup echoes the key back", () => {
    expect(
      safeRuntimeLabel(
        t((key) => key),
        "qwenCode",
        "qwen-code"
      )
    ).toBe("qwen-code")
  })

  it("falls back when the lookup returns an empty string", () => {
    expect(
      safeRuntimeLabel(
        t(() => ""),
        "qwenCode",
        "qwen-code"
      )
    ).toBe("qwen-code")
  })

  it("falls back when the lookup throws on a missing key", () => {
    expect(
      safeRuntimeLabel(
        t(() => {
          throw new Error("MISSING_MESSAGE")
        }),
        "qwenCode",
        "qwen-code"
      )
    ).toBe("qwen-code")
  })
})
