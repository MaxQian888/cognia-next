// ADR-0028 §UI surfaces — SandboxShield unit tests.

import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { resolveShieldState, SandboxShield } from "./sandbox-shield"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn(),
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

// Provide a TooltipProvider so the shield's Tooltip can mount in jsdom.
jest.mock("@/components/ui/tooltip", () => {
  const Real = jest.requireActual("@/components/ui/tooltip")
  return {
    ...Real,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }
})

import { useSettingsStore } from "@/stores/settings"
import { useLiveQuery } from "dexie-react-hooks"

const mockUseSettings = useSettingsStore as unknown as jest.Mock
const mockUseLiveQuery = useLiveQuery as unknown as jest.Mock

const MESSAGES = {
  chat: {
    composer: {
      sandboxShield: {
        label: {
          os: "OS active",
          microvm: "microVM active",
          off: "Off",
        },
        tooltip: {
          os: "OS tier tooltip",
          microvm: "microVM tooltip",
          off: "Off tooltip",
        },
      },
    },
  },
}

function withIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES}>
      {ui}
    </NextIntlClientProvider>
  )
}

const session: ChatSession = {
  id: "s1",
  title: "x",
  characterId: "c1",
  createdAt: 0,
  updatedAt: 0,
}

beforeEach(() => {
  mockUseSettings.mockReset()
  mockUseLiveQuery.mockReset()
})

describe("resolveShieldState", () => {
  it("returns 'off' when no level enables sandbox", () => {
    expect(resolveShieldState({ session: null, defaultEnabled: false })).toBe("off")
  })

  it("session.sandboxEnabled true overrides everything", () => {
    expect(
      resolveShieldState({
        session: { ...session, sandboxEnabled: true },
        characterSandboxEnabled: false,
        defaultEnabled: false,
      })
    ).toBe("os")
  })

  it("character.sandboxEnabled wins over app default", () => {
    expect(
      resolveShieldState({
        session,
        characterSandboxEnabled: true,
        defaultEnabled: false,
      })
    ).toBe("os")
  })

  it("character.sandboxTier overrides app default tier", () => {
    expect(
      resolveShieldState({
        session,
        characterSandboxEnabled: true,
        characterSandboxTier: "microvm",
        defaultTier: "os",
      })
    ).toBe("microvm")
  })

  it("app default tier kicks in when enabled but no character tier", () => {
    expect(
      resolveShieldState({
        session,
        defaultEnabled: true,
        defaultTier: "microvm",
      })
    ).toBe("microvm")
  })

  it("defaults tier to 'os' when neither layer specifies it", () => {
    expect(
      resolveShieldState({
        session,
        defaultEnabled: true,
      })
    ).toBe("os")
  })

  it("session.sandboxTier beats the character tier", () => {
    expect(
      resolveShieldState({
        session: { ...session, sandboxEnabled: true, sandboxTier: "cua-desktop" },
        characterSandboxTier: "microvm",
        defaultTier: "os",
      })
    ).toBe("cua-desktop")
  })

  it("surfaces the cua-desktop tier from the character layer", () => {
    expect(
      resolveShieldState({
        session,
        characterSandboxEnabled: true,
        characterSandboxTier: "cua-desktop",
      })
    ).toBe("cua-desktop")
  })

  it("still reports 'off' when the sandbox is disabled, whatever the tier", () => {
    expect(
      resolveShieldState({
        session: { ...session, sandboxEnabled: false, sandboxTier: "cua-desktop" },
        characterSandboxTier: "cua-desktop",
      })
    ).toBe("off")
  })
})

describe("SandboxShield component", () => {
  it("renders the 'off' state when nothing enables the sandbox", () => {
    mockUseSettings.mockReturnValue({})
    mockUseLiveQuery.mockReturnValue(undefined)
    withIntl(<SandboxShield session={session} forceState="off" />)
    const shield = screen.getByTestId("sandbox-shield")
    expect(shield).toHaveAttribute("data-state", "off")
    // Test config loads the real en.json, so assert against production
    // labels rather than the (unused) test-MESSAGES overrides.
    expect(shield).toHaveAttribute("aria-label", expect.stringContaining("off"))
  })

  it("renders the 'os' state when sandbox is enabled with OS tier", () => {
    withIntl(<SandboxShield session={session} forceState="os" />)
    const shield = screen.getByTestId("sandbox-shield")
    expect(shield).toHaveAttribute("data-state", "os")
    expect(shield).toHaveAttribute("aria-label", expect.stringMatching(/OS/))
  })

  it("renders the 'microvm' state with the dashed shield", () => {
    withIntl(<SandboxShield session={session} forceState="microvm" />)
    const shield = screen.getByTestId("sandbox-shield")
    expect(shield).toHaveAttribute("data-state", "microvm")
    expect(shield).toHaveAttribute("aria-label", expect.stringMatching(/microVM/))
  })

  it("renders the 'cua-desktop' state with a distinct glyph, not a shield", () => {
    const { container } = withIntl(<SandboxShield session={session} forceState="cua-desktop" />)
    const shield = screen.getByTestId("sandbox-shield")
    expect(shield).toHaveAttribute("data-state", "cua-desktop")
    expect(shield.getAttribute("aria-label")).toBeTruthy()
    // Execution moving to another machine is a bigger claim than "isolated
    // here" — it must not be a recoloured shield.
    expect(container.querySelector("svg.lucide-shield")).toBeNull()
    // The tier is withdrawn (`SandboxSessionRuntime` refuses the binding), so
    // the badge must read as inert rather than as active protection.
    expect(container.querySelector("svg")).toHaveClass("text-muted-foreground")
    expect(container.querySelector("svg")).not.toHaveClass("text-violet-500")
  })

  it("resolves state from store hooks when forceState is omitted", () => {
    mockUseSettings.mockImplementation((selector?: (s: { settings?: unknown }) => unknown) => {
      const state = {
        settings: { sandboxDefaultEnabled: true, sandboxTier: "microvm" as const },
      }
      return selector ? selector(state) : state
    })
    mockUseLiveQuery.mockReturnValue(undefined)
    withIntl(<SandboxShield session={session} />)
    const shield = screen.getByTestId("sandbox-shield")
    expect(shield).toHaveAttribute("data-state", "microvm")
  })
})
