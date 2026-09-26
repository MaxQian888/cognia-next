/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"
import type { LucideIcon } from "lucide-react"

import { useShellNavShortcuts } from "./use-shell-nav-shortcuts"
import { __resetAppRuntimeForTesting, getAppRegistration } from "@/lib/shortcuts/app-runtime"
import { PINNED_NAV_SHORTCUT_IDS } from "@/lib/shortcuts/app-catalog"
import type { SidebarCatalogItem } from "@/lib/shell/sidebar-nav"

const Icon = (() => null) as unknown as LucideIcon
const item = (id: string): SidebarCatalogItem => ({
  id,
  route: `/${id}`,
  i18nKey: id,
  group: "feature",
  category: "agents",
  Icon,
})

beforeEach(() => __resetAppRuntimeForTesting())

const press = (id: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { cancelable: true, ...init })
  act(() => getAppRegistration(id)!.handler(event))
  return event
}

describe("useShellNavShortcuts", () => {
  it("registers all nine slots and Settings while enabled", () => {
    renderHook(() =>
      useShellNavShortcuts({
        enabled: true,
        pinned: [item("inbox")],
        goToFeature: jest.fn(),
        openSettings: jest.fn(),
      })
    )
    for (const id of PINNED_NAV_SHORTCUT_IDS) expect(getAppRegistration(id)).toBeDefined()
    expect(getAppRegistration("shell.settings.open")).toMatchObject({
      when: "!platform.tauri",
      allowInEditable: true,
      preventDefault: true,
    })
  })

  it("opens the pinned item in the pressed slot, following later reorders", () => {
    const goToFeature = jest.fn()
    const { rerender } = renderHook(
      ({ pinned }) =>
        useShellNavShortcuts({ enabled: true, pinned, goToFeature, openSettings: jest.fn() }),
      { initialProps: { pinned: [item("inbox"), item("issues")] } }
    )
    const event = press(PINNED_NAV_SHORTCUT_IDS[1], { altKey: true })
    expect(goToFeature).toHaveBeenLastCalledWith("/issues")
    expect(event.defaultPrevented).toBe(true)

    rerender({ pinned: [item("issues"), item("inbox")] })
    press(PINNED_NAV_SHORTCUT_IDS[1], { altKey: true })
    expect(goToFeature).toHaveBeenLastCalledWith("/inbox")
  })

  it("leaves an empty slot inert and the keystroke untouched", () => {
    const goToFeature = jest.fn()
    renderHook(() =>
      useShellNavShortcuts({
        enabled: true,
        pinned: [item("inbox")],
        goToFeature,
        openSettings: jest.fn(),
      })
    )
    const event = press(PINNED_NAV_SHORTCUT_IDS[4], { altKey: true })
    expect(goToFeature).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it("opens Settings", () => {
    const openSettings = jest.fn()
    renderHook(() =>
      useShellNavShortcuts({ enabled: true, pinned: [], goToFeature: jest.fn(), openSettings })
    )
    press("shell.settings.open", { ctrlKey: true, key: "," })
    expect(openSettings).toHaveBeenCalledTimes(1)
  })

  it("registers nothing while disabled, and cleans up on unmount", () => {
    const { rerender, unmount } = renderHook(
      ({ enabled }) =>
        useShellNavShortcuts({
          enabled,
          pinned: [],
          goToFeature: jest.fn(),
          openSettings: jest.fn(),
        }),
      { initialProps: { enabled: false } }
    )
    expect(getAppRegistration(PINNED_NAV_SHORTCUT_IDS[0])).toBeUndefined()
    expect(getAppRegistration("shell.settings.open")).toBeUndefined()
    rerender({ enabled: true })
    expect(getAppRegistration(PINNED_NAV_SHORTCUT_IDS[0])).toBeDefined()
    unmount()
    expect(getAppRegistration(PINNED_NAV_SHORTCUT_IDS[0])).toBeUndefined()
    expect(getAppRegistration("shell.settings.open")).toBeUndefined()
  })
})
