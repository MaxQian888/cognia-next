/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import type { GlanceRequestBody } from "@/lib/glance/requests"
import {
  GLANCE_SNAPSHOT_VERSION,
  type GlanceQuotaSlice,
  type GlanceQuotaSource,
  type GlanceQuotaWindow,
  type GlanceSnapshotV1,
} from "@/lib/glance/snapshot"
import type { GlanceScope } from "@/types/glance/layout"

import { GlanceProvider, type GlanceContextValue } from "../glance-context"
import { GlanceQuotaModule } from "./glance-quota-module"

const NOW = 1_700_000_000_000

function makeWindow(id: string, overrides: Partial<GlanceQuotaWindow> = {}): GlanceQuotaWindow {
  return {
    id,
    labelKey: null,
    label: `Window ${id}`,
    kind: "window",
    usedPct: 10,
    resetAt: null,
    remaining: null,
    unit: null,
    currency: null,
    severity: "ok",
    ...overrides,
  }
}

function makeSource(overrides: Partial<GlanceQuotaSource> = {}): GlanceQuotaSource {
  return {
    key: "anthropic:acct-1",
    provider: "anthropic",
    accountId: "acct-1",
    accountLabel: null,
    state: "ok",
    windows: [makeWindow("w1")],
    fetchedAt: NOW - 60_000,
    error: null,
    ...overrides,
  }
}

function makeSnapshot(quota: GlanceQuotaSlice | null, scope: GlanceScope): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 1,
    revision: 1,
    generatedAt: NOW,
    config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, scope },
    workspace: null,
    when: {} as GlanceSnapshotV1["when"],
    actions: [],
    fleet: null,
    usage: null,
    quota,
    agenda: null,
    activity: null,
    recents: null,
    pet: null,
  }
}

function setup(
  sources: GlanceQuotaSource[] | null,
  options: {
    size?: "compact" | "standard" | "expanded"
    scope?: GlanceScope
    send?: (body: GlanceRequestBody) => Promise<string | null>
  } = {}
) {
  const route = jest.fn<void, [GlanceRequestBody]>()
  const send = jest.fn<Promise<string | null>, [GlanceRequestBody]>(
    options.send ?? (async () => null)
  )
  const quota: GlanceQuotaSlice | null = sources
    ? { updatedAt: NOW, refreshing: false, sources }
    : null
  const value: GlanceContextValue = {
    snapshot: makeSnapshot(quota, options.scope ?? "all"),
    platform: "desktop",
    width: "standard",
    now: NOW,
    send,
    route,
  }
  const utils = render(
    <GlanceProvider value={value}>
      <GlanceQuotaModule size={options.size ?? "standard"} />
    </GlanceProvider>
  )
  return { ...utils, route, send, user: userEvent.setup() }
}

/** A promise whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("GlanceQuotaModule", () => {
  it("shows a loading line while the quota slice is null", () => {
    setup(null)
    expect(screen.getByText("Reading quota…")).toBeInTheDocument()
  })

  describe("empty", () => {
    it("says there are no sources in compact", () => {
      setup([], { size: "compact" })
      expect(screen.getByText("No quota sources yet")).toBeInTheDocument()
    })

    it("says there are no sources in standard and routes to subscription settings", async () => {
      const { route, user } = setup([])
      await user.click(screen.getByText("No quota sources yet"))
      expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "subscription" })
    })

    it("routes the Manage link to subscription settings", async () => {
      const { route, user } = setup([makeSource()])
      await user.click(screen.getByRole("button", { name: "Manage" }))
      expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "subscription" })
    })
  })

  describe("compact", () => {
    it("summarises each source by its worst window", () => {
      setup(
        [
          makeSource({
            key: "anthropic:a",
            windows: [makeWindow("a", { usedPct: 30 }), makeWindow("b", { usedPct: 72.4 })],
          }),
          makeSource({
            key: "codex:b",
            provider: "codex",
            accountId: "b",
            windows: [makeWindow("c", { usedPct: 95 })],
            state: "warn",
          }),
        ],
        { size: "compact" }
      )
      expect(screen.getByText("Claude")).toBeInTheDocument()
      expect(screen.getByText("Codex")).toBeInTheDocument()
      expect(screen.getByText("72%")).toHaveClass("text-warning")
      expect(screen.getByText("95%")).toHaveClass("text-destructive")
    })

    it("leaves a healthy source uncoloured and a stale one muted", () => {
      setup(
        [
          makeSource({ key: "anthropic:a", windows: [makeWindow("a", { usedPct: 20 })] }),
          makeSource({
            key: "codex:b",
            provider: "codex",
            state: "stale",
            windows: [makeWindow("b", { usedPct: 99 })],
          }),
        ],
        { size: "compact" }
      )
      const healthy = screen.getByText("20%")
      expect(healthy).not.toHaveClass("text-warning")
      expect(healthy).not.toHaveClass("text-destructive")
      expect(screen.getByText("99%")).toHaveClass("text-muted-foreground")
    })

    it("shows Error for a failed source and an ellipsis while refreshing", () => {
      setup(
        [
          makeSource({ key: "anthropic:a", state: "error" }),
          makeSource({ key: "codex:b", provider: "codex", state: "refreshing", windows: [] }),
        ],
        { size: "compact" }
      )
      expect(screen.getByText("Error")).toHaveClass("text-destructive")
      expect(screen.getByText("…")).toBeInTheDocument()
    })

    it("omits disabled and discovered sources", () => {
      setup(
        [
          makeSource({ key: "anthropic:a" }),
          makeSource({ key: "codex:b", provider: "codex", state: "disabled" }),
          makeSource({
            key: "discovered:x",
            provider: "opencode",
            accountId: null,
            state: "discovered",
            windows: [],
          }),
        ],
        { size: "compact" }
      )
      expect(screen.getByText("Claude")).toBeInTheDocument()
      expect(screen.queryByText("Codex")).not.toBeInTheDocument()
      expect(screen.queryByText("opencode")).not.toBeInTheDocument()
    })

    it("falls back to the raw provider id when there is no translation", () => {
      setup([makeSource({ provider: "mystery-provider" })], { size: "compact" })
      expect(screen.getByText("mystery-provider")).toBeInTheDocument()
    })

    it("routes to subscription settings when clicked", async () => {
      const { route, user } = setup([makeSource()], { size: "compact" })
      await user.click(screen.getByRole("button", { name: "Open quota settings" }))
      expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "subscription" })
    })
  })

  describe("global tag", () => {
    it("is shown only when the panel scope is workspace", () => {
      const { unmount } = setup([makeSource()], { scope: "all" })
      expect(screen.queryByText("Global")).not.toBeInTheDocument()
      unmount()
      setup([makeSource()], { scope: "workspace" })
      expect(screen.getByText("Global")).toHaveAttribute(
        "title",
        "Quota belongs to the account, so the workspace filter doesn't apply."
      )
    })

    it("is also shown in compact", () => {
      setup([makeSource()], { size: "compact", scope: "workspace" })
      expect(screen.getByText("Global")).toBeInTheDocument()
    })
  })

  describe("standard source rows", () => {
    const threeWindows = [
      makeWindow("w1", { label: "Five hour", usedPct: 40, resetAt: NOW + 3_600_000 }),
      makeWindow("w2", { label: "Weekly", usedPct: 55 }),
      makeWindow("w3", { label: "Opus weekly", usedPct: 80, severity: "warn" }),
    ]

    it("shows the first two windows collapsed and the rest on expand, with an Updated line", async () => {
      const { user } = setup([makeSource({ windows: threeWindows })])
      const row = screen.getByRole("button", { name: "Expand Claude" })
      expect(row).toHaveAttribute("aria-expanded", "false")
      expect(row).toHaveAttribute("data-glance-expand", "anthropic:acct-1")
      expect(screen.getByText("Five hour")).toBeInTheDocument()
      expect(screen.getByText("Weekly")).toBeInTheDocument()
      expect(screen.queryByText("Opus weekly")).not.toBeInTheDocument()
      expect(screen.queryByText(/^Updated /)).not.toBeInTheDocument()

      await user.click(row)
      const open = screen.getByRole("button", { name: "Collapse Claude" })
      expect(open).toHaveAttribute("aria-expanded", "true")
      expect(screen.getByText("Opus weekly")).toBeInTheDocument()
      expect(screen.getByText(/^Updated /)).toBeInTheDocument()

      await user.click(open)
      expect(screen.queryByText("Opus weekly")).not.toBeInTheDocument()
      expect(screen.queryByText(/^Updated /)).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Expand Claude" })).toBeInTheDocument()
    })

    it("expands each source independently", async () => {
      const { user } = setup([
        makeSource({ key: "anthropic:a", windows: threeWindows }),
        makeSource({ key: "codex:b", provider: "codex", windows: threeWindows }),
      ])
      await user.click(screen.getByRole("button", { name: "Expand Claude" }))
      expect(screen.getByRole("button", { name: "Collapse Claude" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Expand Codex" })).toBeInTheDocument()
    })

    it("shows the percentage used and a meter per window", () => {
      setup([makeSource({ windows: [makeWindow("w1", { label: "Five hour", usedPct: 40.4 })] })])
      expect(screen.getByText("40% used")).toBeInTheDocument()
      expect(screen.getByRole("meter", { name: "Claude Five hour used" })).toHaveAttribute(
        "aria-valuenow",
        "40"
      )
    })

    it("resolves a window label through its i18n key, falling back to its label", () => {
      setup([
        makeSource({
          windows: [
            makeWindow("w1", { labelKey: "subscription.limits.meter.session", label: "ignored" }),
            makeWindow("w2", { labelKey: "no.such.key", label: "Custom window" }),
          ],
        }),
      ])
      expect(screen.getByText("Current session")).toBeInTheDocument()
      expect(screen.getByText("Custom window")).toBeInTheDocument()
    })

    it("shows the account label beside the provider name", () => {
      setup([makeSource({ accountLabel: "work@example.com" })])
      expect(screen.getByText("work@example.com")).toBeInTheDocument()
    })

    it("shows a reset hint when the window has a reset time", () => {
      setup([makeSource({ windows: [makeWindow("w1", { resetAt: NOW + 3_600_000 })] })])
      expect(screen.getByText(/^resets /)).toBeInTheDocument()
    })

    it("tags an exhausted source", () => {
      setup([makeSource({ state: "exhausted" })])
      expect(screen.getByText("Used up")).toBeInTheDocument()
    })

    it("tags a stale source with its age and offers a retry", () => {
      setup([makeSource({ state: "stale" })])
      expect(screen.getByText(/^Old · /)).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Retry Claude" })).toBeInTheDocument()
    })

    it("says No reading yet when expanded without a fetch time", async () => {
      const { user } = setup([makeSource({ fetchedAt: null, windows: [] })])
      await user.click(screen.getByRole("button", { name: "Expand Claude" }))
      expect(screen.getByText("No reading yet")).toBeInTheDocument()
    })

    it("shows a spinner for a source with no reading yet that is refreshing", () => {
      setup([makeSource({ state: "refreshing", windows: [], fetchedAt: null })])
      expect(screen.getByLabelText("Refreshing…")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /^Retry/ })).not.toBeInTheDocument()
    })

    it("shows a balance window as the remaining amount instead of a meter", () => {
      setup([
        makeSource({
          windows: [
            makeWindow("credit", {
              label: "Credit",
              kind: "balance",
              usedPct: null,
              remaining: 12.5,
              currency: "USD",
            }),
            makeWindow("tokens", {
              label: "Tokens",
              kind: "balance",
              usedPct: null,
              remaining: 300,
              unit: "credits",
            }),
          ],
        }),
      ])
      expect(screen.getByText("12.5")).toBeInTheDocument()
      expect(screen.getByText("300 credits")).toBeInTheDocument()
      expect(screen.queryByRole("meter")).not.toBeInTheDocument()
      expect(screen.queryByText(/% used/)).not.toBeInTheDocument()
    })

    it("shows a dash for a balance window with no known remaining amount", () => {
      setup([
        makeSource({
          windows: [
            makeWindow("credit", {
              label: "Credit",
              kind: "balance",
              usedPct: null,
              remaining: null,
            }),
          ],
        }),
      ])
      expect(screen.getByText("—")).toBeInTheDocument()
    })
  })

  describe("expanded", () => {
    it("shows every window and a static, non-expandable row", () => {
      setup(
        [
          makeSource({
            windows: [makeWindow("w1"), makeWindow("w2"), makeWindow("w3")],
          }),
        ],
        { size: "expanded" }
      )
      expect(screen.getByText("Window w3")).toBeInTheDocument()
      expect(screen.getByText(/^Updated /)).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /^(Expand|Collapse)/ })).not.toBeInTheDocument()
      expect(screen.getByTestId("glance-quota-source-anthropic:acct-1").tagName).toBe("DIV")
    })
  })

  describe("error state", () => {
    const errored = () =>
      makeSource({
        state: "error",
        error: "HTTP 429 from provider",
        windows: [makeWindow("w1", { usedPct: 61 })],
      })

    it("tags the source and keeps the last good reading", () => {
      setup([errored()])
      expect(screen.getByText("Error")).toBeInTheDocument()
      expect(screen.getByText("61% used")).toBeInTheDocument()
    })

    it("shows the error message and last-good age once expanded", async () => {
      const { user } = setup([errored()])
      expect(screen.queryByText("HTTP 429 from provider")).not.toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Expand Claude" }))
      expect(screen.getByText("HTTP 429 from provider")).toBeInTheDocument()
      expect(screen.getByText(/^Showing the reading from /)).toBeInTheDocument()
    })

    it("renders Retry outside of the row button (no button nested in a button)", () => {
      setup([errored()])
      const retry = screen.getByRole("button", { name: "Retry Claude" })
      const row = screen.getByRole("button", { name: "Expand Claude" })
      expect(row.contains(retry)).toBe(false)
      expect(retry.parentElement?.closest("button")).toBeNull()
      expect(row.querySelector("button")).toBeNull()
    })

    it("never nests a button in a button anywhere in the module", () => {
      const { container } = setup([
        errored(),
        makeSource({ key: "codex:b", provider: "codex", state: "stale" }),
        makeSource({ key: "opencode:c", provider: "opencode", state: "disabled" }),
      ])
      for (const button of Array.from(container.querySelectorAll("button"))) {
        expect(button.querySelector("button")).toBeNull()
      }
    })

    it("sends quota-refresh with the source key when Retry is clicked", async () => {
      const { send, user } = setup([errored()])
      await user.click(screen.getByRole("button", { name: "Retry Claude" }))
      expect(send).toHaveBeenCalledWith({ kind: "quota-refresh", key: "anthropic:acct-1" })
    })

    it("shows a spinner and hides Retry while the refresh is pending", async () => {
      const pending = deferred<string | null>()
      const { user } = setup([errored()], { send: () => pending.promise })
      await user.click(screen.getByRole("button", { name: "Retry Claude" }))
      expect(screen.getByLabelText("Refreshing…")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Retry Claude" })).not.toBeInTheDocument()
      await act(async () => {
        pending.resolve(null)
      })
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Retry Claude" })).toBeInTheDocument()
      )
      expect(screen.queryByLabelText("Refreshing…")).not.toBeInTheDocument()
    })

    it("says the refresh failed when send resolves an error key", async () => {
      const { user } = setup([errored()], { send: async () => "errors.quotaRefresh" })
      await user.click(screen.getByRole("button", { name: "Retry Claude" }))
      expect(
        await screen.findByText("Couldn't refresh. Try again in a moment.")
      ).toBeInTheDocument()
    })

    it("clears an earlier failure when the retry is attempted again", async () => {
      const send = jest
        .fn<Promise<string | null>, [GlanceRequestBody]>()
        .mockResolvedValueOnce("errors.quotaRefresh")
        .mockResolvedValueOnce(null)
      const { user } = setup([errored()], { send })
      await user.click(screen.getByRole("button", { name: "Retry Claude" }))
      await screen.findByText("Couldn't refresh. Try again in a moment.")
      await user.click(screen.getByRole("button", { name: "Retry Claude" }))
      await waitFor(() =>
        expect(
          screen.queryByText("Couldn't refresh. Try again in a moment.")
        ).not.toBeInTheDocument()
      )
    })
  })

  describe("disabled state", () => {
    const disabled = () =>
      makeSource({
        key: "codex:acct-9",
        provider: "codex",
        accountId: "acct-9",
        accountLabel: "me@example.com",
        state: "disabled",
        windows: [],
        fetchedAt: null,
      })

    it("offers Turn on and sends quota-enable with the provider and account", async () => {
      const { send, user } = setup([disabled()])
      expect(screen.getByText("me@example.com")).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Turn on quota for Codex" }))
      expect(send).toHaveBeenCalledWith({
        kind: "quota-enable",
        provider: "codex",
        accountId: "acct-9",
      })
    })

    it("shows a spinner while pending, then the button again on success", async () => {
      const pending = deferred<string | null>()
      const { user } = setup([disabled()], { send: () => pending.promise })
      await user.click(screen.getByRole("button", { name: "Turn on quota for Codex" }))
      expect(screen.getByLabelText("Turning on…")).toBeInTheDocument()
      expect(
        screen.queryByRole("button", { name: "Turn on quota for Codex" })
      ).not.toBeInTheDocument()
      await act(async () => {
        pending.resolve(null)
      })
      const again = await screen.findByRole("button", { name: "Turn on quota for Codex" })
      expect(within(again).getByText("Turn on")).toBeInTheDocument()
      expect(screen.queryByLabelText("Turning on…")).not.toBeInTheDocument()
    })

    it("offers Try again after a failure", async () => {
      const { send, user } = setup([disabled()], { send: async () => "errors.quotaEnable" })
      await user.click(screen.getByRole("button", { name: "Turn on quota for Codex" }))
      const retry = await screen.findByRole("button", { name: "Turn on quota for Codex" })
      expect(within(retry).getByText("Try again")).toBeInTheDocument()
      expect(send).toHaveBeenCalledTimes(1)
    })

    it("sends an empty account id when the source has none", async () => {
      const { send, user } = setup([{ ...disabled(), accountId: null }])
      await user.click(screen.getByRole("button", { name: "Turn on quota for Codex" }))
      expect(send).toHaveBeenCalledWith({ kind: "quota-enable", provider: "codex", accountId: "" })
    })
  })

  describe("discovered state", () => {
    it("routes Set up to subscription settings without sending anything", async () => {
      const { route, send, user } = setup([
        makeSource({
          key: "discovered:opencode",
          provider: "opencode",
          accountId: null,
          state: "discovered",
          windows: [],
        }),
      ])
      expect(screen.getByText("Signed in on this machine")).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Set up" }))
      expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "subscription" })
      expect(send).not.toHaveBeenCalled()
    })
  })
})
