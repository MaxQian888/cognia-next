/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

const mockUpdate = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    adapterInstances: { get: jest.fn() },
  })),
}))

jest.mock("@/lib/db/adapter-instances", () => ({
  __esModule: true,
  updateAdapterInstance: (...a: unknown[]) => mockUpdate(...a),
}))

let fixtureRow: AdapterInstanceRow | undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => fixtureRow,
}))

// Native-checkbox stub for the Radix Switch (same pattern as
// outbound-tuning.test.tsx) so fireEvent.click flips it in jsdom.
jest.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...rest
  }: {
    checked?: boolean
    onCheckedChange?: (v: boolean) => void
  }) => (
    <input
      type="checkbox"
      checked={checked ?? false}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      {...rest}
    />
  ),
}))

import { ReplyQuotingDefault } from "./reply-quoting-default"

function makeRow(patch: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "a1",
    type: "telegram",
    displayName: "Bot A",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    credentialsRef: { keyringService: "x", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as AdapterInstanceRow
}

function setup(rowPatch: Partial<AdapterInstanceRow> = {}): void {
  fixtureRow = makeRow(rowPatch)
  mockUpdate.mockClear()
  render(<ReplyQuotingDefault adapterId="a1" />)
}

describe("ReplyQuotingDefault", () => {
  it("renders the switch ON when the row has no explicit value (default on)", () => {
    setup()
    expect(screen.getByTestId("reply-quoting-default")).toBeInTheDocument()
    expect(screen.getByTestId("reply-quoting-default-switch")).toBeChecked()
  })

  it("renders the switch OFF when the row opted out", () => {
    setup({ replyQuoting: false })
    expect(screen.getByTestId("reply-quoting-default-switch")).not.toBeChecked()
  })

  it("persists false when switched off and clears (undefined) when switched back on", () => {
    setup()
    fireEvent.click(screen.getByTestId("reply-quoting-default-switch"))
    expect(mockUpdate).toHaveBeenCalledWith("a1", { replyQuoting: false })

    fixtureRow = makeRow({ replyQuoting: false })
    mockUpdate.mockClear()
    render(<ReplyQuotingDefault adapterId="a1" />)
    const switches = screen.getAllByTestId("reply-quoting-default-switch")
    fireEvent.click(switches[switches.length - 1])
    expect(mockUpdate).toHaveBeenCalledWith("a1", { replyQuoting: undefined })
  })

  it("renders nothing when THIS Slack install's grant lacks chat:write", () => {
    // The platform declares `send.reply`; this workspace cannot post at all,
    // so a reply-quoting toggle would configure something that never happens.
    setup({
      type: "slack",
      settings: { connectedScopes: { scopes: ["channels:history"], grantedAtMs: 1 } },
    })
    expect(screen.queryByTestId("reply-quoting-default")).toBeNull()
  })

  it("renders the control when the Slack grant does carry chat:write", () => {
    setup({
      type: "slack",
      settings: { connectedScopes: { scopes: ["chat:write"], grantedAtMs: 1 } },
    })
    expect(screen.getByTestId("reply-quoting-default")).toBeInTheDocument()
  })

  it("renders nothing for a platform whose adapter lacks send.reply (inert control avoided)", () => {
    setup({ type: "wechat-oa" })
    expect(screen.queryByTestId("reply-quoting-default")).not.toBeInTheDocument()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("renders nothing while the row is still loading", () => {
    fixtureRow = undefined
    render(<ReplyQuotingDefault adapterId="a1" />)
    expect(screen.queryByTestId("reply-quoting-default")).not.toBeInTheDocument()
  })
})
