/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

let activeSessionId: string | null = "s1"
jest.mock("@/stores/chat", () => ({
  useChatStore: (sel: (s: { activeSessionId: string | null }) => unknown) =>
    sel({ activeSessionId }),
}))

const useSdkSessionCapabilities = jest.fn()
jest.mock("@/hooks/chat/use-sdk-session-capabilities", () => ({
  useSdkSessionCapabilities: (...a: unknown[]) => useSdkSessionCapabilities(...a),
}))

import { render, screen } from "@testing-library/react"
import type { SdkModelInfo, SdkSlashCommand } from "@cognia/agent-config-types"
import { SdkCapabilitiesCard } from "./sdk-capabilities-card"

const models: SdkModelInfo[] = [
  {
    value: "claude-opus-4-8",
    displayName: "Opus 4.8",
    description: "Frontier",
    supportsEffort: true,
  },
  { value: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "Fast" },
]
const commands: SdkSlashCommand[] = [
  { name: "compact", description: "Compress context" },
  { name: "clear", description: "Reset" },
]

beforeEach(() => {
  jest.clearAllMocks()
  activeSessionId = "s1"
})

describe("SdkCapabilitiesCard", () => {
  it("renders the model + command lists when the session reports them", () => {
    useSdkSessionCapabilities.mockReturnValue({ models, commands, refresh: jest.fn() })
    render(<SdkCapabilitiesCard />)
    expect(screen.getByTestId("sdk-capabilities-card")).toBeInTheDocument()
    expect(screen.getByText("Opus 4.8")).toBeInTheDocument()
    expect(screen.getByText("/compact")).toBeInTheDocument()
    // The effort flag is shown only for models that support it.
    expect(screen.getByText("effortFlag")).toBeInTheDocument()
    expect(screen.getByText('modelsLabel:{"count":2}')).toBeInTheDocument()
    expect(screen.getByText('commandsLabel:{"count":2}')).toBeInTheDocument()
  })

  it("hides itself when nothing is reported", () => {
    useSdkSessionCapabilities.mockReturnValue({ models: null, commands: null, refresh: jest.fn() })
    const { queryByTestId } = render(<SdkCapabilitiesCard />)
    expect(queryByTestId("sdk-capabilities-card")).toBeNull()
  })

  it("renders only the commands section when models are absent", () => {
    useSdkSessionCapabilities.mockReturnValue({ models: null, commands, refresh: jest.fn() })
    render(<SdkCapabilitiesCard />)
    expect(screen.getByTestId("sdk-capabilities-commands")).toBeInTheDocument()
    expect(screen.queryByTestId("sdk-capabilities-models")).toBeNull()
  })
})
