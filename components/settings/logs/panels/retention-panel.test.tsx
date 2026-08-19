const saveAppSettings = jest.fn(async () => undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { save: typeof saveAppSettings }) => unknown) =>
    selector({ save: saveAppSettings }),
}))

import { useEffect } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_RETENTION_SETTINGS, RETENTION_BOUNDS } from "@/lib/logging"
import { useLogSettingsDraft } from "@/hooks/logging/use-log-settings-draft"

import { LogsRetentionPanel } from "./retention-panel"

let draft: ReturnType<typeof useLogSettingsDraft>

function Harness() {
  const value = useLogSettingsDraft()
  useEffect(() => {
    draft = value
  })
  return <LogsRetentionPanel draft={value} />
}

beforeEach(() => {
  window.localStorage.clear()
})

describe("LogsRetentionPanel", () => {
  it("shows both caps with their current values", () => {
    render(<Harness />)
    expect(screen.getByRole("slider", { name: /Maximum Entries/i })).toHaveAttribute(
      "aria-valuenow",
      String(DEFAULT_RETENTION_SETTINGS.maxEntries)
    )
    expect(screen.getByRole("slider", { name: /Maximum Age/i })).toHaveAttribute(
      "aria-valuenow",
      String(DEFAULT_RETENTION_SETTINGS.maxAgeDays)
    )
  })

  it("spells out that the two caps race rather than combine", async () => {
    // Two independent limits read as ambiguous — the summary says which wins.
    render(<Harness />)
    expect(screen.getByTestId("logs-retention-summary")).toHaveTextContent(
      /Whichever limit is reached first wins/
    )
  })

  it("keeps the summary in step with the sliders", async () => {
    render(<Harness />)
    const days = screen.getByRole("slider", { name: /Maximum Age/i })

    days.focus()
    await userEvent.keyboard("{ArrowRight}")

    const expected = DEFAULT_RETENTION_SETTINGS.maxAgeDays + 1
    expect(draft.retention.maxAgeDays).toBe(expected)
    expect(screen.getByTestId("logs-retention-summary")).toHaveTextContent(
      `nothing older than ${expected} days`
    )
  })

  it("writes the entry cap into the draft in steps of a thousand", async () => {
    render(<Harness />)
    const entries = screen.getByRole("slider", { name: /Maximum Entries/i })

    entries.focus()
    await userEvent.keyboard("{ArrowRight}")

    expect(draft.retention.maxEntries).toBe(DEFAULT_RETENTION_SETTINGS.maxEntries + 1000)
  })

  it("offers exactly the range the reader clamps to", () => {
    render(<Harness />)
    const entries = screen.getByRole("slider", { name: /Maximum Entries/i })
    expect(entries).toHaveAttribute("aria-valuemin", String(RETENTION_BOUNDS.maxEntries.min))
    expect(entries).toHaveAttribute("aria-valuemax", String(RETENTION_BOUNDS.maxEntries.max))

    const days = screen.getByRole("slider", { name: /Maximum Age/i })
    expect(days).toHaveAttribute("aria-valuemin", String(RETENTION_BOUNDS.maxAgeDays.min))
    expect(days).toHaveAttribute("aria-valuemax", String(RETENTION_BOUNDS.maxAgeDays.max))
  })

  it("keeps the performance caveat visible", () => {
    render(<Harness />)
    expect(screen.getByTestId("logs-retention-performance")).toHaveTextContent(/Performance Note/i)
  })
})
