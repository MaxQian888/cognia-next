/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ConnectorPolicyList } from "./connector-policy-list"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      listTitle: "Reply policies",
      listDescription: "Per-connector reply mode, mute, and quiet hours.",
      modeAuto: "Auto",
      modeDraft: "Draft",
      modeManual: "Manual",
      mutedBadge: "Muted",
      title: `Settings for ${vars?.name ?? ""}`,
      description: "Choose how this conversation handles incoming messages.",
      defaultMode: "Default mode",
      defaultModeHelp: "help",
      muted: "Mute this conversation",
      mutedHelp: "help",
      quietHours: "Quiet hours",
      quietHoursHelp: "help",
      from: "From",
      to: "To",
      save: "Save",
      saving: "Saving…",
    }
    return map[key] ?? key
  },
}))

jest.mock("@/hooks/ui/use-back-dismiss", () => ({ useBackDismiss: jest.fn() }))

// dexie-react-hooks must be mocked — the real useLiveQuery needs a Dexie
// observable context that jsdom tests don't set up.
let liveRows: AdapterInstanceRow[] | undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveRows,
}))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({ enqueue: jest.fn(async () => ({})) }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

function makeAdapter(overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "ad-1",
    type: "telegram",
    displayName: "Team Telegram",
    enabled: true,
    transportMode: "polling",
    settings: {},
    credentialsRef: { keyringService: "svc", accounts: [] },
    trigger: {},
    defaultMode: "auto",
    ...(overrides as object),
  } as unknown as AdapterInstanceRow
}

describe("<ConnectorPolicyList />", () => {
  it("renders nothing while loading or when no adapter is enabled", () => {
    liveRows = undefined
    const { container, rerender } = render(<ConnectorPolicyList />)
    expect(container).toBeEmptyDOMElement()
    liveRows = []
    rerender(<ConnectorPolicyList />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists enabled adapters with mode / muted / quiet-hours summary", () => {
    liveRows = [
      makeAdapter(),
      makeAdapter({
        id: "ad-2",
        displayName: "Support Discord",
        defaultMode: "draft",
        muted: true,
        quietHours: { from: "22:00", to: "07:00", tz: "UTC" },
      }),
    ]
    render(<ConnectorPolicyList />)
    expect(screen.getByTestId("connector-policy-list")).toBeInTheDocument()
    expect(screen.getByText("Team Telegram")).toBeInTheDocument()
    expect(screen.getByText("Auto")).toBeInTheDocument()
    expect(screen.getByText("Draft")).toBeInTheDocument()
    expect(screen.getByText("Muted")).toBeInTheDocument()
    expect(screen.getByText("22:00–07:00")).toBeInTheDocument()
  })

  it("opens the policy sheet for the tapped adapter", async () => {
    liveRows = [makeAdapter()]
    const user = userEvent.setup()
    render(<ConnectorPolicyList />)

    await user.click(screen.getByTestId("connector-policy-row-ad-1"))

    await waitFor(() =>
      expect(screen.getByTestId("connector-policy-sheet")).toBeInTheDocument()
    )
    expect(screen.getByText("Settings for Team Telegram")).toBeInTheDocument()
  })
})
