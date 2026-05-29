/**
 * @jest-environment jsdom
 *
 * Unit tests for AdapterDetailPanel — per-adapter header + inner tab shell.
 * Covers: loading/missing state, header badges, enable toggle, default tab
 * on mount, tab switching, and correct adapterId scoping of inner tabs.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

// ---------------------------------------------------------------------------
// Navigation mocks (useSelectedAdapter uses useRouter + useSearchParams)
// ---------------------------------------------------------------------------

// useSelectedAdapter drives the inner-tab state via router.replace +
// useSearchParams. To let `fireEvent.click(tab)` actually switch the
// rendered tab we wire the two together via a shared `currentSearch`
// string plus a React `useSyncExternalStore` subscription so a
// `replace()` call notifies every consumer and triggers re-render.
let currentSearch = ""
const navSubscribers = new Set<() => void>()
const mockRouterReplace = jest.fn((href: string) => {
  const qIdx = href.indexOf("?")
  currentSearch = qIdx >= 0 ? href.slice(qIdx + 1) : ""
  navSubscribers.forEach((cb) => cb())
})

jest.mock("next/navigation", () => {
  // Require lazily so jest's mock hoisting doesn't bite us — by the time
  // this factory is called the React runtime is fully initialised.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useSyncExternalStore } = require("react") as typeof import("react")
  return {
    useRouter: () => ({ replace: mockRouterReplace }),
    useSearchParams: () => {
      useSyncExternalStore(
        (cb: () => void) => {
          navSubscribers.add(cb)
          return () => navSubscribers.delete(cb)
        },
        () => currentSearch,
        () => currentSearch
      )
      return new URLSearchParams(currentSearch)
    },
    usePathname: () => "/settings",
  }
})

// ---------------------------------------------------------------------------
// Dexie / DB mocks
// ---------------------------------------------------------------------------

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

const mockUpdateAdapterInstance = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/adapter-instances", () => ({
  updateAdapterInstance: (...args: unknown[]) => mockUpdateAdapterInstance(...args),
}))

// The header derives a unified status badge from the live health hook.
jest.mock("@/hooks/connectors/use-adapter-health", () => ({
  useAdapterHealth: () => ({ current: { state: "running" }, breaker: null, rateBucket: null }),
}))

// ---------------------------------------------------------------------------
// dexie-react-hooks — control useLiveQuery per test
// ---------------------------------------------------------------------------

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

import { useLiveQuery } from "dexie-react-hooks"
const mockUseLiveQuery = useLiveQuery as jest.MockedFunction<typeof useLiveQuery>

// ---------------------------------------------------------------------------
// Child tab mocks — prevent deep render trees / additional Dexie calls
// ---------------------------------------------------------------------------

jest.mock("@/components/settings/connections/adapters/tabs/config-detail", () => ({
  ConfigDetail: ({ row }: { row: { id: string } }) => (
    <div data-testid="mock-config-detail" data-adapter-id={row.id} />
  ),
}))

jest.mock("@/components/settings/connections/adapters/tabs/health-detail", () => ({
  HealthDetail: ({ adapterId }: { adapterId: string }) => (
    <div data-testid="mock-health-detail" data-adapter-id={adapterId} />
  ),
}))

jest.mock("@/components/settings/connections/adapters/tabs/conversations-detail", () => ({
  ConversationsDetail: ({ adapterId }: { adapterId: string }) => (
    <div data-testid="mock-conversations-detail" data-adapter-id={adapterId} />
  ),
}))

jest.mock("@/components/settings/connections/tabs/audit-tab", () => ({
  AuditTab: ({ adapterId }: { adapterId: string }) => (
    <div data-testid="mock-audit-tab" data-adapter-id={adapterId} />
  ),
}))

jest.mock("@/components/settings/connections/tabs/outbound-tab", () => ({
  OutboundTab: ({ adapterId }: { adapterId: string }) => (
    <div data-testid="mock-outbound-tab" data-adapter-id={adapterId} />
  ),
}))

// ---------------------------------------------------------------------------
// Subject import (after all mocks)
// ---------------------------------------------------------------------------

import { AdapterDetailPanel } from "./adapter-detail-panel"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

// ---------------------------------------------------------------------------
// i18n messages covering every key the component renders
// ---------------------------------------------------------------------------

const messages = {
  settings: {
    connections: {
      adapters: {
        enableAria: "Enable {name}",
        disableAria: "Disable {name}",
        enabled: "Enabled",
        disabled: "Disabled",
        detail: {
          adapterMissing: "Adapter row not found. It may have been deleted in another tab.",
        },
        detailTabs: {
          config: "Config",
          health: "Health",
          conversations: "Conversations",
          audit: "Audit",
          outbound: "Outbound",
        },
      },
    },
  },
}

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  )
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const baseRow: AdapterInstanceRow = {
  id: "tg-1",
  type: "telegram",
  displayName: "My Telegram Bot",
  enabled: true,
  transportMode: "longpoll",
  settings: {},
  credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
  trigger: defaultPrivateChatPolicy(),
  defaultMode: "auto",
  createdAt: 1000,
  updatedAt: 1000,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
  currentSearch = ""
})

describe("AdapterDetailPanel — missing row", () => {
  it("renders the missing-adapter card when useLiveQuery returns undefined", () => {
    mockUseLiveQuery.mockReturnValue(undefined)
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    expect(screen.getByText(/adapter row not found/i)).toBeInTheDocument()
    expect(screen.queryByTestId("adapter-detail-panel")).not.toBeInTheDocument()
  })
})

describe("AdapterDetailPanel — header", () => {
  beforeEach(() => {
    mockUseLiveQuery.mockReturnValue(baseRow as unknown as ReturnType<typeof useLiveQuery>)
  })

  it("renders the panel wrapper when the row exists", () => {
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    expect(screen.getByTestId("adapter-detail-panel")).toBeInTheDocument()
  })

  it("shows the adapter display name", () => {
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    expect(screen.getByText("My Telegram Bot")).toBeInTheDocument()
  })

  it("shows the adapter type badge", () => {
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    expect(screen.getByText("telegram")).toBeInTheDocument()
  })

  it("shows the defaultMode badge", () => {
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    expect(screen.getByText("auto")).toBeInTheDocument()
  })

  it("renders the enable/disable toggle reflecting the row's enabled state", () => {
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    const toggle = screen.getByTestId("adapter-detail-toggle")
    expect(toggle).toBeInTheDocument()
    // Row is enabled → aria-label is 'Disable …'
    expect(toggle).toHaveAttribute("aria-label", "Disable My Telegram Bot")
  })

  it("renders 'Disabled' label when row.enabled is false", () => {
    const disabledRow = { ...baseRow, enabled: false }
    mockUseLiveQuery.mockReturnValue(disabledRow as unknown as ReturnType<typeof useLiveQuery>)
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    expect(screen.getByText("Disabled")).toBeInTheDocument()
    const toggle = screen.getByTestId("adapter-detail-toggle")
    expect(toggle).toHaveAttribute("aria-label", "Enable My Telegram Bot")
  })

  it("calls updateAdapterInstance with toggled enabled state when switch is clicked", async () => {
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    fireEvent.click(screen.getByTestId("adapter-detail-toggle"))
    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith("tg-1", { enabled: false })
    })
  })
})

describe("AdapterDetailPanel — inner tabs", () => {
  beforeEach(() => {
    mockUseLiveQuery.mockReturnValue(baseRow as unknown as ReturnType<typeof useLiveQuery>)
  })

  it("defaults to the Config tab on mount", () => {
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    // Config tab content is visible (not hidden) by default
    expect(screen.getByTestId("mock-config-detail")).toBeInTheDocument()
  })

  it("passes the row to ConfigDetail", () => {
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    expect(screen.getByTestId("mock-config-detail")).toHaveAttribute("data-adapter-id", "tg-1")
  })

  it("switches to the Health tab and passes adapterId", async () => {
    const user = userEvent.setup()
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    await user.click(screen.getByRole("tab", { name: /health/i }))
    await waitFor(() =>
      expect(screen.getByTestId("mock-health-detail")).toHaveAttribute("data-adapter-id", "tg-1")
    )
  })

  it("switches to the Conversations tab and passes adapterId", async () => {
    const user = userEvent.setup()
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    await user.click(screen.getByRole("tab", { name: /conversations/i }))
    await waitFor(() =>
      expect(screen.getByTestId("mock-conversations-detail")).toHaveAttribute(
        "data-adapter-id",
        "tg-1"
      )
    )
  })

  it("switches to the Audit tab and passes adapterId", async () => {
    const user = userEvent.setup()
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    await user.click(screen.getByRole("tab", { name: /^audit$/i }))
    await waitFor(() =>
      expect(screen.getByTestId("mock-audit-tab")).toHaveAttribute("data-adapter-id", "tg-1")
    )
  })

  it("switches to the Outbound tab and passes adapterId", async () => {
    const user = userEvent.setup()
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    await user.click(screen.getByRole("tab", { name: /outbound/i }))
    await waitFor(() =>
      expect(screen.getByTestId("mock-outbound-tab")).toHaveAttribute("data-adapter-id", "tg-1")
    )
  })

  it("renders all five tab triggers", () => {
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    expect(screen.getByRole("tab", { name: /^config$/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /^health$/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /conversations/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /^audit$/i })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /outbound/i })).toBeInTheDocument()
  })

  it("uses the URL-backed tab when adapterTab param is pre-set", () => {
    currentSearch = "adapterTab=health"
    render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    expect(screen.getByTestId("mock-health-detail")).toBeInTheDocument()
  })
})

describe("AdapterDetailPanel — adapterId scoping", () => {
  it("re-queries Dexie when adapterId prop changes", () => {
    mockUseLiveQuery.mockReturnValue(baseRow as unknown as ReturnType<typeof useLiveQuery>)
    const { rerender } = render(withIntl(<AdapterDetailPanel adapterId="tg-1" />))
    expect(mockUseLiveQuery).toHaveBeenCalled()

    const secondRow: AdapterInstanceRow = {
      ...baseRow,
      id: "dc-2",
      type: "discord",
      displayName: "My Discord Bot",
    }
    mockUseLiveQuery.mockReturnValue(secondRow as unknown as ReturnType<typeof useLiveQuery>)
    rerender(withIntl(<AdapterDetailPanel adapterId="dc-2" />))
    expect(screen.getByText("My Discord Bot")).toBeInTheDocument()
  })
})
