// ADR-0028 §UI surfaces — SandboxShield unit tests.

import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { resolveShieldState, SandboxShield } from "./sandbox-shield"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn(),
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

// The shield is a Popover trigger (the repo's `status-bar-usage` pattern: a
// `title` for the hover hint, no nested Radix triggers). Render the content
// inline so the pin controls are assertable without driving a portal.
jest.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const updateSessionMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/sessions", () => ({
  updateSession: (...args: unknown[]) => updateSessionMock(...args),
}))

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
  updateSessionMock.mockClear()
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

describe("SandboxShield tier pin", () => {
  beforeEach(() => {
    mockUseSettings.mockReturnValue({})
    mockUseLiveQuery.mockReturnValue(undefined)
  })

  it("reports a session-stored tier as pinned and offers to release it", () => {
    // `lib/sandbox/pin-session-tier.ts` writes the tier onto the session so a
    // default changed elsewhere cannot re-tier a live conversation. A pin with
    // no way out would be worse than the drift, so the release lives here.
    const pinnedSession = { ...session, sandboxEnabled: true, sandboxTier: "microvm" as const }
    withIntl(<SandboxShield session={pinnedSession} />)

    expect(screen.getByTestId("sandbox-shield")).toHaveAttribute("data-pinned", "true")
    fireEvent.click(screen.getByTestId("sandbox-shield-unpin"))
    // Both halves: clearing the tier alone leaves the session looking like one
    // that was never pinned, and the next send pins it straight back.
    expect(updateSessionMock).toHaveBeenCalledWith("s1", {
      sandboxTier: undefined,
      sandboxTierFollowsDefault: true,
    })
  })

  it("does not claim a pin for a tier that is merely inherited", () => {
    mockUseLiveQuery.mockReturnValue({ sandboxEnabled: true, sandboxTier: "microvm" })
    withIntl(<SandboxShield session={session} />)

    const shield = screen.getByTestId("sandbox-shield")
    expect(shield).toHaveAttribute("data-state", "microvm")
    expect(shield).toHaveAttribute("data-pinned", "false")
    expect(screen.queryByTestId("sandbox-shield-unpin")).toBeNull()
  })

  it("offers no pin control at all when the sandbox is off", () => {
    withIntl(<SandboxShield session={{ ...session, sandboxTier: "microvm" }} forceState="off" />)
    expect(screen.getByTestId("sandbox-shield")).toHaveAttribute("data-pinned", "false")
    expect(screen.queryByTestId("sandbox-shield-unpin")).toBeNull()
  })
})
