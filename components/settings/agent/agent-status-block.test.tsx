import { render, screen, fireEvent } from "@testing-library/react"
import en from "@/i18n/messages/en/externalAgent.json"
import zh from "@/i18n/messages/zh-CN/externalAgent.json"
import { AgentStatusBlock } from "./agent-status-block"
import type { AgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"
import type { ExternalAgentFailure } from "@/lib/ai/agent/external/agent-failure"

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
jest.mock("@/components/agent/external-agent/unsandboxed-consent-action", () => ({
  UnsandboxedConsentAction: () => <button data-testid="consent-action">Consent</button>,
}))
const clearFailure = jest.fn()
let failures: Record<string, ExternalAgentFailure> = {}
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector: (state: unknown) => unknown) =>
    selector({ agentFailures: failures, clearAgentFailure: clearFailure }),
}))
const agent = { id: "a", name: "Agent", enabled: true } as LifecycleExternalAgentConfig
const readiness: AgentReadiness = {
  state: "off",
  ready: false,
  blockReason: null,
  blockTransient: false,
  steps: [],
  nextAction: "connect",
}
function setup(over: Partial<Parameters<typeof AgentStatusBlock>[0]> = {}) {
  const props = {
    agent,
    readiness,
    masterEnabled: true,
    isConnecting: false,
    onConnect: jest.fn(),
    onEnable: jest.fn(),
    onEdit: jest.fn(),
    onOpenRuntimes: jest.fn(),
    onOpenPlugins: jest.fn(),
    onUseSharedState: jest.fn(),
    onEditSessionLimit: jest.fn(),
    onAddRule: jest.fn(),
    ...over,
  }
  return { ...props, ...render(<AgentStatusBlock {...props} />) }
}
beforeEach(() => {
  failures = {}
  clearFailure.mockClear()
})

it.each([
  ["runtime_missing", "open-runtimes", "onOpenRuntimes"],
  ["credential_missing", "edit-credentials", "onEdit"],
  ["state_isolation_unsupported", "use-shared-state", "onUseSharedState"],
  ["session_limit_reached", "edit-session-limit", "onEditSessionLimit"],
] as const)(
  "offers one targeted remedy for %s, including auto-disabled agents",
  (code, key, handler) => {
    const view = setup({
      agent: { ...agent, enabled: false, lifecycleStatus: "blocked", lifecycleReasonCode: code },
      readiness: { ...readiness, state: "disabled", blockReason: "Repeated explanation" },
    })
    fireEvent.click(screen.getByRole("button", { name: en.settings.remedies[key] }))
    expect(view[handler]).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("Repeated explanation")).not.toBeInTheDocument()
    expect(zh.settings.remedies[key]).toBeTruthy()
  }
)

it("links to plugins and keeps the existing consent action", () => {
  const view = setup({
    agent: { ...agent, lifecycleStatus: "blocked", lifecycleReasonCode: "adapter_unavailable" },
  })
  expect(screen.getByRole("link", { name: en.settings.remedies["open-plugins"] })).toHaveAttribute(
    "href",
    "/plugins"
  )
  view.rerender(
    <AgentStatusBlock
      {...view}
      agent={{
        ...agent,
        lifecycleStatus: "needs-consent",
        lifecycleReasonCode: "consent_required",
      }}
    />
  )
  expect(screen.getByTestId("consent-action")).toBeInTheDocument()
})

it("uses the fallback explanation only without a lifecycle verdict", () => {
  setup({ readiness: { ...readiness, state: "blocked", blockReason: "Host unavailable" } })
  expect(screen.getByText("Host unavailable")).toBeInTheDocument()
  expect(screen.queryByTestId("lifecycle-status-notice")).not.toBeInTheDocument()
})

it.each(["off", "error"] as const)("leaves the %s connection remedy to the header", (state) => {
  setup({ readiness: { ...readiness, state } })
  expect(screen.queryByRole("button")).not.toBeInTheDocument()
})

it("explains unsupported platforms without an action", () => {
  setup({
    agent: { ...agent, lifecycleStatus: "blocked", lifecycleReasonCode: "platform_unsupported" },
  })
  expect(screen.getByTestId("lifecycle-status-notice")).toBeInTheDocument()
  expect(screen.queryByRole("button")).not.toBeInTheDocument()
})

it("shows only this agent's failure with retry and dismiss", () => {
  failures = {
    a: {
      agentId: "a",
      phase: "connect",
      message: "Connection failed",
      causes: ["Runtime missing"],
      at: 1,
    },
    b: { agentId: "b", phase: "connect", message: "Other failure", causes: [], at: 1 },
  }
  const view = setup()
  expect(screen.getByText("Runtime missing")).toBeInTheDocument()
  expect(screen.queryByText("Other failure")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: en.failure.retry }))
  expect(view.onConnect).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
  expect(clearFailure).toHaveBeenCalledWith("a")
  view.rerender(<AgentStatusBlock {...view} masterEnabled={false} />)
  expect(screen.queryByRole("button", { name: en.failure.retry })).not.toBeInTheDocument()
})
