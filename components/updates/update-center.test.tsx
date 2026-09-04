/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const packDialog = jest.fn()
jest.mock("@/components/settings/character-pack-update-dialog", () => ({
  CharacterPackUpdateDialog: (props: { open: boolean; characterId: string | null }) => {
    packDialog(props)
    return props.open ? <div data-testid="pack-diff">{props.characterId}</div> : null
  },
}))

import type { UpdateItem } from "@/lib/updates/adapter"

const hookState: {
  groups: { group: string; items: UpdateItem[] }[]
  items: UpdateItem[]
  checking: boolean
  check: jest.Mock
  apply: jest.Mock
  skip: jest.Mock
  defer: jest.Mock
  clearHold: jest.Mock
} = {
  groups: [],
  items: [],
  checking: false,
  check: jest.fn(async () => {}),
  apply: jest.fn(async () => {}),
  skip: jest.fn(async () => {}),
  defer: jest.fn(async () => {}),
  clearHold: jest.fn(async () => {}),
}

jest.mock("@/hooks/updates/use-update-center", () => ({
  useUpdateCenter: () => hookState,
}))

import { openUpdateCenter, __resetUpdateCenterOpen } from "@/lib/updates/open-update-center"

import { UpdateCenter } from "./update-center"

function item(overrides: Partial<UpdateItem> = {}): UpdateItem {
  return {
    key: "desktop:app",
    assetId: "app",
    kind: "desktop",
    executor: "tauri",
    state: "available",
    candidate: {
      assetId: "app",
      kind: "desktop",
      executor: "tauri",
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      channel: "stable",
      criticality: "routine",
      source: "catalog",
      provenance: "verified",
    },
    currentVersion: "1.0.0",
    action: "install-in-app",
    externallyInstalled: false,
    lastCheckedAt: Date.parse("2026-01-01T00:00:00Z"),
    ...overrides,
  }
}

beforeEach(() => {
  __resetUpdateCenterOpen()
  hookState.checking = false
  hookState.items = []
  hookState.groups = []
  for (const key of ["check", "apply", "skip", "defer", "clearHold"] as const) {
    hookState[key].mockClear()
  }
})

describe("UpdateCenter", () => {
  it("explains an empty list instead of showing a blank panel", () => {
    render(<UpdateCenter />)
    expect(screen.getByText("Nothing here can be updated on this device.")).toBeInTheDocument()
  })

  it("renders one section per group with its own hint", () => {
    hookState.items = [item()]
    hookState.groups = [
      { group: "apps-and-runtimes", items: [item()] },
      {
        group: "plugins-and-content",
        items: [item({ key: "plugin:a", kind: "plugin", executor: "plugin-runtime" })],
      },
    ]
    render(<UpdateCenter />)
    expect(screen.getByText("Apps and runtimes")).toBeInTheDocument()
    expect(screen.getByText("Plugins and content")).toBeInTheDocument()
    // A group with no rows is absent, not an empty heading.
    expect(screen.queryByText("Browser extensions")).not.toBeInTheDocument()
    expect(
      screen.getByText("Plugins, skills, and character packs installed into this app.")
    ).toBeInTheDocument()
  })

  it("runs a manual check on demand", () => {
    render(<UpdateCenter />)
    fireEvent.click(screen.getByTestId("update-check-all"))
    expect(hookState.check).toHaveBeenCalledWith(true)
  })

  it("runs an automatic check when the panel opens with autoCheck", async () => {
    render(<UpdateCenter autoCheck />)
    await waitFor(() => expect(hookState.check).toHaveBeenCalledWith(false))
  })

  it("does not check on open by default", () => {
    render(<UpdateCenter />)
    expect(hookState.check).not.toHaveBeenCalled()
  })

  it("disables the check button while a sweep runs", () => {
    hookState.checking = true
    render(<UpdateCenter />)
    expect(screen.getByTestId("update-check-all")).toBeDisabled()
  })

  it("says when nothing has been checked yet", () => {
    render(<UpdateCenter />)
    expect(screen.getByText("Not checked yet")).toBeInTheDocument()
  })

  it("applies a row with consent already given", async () => {
    hookState.items = [item()]
    hookState.groups = [{ group: "apps-and-runtimes", items: [item()] }]
    render(<UpdateCenter />)
    fireEvent.click(screen.getByTestId("update-apply-desktop:app"))
    await waitFor(() => expect(hookState.apply).toHaveBeenCalledWith("desktop:app", true))
  })

  it("opens the pack diff instead of installing a character pack", async () => {
    const pack = item({
      key: "character-pack:c1",
      assetId: "c1",
      kind: "character-pack",
      executor: "character-pack-runtime",
      action: "open-pack-diff",
      displayName: "Ada",
    })
    hookState.items = [pack]
    hookState.groups = [{ group: "plugins-and-content", items: [pack] }]
    render(<UpdateCenter />)
    fireEvent.click(screen.getByTestId("update-apply-character-pack:c1"))
    await waitFor(() => expect(screen.getByTestId("pack-diff")).toHaveTextContent("c1"))
    expect(hookState.apply).not.toHaveBeenCalled()
  })

  it("highlights the row an open request pointed at", async () => {
    hookState.items = [item()]
    hookState.groups = [{ group: "apps-and-runtimes", items: [item()] }]
    render(<UpdateCenter />)
    openUpdateCenter({ focusKey: "desktop:app" })
    await waitFor(() =>
      expect(screen.getByTestId("update-row-desktop:app").className).toContain("ring-2")
    )
  })
})
