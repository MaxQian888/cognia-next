/**
 * @jest-environment jsdom
 */
import { useEffect } from "react"
import { render, screen, act } from "@testing-library/react"

import {
  AppearancePreviewDraftProvider,
  createPreviewDraftStore,
  usePreviewDraft,
  usePreviewDraftPublisher,
  type AppearanceDraftSnapshot,
} from "./preview-draft-context"
import type { ResolvedThemeColors } from "@/types/plugin/plugin"

const COLORS = { primary: "#ff0000" } as unknown as ResolvedThemeColors
const OTHER = { primary: "#00ff00" } as unknown as ResolvedThemeColors

function snap(colors: ResolvedThemeColors, isDark = false): AppearanceDraftSnapshot {
  return { colors, isDark }
}

let renderCount = 0

function Reader() {
  const draft = usePreviewDraft()
  // No dep array — runs after every render, so this counts renders without
  // mutating an outer variable during one.
  useEffect(() => {
    renderCount += 1
  })
  return (
    <span data-testid="reader">{draft ? `${draft.colors.primary}/${draft.isDark}` : "none"}</span>
  )
}

function Publisher({ value }: { value: AppearanceDraftSnapshot | null }) {
  const publish = usePreviewDraftPublisher()
  return (
    <button type="button" onClick={() => publish(value)}>
      publish
    </button>
  )
}

beforeEach(() => {
  renderCount = 0
})

describe("createPreviewDraftStore", () => {
  it("starts empty", () => {
    expect(createPreviewDraftStore().getSnapshot()).toBeNull()
  })

  it("returns the snapshot by identity so useSyncExternalStore can cache it", () => {
    const store = createPreviewDraftStore()
    const value = snap(COLORS)
    store.publish(value)
    expect(store.getSnapshot()).toBe(store.getSnapshot())
    expect(store.getSnapshot()).toBe(value)
  })

  it("notifies subscribers on publish and stops after unsubscribe", () => {
    const store = createPreviewDraftStore()
    const listener = jest.fn()
    const unsubscribe = store.subscribe(listener)
    store.publish(snap(COLORS))
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    store.publish(snap(OTHER))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("skips the notification when the same snapshot is republished", () => {
    const store = createPreviewDraftStore()
    const listener = jest.fn()
    store.subscribe(listener)
    const value = snap(COLORS)
    store.publish(value)
    store.publish(value)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("renders nothing on the server", () => {
    const store = createPreviewDraftStore()
    store.publish(snap(COLORS))
    expect(store.getServerSnapshot()).toBeNull()
  })

  it("isolates instances so tests cannot leak into each other", () => {
    const a = createPreviewDraftStore()
    const b = createPreviewDraftStore()
    a.publish(snap(COLORS))
    expect(b.getSnapshot()).toBeNull()
  })
})

describe("preview draft context", () => {
  it("delivers a published draft to the reader", () => {
    const store = createPreviewDraftStore()
    render(
      <AppearancePreviewDraftProvider store={store}>
        <Reader />
        <Publisher value={snap(COLORS, true)} />
      </AppearancePreviewDraftProvider>
    )
    expect(screen.getByTestId("reader")).toHaveTextContent("none")
    act(() => {
      screen.getByRole("button", { name: "publish" }).click()
    })
    expect(screen.getByTestId("reader")).toHaveTextContent("#ff0000/true")
  })

  it("clears the draft when null is published", () => {
    const store = createPreviewDraftStore()
    store.publish(snap(COLORS))
    render(
      <AppearancePreviewDraftProvider store={store}>
        <Reader />
        <Publisher value={null} />
      </AppearancePreviewDraftProvider>
    )
    expect(screen.getByTestId("reader")).toHaveTextContent("#ff0000")
    act(() => {
      screen.getByRole("button", { name: "publish" }).click()
    })
    expect(screen.getByTestId("reader")).toHaveTextContent("none")
  })

  it("does not re-render the reader when an identical snapshot is republished", () => {
    const store = createPreviewDraftStore()
    const value = snap(COLORS)
    render(
      <AppearancePreviewDraftProvider store={store}>
        <Reader />
        <Publisher value={value} />
      </AppearancePreviewDraftProvider>
    )
    act(() => {
      screen.getByRole("button", { name: "publish" }).click()
    })
    const afterFirst = renderCount
    act(() => {
      screen.getByRole("button", { name: "publish" }).click()
    })
    expect(renderCount).toBe(afterFirst)
  })

  // The editor is also rendered standalone (Storybook, its own unit test).
  it("publishes into the void with no provider mounted", () => {
    expect(() =>
      render(
        <>
          <Reader />
          <Publisher value={snap(COLORS)} />
        </>
      )
    ).not.toThrow()
    act(() => {
      screen.getByRole("button", { name: "publish" }).click()
    })
    expect(screen.getByTestId("reader")).toHaveTextContent("none")
  })
})
