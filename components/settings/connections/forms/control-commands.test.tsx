/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

const mockRowGet = jest.fn().mockResolvedValue(undefined)
const mockUpdate = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    adapterInstances: { get: (...a: unknown[]) => mockRowGet(...(a as [string])) },
  })),
}))

jest.mock("@/lib/db/adapter-instances", () => ({
  __esModule: true,
  updateAdapterInstance: (...a: unknown[]) => mockUpdate(...a),
}))

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))

// jsdom can't drive Radix Select portals; stub Select to a native select
// carrying the 3 known options, and null out the Trigger/Content/Item shells.
jest.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange }: { value?: string; onValueChange?: (v: string) => void }) => (
    <select
      data-testid="cc-mode-select"
      value={value ?? ""}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      <option value="everyone">Everyone</option>
      <option value="private-only">Private only</option>
      <option value="allowlist">Allowlist</option>
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
}))

import { useLiveQuery } from "dexie-react-hooks"
const mockUseLiveQuery = useLiveQuery as jest.MockedFunction<typeof useLiveQuery>

import { ControlCommands, readControlCommands, parseUserIds } from "./control-commands"

function makeRow(cc: AdapterInstanceRow["controlCommands"]): AdapterInstanceRow {
  return {
    id: "a1",
    type: "telegram",
    displayName: "Test",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    credentialsRef: { keyringService: "x", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    controlCommands: cc,
  } as unknown as AdapterInstanceRow
}

function renderWith(row: AdapterInstanceRow | undefined): void {
  mockUseLiveQuery.mockReturnValue(row as never)
  mockUpdate.mockClear()
  render(<ControlCommands adapterId="a1" />)
}

describe("readControlCommands / parseUserIds (pure helpers)", () => {
  it("defaults to enabled + private-only when undefined", () => {
    expect(readControlCommands(undefined)).toEqual({
      enabled: true,
      mode: "private-only",
      allowedUserIds: [],
    })
  })

  it("reads explicit values", () => {
    expect(
      readControlCommands(
        makeRow({ enabled: false, mode: "allowlist", allowedUserIds: ["u1", "u2"] })
      )
    ).toEqual({ enabled: false, mode: "allowlist", allowedUserIds: ["u1", "u2"] })
  })

  it("parses user ids one per line, trimming blanks", () => {
    expect(parseUserIds("u1\n u2 \n\n  u3 ")).toEqual(["u1", "u2", "u3"])
  })
})

describe("ControlCommands component", () => {
  it("renders with defaults when the row has no controlCommands", () => {
    renderWith(makeRow(undefined))
    expect(screen.getByTestId("control-commands")).toBeInTheDocument()
    expect(screen.getByTestId("cc-mode-select")).toHaveValue("private-only")
    // allowlist textarea is hidden in private-only mode.
    expect(screen.queryByTestId("control-commands-ids")).not.toBeInTheDocument()
  })

  it("toggling enabled off persists controlCommands.enabled=false", async () => {
    renderWith(makeRow(undefined))
    fireEvent.click(screen.getByTestId("control-commands-enabled"))
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        "a1",
        expect.objectContaining({
          controlCommands: expect.objectContaining({ enabled: false }),
        })
      )
    })
  })

  it("changing mode persists the new mode", async () => {
    renderWith(makeRow(undefined))
    fireEvent.change(screen.getByTestId("cc-mode-select"), {
      target: { value: "allowlist" },
    })
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        "a1",
        expect.objectContaining({
          controlCommands: expect.objectContaining({ mode: "allowlist" }),
        })
      )
    })
  })

  it("renders the allowlist textarea when the row is already allowlist", () => {
    renderWith(makeRow({ enabled: true, mode: "allowlist", allowedUserIds: ["u1"] }))
    expect(screen.getByTestId("control-commands-ids")).toBeInTheDocument()
  })

  it("blurring the allowlist textarea persists the parsed user ids", async () => {
    renderWith(makeRow({ enabled: true, mode: "allowlist", allowedUserIds: [] }))
    const ta = screen.getByTestId("control-commands-ids") as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "u_1\nu_2" } })
    fireEvent.blur(ta)
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        "a1",
        expect.objectContaining({
          controlCommands: expect.objectContaining({ allowedUserIds: ["u_1", "u_2"] }),
        })
      )
    })
  })
})
