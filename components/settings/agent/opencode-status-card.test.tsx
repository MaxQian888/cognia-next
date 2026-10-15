import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { OpencodeStatusCard } from "./opencode-status-card"
import enMessages from "@/i18n/messages/en/externalAgent.json"
import type { OpencodeStatus } from "@/hooks/agent/use-opencode-status"

jest.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
  useLocale: () => "en",
  useTranslations: (namespace: string) => {
    const [root, ...path] = namespace.split(".")
    const source = jest.requireActual(`@/i18n/messages/en/${root}.json`)
    const lookup = (key: string): unknown =>
      [...path, ...key.split(".")].reduce((value, part) => value?.[part], source)
    const translate = (key: string, values: Record<string, unknown> = {}) => {
      const message = lookup(key)
      if (typeof message !== "string")
        throw new Error(`Missing split-source message: ${namespace}.${key}`)
      return message
        .replace(
          /\{(\w+),\s*plural,\s*((?:(?:=\d+|\w+)\s*\{(?:[^{}]|\{\w+\})*\}\s*)+)\}/g,
          (_, name, body) => {
            const branches = Object.fromEntries(
              [...body.matchAll(/(=\d+|\w+)\s*\{((?:[^{}]|\{\w+\})*)\}/g)].map(
                (match: RegExpMatchArray) => [match[1], match[2]]
              )
            )
            return (
              branches[`=${values[name]}`] ??
              branches[new Intl.PluralRules("en").select(Number(values[name]))] ??
              branches.other
            ).replace(/#/g, String(values[name]))
          }
        )
        .replace(/\{(\w+)(?:,\s*number)?\}/g, (_, name) => String(values[name] ?? `{${name}}`))
    }
    translate.has = (key: string) => typeof lookup(key) === "string"
    translate.raw = lookup
    translate.rich = translate
    return translate
  },
}))

let hookValue: {
  status: OpencodeStatus
  loading: boolean
  available: boolean
  refresh: () => Promise<void>
}

jest.mock("@/hooks/agent/use-opencode-status", () => ({
  useOpencodeStatus: () => hookValue,
}))

const messages = { externalAgent: enMessages }

const EMPTY: OpencodeStatus = {
  providers: [],
  agents: [],
  commands: [],
  mcpServers: [],
  lspServers: [],
}

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OpencodeStatusCard agentId="a1" connected />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  hookValue = {
    status: EMPTY,
    loading: false,
    available: true,
    refresh: jest.fn(async () => {}),
  }
})

describe("OpencodeStatusCard", () => {
  it("renders a not-connected hint when unavailable", () => {
    hookValue.available = false
    renderCard()
    expect(
      screen.getByText("Connect the agent to view its OpenCode server status.")
    ).toBeInTheDocument()
    expect(screen.queryByTestId("opencode-status")).not.toBeInTheDocument()
  })

  it("renders empty-state copy for every section", () => {
    renderCard()
    expect(screen.getByText("No providers discovered.")).toBeInTheDocument()
    expect(screen.getByText("No agents exposed.")).toBeInTheDocument()
    expect(screen.getByText("No commands exposed.")).toBeInTheDocument()
    expect(screen.getByText("No MCP servers configured.")).toBeInTheDocument()
    expect(screen.queryByTestId("opencode-lsp")).not.toBeInTheDocument()
    expect(screen.queryByTestId("opencode-project")).not.toBeInTheDocument()
  })

  it("renders project, providers, agents, commands, MCP and LSP entries", () => {
    hookValue.status = {
      providers: [
        { id: "anthropic", name: "Anthropic", connected: true },
        { id: "openai", connected: false },
      ],
      agents: [{ id: "build", name: "Build" }],
      commands: [{ name: "review" }],
      mcpServers: [{ name: "fs", status: "connected" }],
      lspServers: [{ id: "ts", status: "running" }],
      project: { worktree: "/repo", vcs: "git" },
    }
    renderCard()
    expect(screen.getByTestId("opencode-project")).toHaveTextContent("/repo · git")
    const providers = screen.getAllByTestId("opencode-provider")
    expect(providers[0]).toHaveTextContent("Anthropic")
    expect(providers[1]).toHaveTextContent("openai")
    expect(screen.getByTestId("opencode-agent")).toHaveTextContent("Build")
    expect(screen.getByTestId("opencode-command")).toHaveTextContent("/review")
    expect(screen.getByTestId("opencode-mcp-server")).toHaveTextContent("fs · connected")
    expect(screen.getByTestId("opencode-lsp")).toHaveTextContent("ts · running")
  })

  it("disables the refresh control while loading and invokes refresh on click", async () => {
    const refresh = jest.fn(async () => {})
    hookValue.refresh = refresh
    const user = userEvent.setup()
    renderCard()
    await user.click(screen.getByTestId("opencode-status-refresh"))
    expect(refresh).toHaveBeenCalled()

    hookValue.loading = true
    renderCard()
    const buttons = screen.getAllByTestId("opencode-status-refresh")
    expect(buttons[buttons.length - 1]).toBeDisabled()
  })
})

it("shows failed MCP and LSP reads with retry instead of an empty diagnosis", async () => {
  hookValue.status = { ...EMPTY, surfaces: { mcp: "error", lsp: "error" } }
  renderCard()
  expect(screen.getAllByText(enMessages.settings.opencode.loadFailed)).toHaveLength(2)
  expect(screen.queryByText(enMessages.settings.opencode.noMcpServers)).not.toBeInTheDocument()
  await userEvent.click(
    screen.getAllByRole("button", { name: enMessages.settings.opencode.retry })[0]
  )
  expect(hookValue.refresh).toHaveBeenCalledTimes(1)
})

it("names V2 surfaces that the version cannot report", () => {
  hookValue.status = { ...EMPTY, providers: [{ id: "unknown" }], surfaces: { lsp: "unsupported" } }
  renderCard()
  expect(screen.getByText(enMessages.settings.opencode.unavailableForVersion)).toBeInTheDocument()
  expect(screen.getByTestId("opencode-provider")).toHaveAttribute(
    "title",
    enMessages.settings.opencode.providerAuthUnknown
  )
})

it("renders a flat titled section and keeps loading distinct from empty", () => {
  hookValue.status = { ...EMPTY, surfaces: { mcp: "loading" } }
  renderCard()
  expect(screen.getByTestId("opencode-status").tagName).toBe("SECTION")
  expect(screen.getByTestId("opencode-status")).not.toHaveClass("border")
  expect(screen.getByTestId("opencode-mcp-loading")).toHaveTextContent(
    enMessages.settings.opencode.checking
  )
  expect(screen.queryByText(enMessages.settings.opencode.noMcpServers)).not.toBeInTheDocument()
})

it("offers one retry when adapter discovery fails before availability is known", async () => {
  hookValue.available = false
  hookValue.status = { ...EMPTY, surfaces: { providers: "error", mcp: "error", lsp: "error" } }
  renderCard()
  expect(screen.getAllByRole("alert")).toHaveLength(1)
  expect(screen.getByRole("alert")).toHaveTextContent(enMessages.settings.opencode.loadFailed)
  expect(screen.queryByText(enMessages.settings.opencode.notConnected)).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: enMessages.settings.opencode.retry }))
  expect(hookValue.refresh).toHaveBeenCalledTimes(1)
})
