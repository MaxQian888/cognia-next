/**
 * @jest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"

const copyMock = jest.fn(async () => true)
jest.mock("@cognia/plugin-ui", () => ({
  ...jest.requireActual("@cognia/plugin-ui"),
  useCopy: () => ({ copied: false, copy: copyMock }),
}))

import manifestJson from "../plugin.json"
import {
  CLIPBOARD_PREVIEW_ENTRIES,
  ClipboardHistoryCard,
  formatRelative,
  PLUGIN_ID,
  safeLocale,
} from "./clipboard-history-card"

/** Register the plugin's own bundle the way the manager does on enable. */
function registerBundle() {
  const locales = manifestJson.i18n.locales as Record<string, Record<string, string>>
  registerPluginI18n({
    pluginId: PLUGIN_ID,
    messages: Object.fromEntries(
      Object.entries(locales).map(([locale, dict]) => [
        locale,
        Object.fromEntries(
          Object.entries(dict).map(([key, value]) => [`plugin.${PLUGIN_ID}.${key}`, value])
        ),
      ])
    ),
  })
}

const part = (output: unknown): ToolUIPart =>
  ({
    type: "tool-clipboard_history_list",
    state: "output-available",
    input: {},
    output,
  }) as unknown as ToolUIPart

describe("ClipboardHistoryCard", () => {
  beforeEach(() => {
    copyMock.mockClear()
    registerBundle()
  })
  afterEach(() => {
    // Unmount first: unregistering re-renders every mounted consumer.
    cleanup()
    unregisterPluginI18n(PLUGIN_ID)
  })

  it("renders entries newest-first with a copy button each and a count badge", () => {
    const now = Date.now()
    render(
      <ClipboardHistoryCard
        part={part({
          ok: true,
          entries: [
            { text: "older", capturedAt: now - 120_000 },
            { text: "newest", capturedAt: now - 1_000 },
          ],
        })}
      />
    )
    expect(screen.getByText("Clipboard history")).toBeInTheDocument()
    expect(screen.getByTestId("clipboard-history-card-badge")).toHaveTextContent("2 entries")
    const items = screen.getByTestId("clipboard-history-entries").querySelectorAll("li")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent("newest")
    expect(items[1]).toHaveTextContent("older")
    expect(items[1]).toHaveTextContent("2 minutes ago")
    const copyButton = screen.getAllByRole("button", { name: "Copy entry" })[1]
    // ≥ 36px touch target on small (touch) screens.
    expect(copyButton.className).toContain("size-9")
    fireEvent.click(copyButton)
    expect(copyMock).toHaveBeenCalledWith("older")
  })

  it("uses the singular badge for one entry and flags privacy mode", () => {
    render(
      <ClipboardHistoryCard
        part={part({ ok: true, privacyMode: true, entries: [{ text: "x", capturedAt: 1 }] })}
      />
    )
    expect(screen.getByTestId("clipboard-history-card-badge")).toHaveTextContent("1 entry")
    expect(screen.getByTestId("clipboard-history-privacy")).toHaveTextContent(/Privacy mode/)
  })

  it("collapses long lists behind a show-all toggle", () => {
    const entries = Array.from({ length: CLIPBOARD_PREVIEW_ENTRIES + 3 }, (_, i) => ({
      text: `entry ${i}`,
      capturedAt: 1_700_000_000_000 + i,
    }))
    render(<ClipboardHistoryCard part={part({ ok: true, entries })} />)
    expect(screen.getByTestId("clipboard-history-entries").querySelectorAll("li")).toHaveLength(
      CLIPBOARD_PREVIEW_ENTRIES
    )
    expect(screen.getByTestId("clipboard-history-toggle")).toHaveTextContent(
      `Show all ${entries.length}`
    )
    fireEvent.click(screen.getByTestId("clipboard-history-toggle"))
    expect(screen.getByTestId("clipboard-history-entries").querySelectorAll("li")).toHaveLength(
      entries.length
    )
    expect(screen.getByTestId("clipboard-history-toggle")).toHaveTextContent("Show less")
  })

  it("shows the empty state and declines payloads without entries", () => {
    render(<ClipboardHistoryCard part={part(JSON.stringify({ ok: true, entries: [] }))} />)
    expect(screen.getByText("No clipboard entries yet.")).toBeInTheDocument()
    const { container } = render(<ClipboardHistoryCard part={part({ ok: true })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("ships every card key in both locales", () => {
    const locales = manifestJson.i18n.locales as Record<string, Record<string, string>>
    expect(Object.keys(locales["zh-CN"]).sort()).toEqual(Object.keys(locales.en).sort())
  })
})

describe("formatRelative", () => {
  it("picks the largest whole unit and follows the locale", () => {
    const now = 1_700_000_000_000
    expect(formatRelative("en", now - 3 * 60_000, now)).toBe("3 minutes ago")
    expect(formatRelative("en", now - 2 * 24 * 60 * 60_000, now)).toBe("2 days ago")
    expect(formatRelative("en", now, now)).toBe("now")
    expect(formatRelative("zh-CN", now - 3 * 60_000, now)).toBe("3分钟前")
  })

  it("falls back to English when the locale key is unresolved", () => {
    expect(safeLocale("format.locale")).toBe("en")
    expect(safeLocale("zh-CN")).toBe("zh-CN")
    expect(formatRelative("format.locale", 0, 60_000)).toBe("1 minute ago")
  })
})
