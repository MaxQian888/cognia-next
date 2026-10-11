/**
 * @jest-environment jsdom
 */

import { useEffect } from "react"
import { act, render, renderHook, screen } from "@testing-library/react"

jest.mock("@/hooks/glance/use-mobile-glance", () => ({ useMobileGlance: jest.fn() }))
jest.mock("next/navigation", () => ({ useRouter: jest.fn() }))

import { useRouter } from "next/navigation"
import {
  useMobileGlance,
  type UseMobileGlanceOptions,
  type UseMobileGlanceResult,
} from "@/hooks/glance/use-mobile-glance"
import { DEFAULT_GLANCE_MOBILE_SETTINGS } from "@/lib/glance/mobile-layout"

import {
  MobileGlanceProvider,
  useMobileGlanceContext,
  useRegisterGlanceEditor,
  useRegisterGlanceHome,
  type MobileGlanceContextValue,
  type MobileGlanceShellActions,
} from "./mobile-glance-provider"

const useMobileGlanceMock = useMobileGlance as jest.Mock
const useRouterMock = useRouter as jest.Mock
const push = jest.fn()

const RESULT = {
  settings: DEFAULT_GLANCE_MOBILE_SETTINGS,
  glance: { marker: "glance" },
  originOf: () => null,
  remote: { status: "idle", snapshot: null, receivedAt: null, hostLabel: null },
  paired: false,
  supported: false,
  hostLayout: null,
  save: jest.fn(async () => null),
} as unknown as UseMobileGlanceResult

function makeActions(): MobileGlanceShellActions {
  return { newChat: jest.fn(), search: jest.fn(), openSession: jest.fn(), editLayout: jest.fn() }
}

/** The options of the latest `useMobileGlance` call. */
function lastOptions(): UseMobileGlanceOptions {
  return useMobileGlanceMock.mock.calls.at(-1)?.[0] as UseMobileGlanceOptions
}

const seenRef: { current: MobileGlanceContextValue | null } = { current: null }
function capture(value: MobileGlanceContextValue) {
  seenRef.current = value
}
function Probe() {
  const value = useMobileGlanceContext()
  useEffect(() => capture(value))
  return <div data-testid="probe" />
}

function Home() {
  useRegisterGlanceHome()
  return <div data-testid="home" />
}

function Editor() {
  useRegisterGlanceEditor()
  return <div data-testid="editor" />
}

beforeEach(() => {
  useMobileGlanceMock.mockReset().mockReturnValue(RESULT)
  push.mockReset()
  useRouterMock.mockReset().mockReturnValue({ push })
  seenRef.current = null
})

describe("MobileGlanceProvider", () => {
  it("renders its children with the glance result, the shell's actions and the drawer state", () => {
    const actions = makeActions()
    render(
      <MobileGlanceProvider actions={actions}>
        <Probe />
      </MobileGlanceProvider>
    )
    expect(screen.getByTestId("probe")).toBeInTheDocument()
    const value = seenRef.current as MobileGlanceContextValue
    expect(value.settings).toBe(RESULT.settings)
    expect(value.glance).toBe(RESULT.glance)
    expect(value.save).toBe(RESULT.save)
    expect(value.actions).toBe(actions)
    expect(value.drawerOpen).toBe(false)
    expect(typeof value.registerHome).toBe("function")
  })

  it("opens and closes the drawer, and tells the glance hook", () => {
    render(
      <MobileGlanceProvider actions={makeActions()}>
        <Probe />
      </MobileGlanceProvider>
    )
    expect(lastOptions().drawerOpen).toBe(false)
    act(() => seenRef.current?.setDrawerOpen(true))
    expect(seenRef.current?.drawerOpen).toBe(true)
    expect(lastOptions().drawerOpen).toBe(true)
    act(() => seenRef.current?.setDrawerOpen(false))
    expect(lastOptions().drawerOpen).toBe(false)
  })

  it("marks the home visible while a home is mounted, counting every mount", () => {
    const actions = makeActions()
    const view = render(
      <MobileGlanceProvider actions={actions}>
        <Probe />
      </MobileGlanceProvider>
    )
    expect(lastOptions().homeVisible).toBe(false)

    view.rerender(
      <MobileGlanceProvider actions={actions}>
        <Probe />
        <Home />
        <Home />
      </MobileGlanceProvider>
    )
    expect(lastOptions().homeVisible).toBe(true)

    // One of two homes leaves: still on screen.
    view.rerender(
      <MobileGlanceProvider actions={actions}>
        <Probe />
        <Home />
      </MobileGlanceProvider>
    )
    expect(lastOptions().homeVisible).toBe(true)

    view.rerender(
      <MobileGlanceProvider actions={actions}>
        <Probe />
      </MobileGlanceProvider>
    )
    expect(lastOptions().homeVisible).toBe(false)
  })

  it("tells the glance hook while a layout editor is mounted", () => {
    const actions = makeActions()
    const view = render(
      <MobileGlanceProvider actions={actions}>
        <Probe />
      </MobileGlanceProvider>
    )
    expect(lastOptions().editorOpen).toBe(false)
    view.rerender(
      <MobileGlanceProvider actions={actions}>
        <Probe />
        <Editor />
      </MobileGlanceProvider>
    )
    expect(lastOptions().editorOpen).toBe(true)
    view.rerender(
      <MobileGlanceProvider actions={actions}>
        <Probe />
      </MobileGlanceProvider>
    )
    expect(lastOptions().editorOpen).toBe(false)
  })

  it("lets registerHome be called directly, returning its unregister", () => {
    render(
      <MobileGlanceProvider actions={makeActions()}>
        <Probe />
      </MobileGlanceProvider>
    )
    let unregister: () => void = () => {}
    act(() => {
      unregister = seenRef.current?.registerHome() ?? (() => {})
    })
    expect(lastOptions().homeVisible).toBe(true)
    act(() => unregister())
    expect(lastOptions().homeVisible).toBe(false)
  })

  it("navigates through the router and resumes sessions through the shell", () => {
    const actions = makeActions()
    render(
      <MobileGlanceProvider actions={actions}>
        <Probe />
      </MobileGlanceProvider>
    )
    lastOptions().navigate("/fleet")
    expect(push).toHaveBeenCalledWith("/fleet")
    expect(lastOptions().openSession).toBe(actions.openSession)
  })

  it("closes the drawer and opens the layout editor for editShortcuts", () => {
    const actions = makeActions()
    render(
      <MobileGlanceProvider actions={actions}>
        <Probe />
      </MobileGlanceProvider>
    )
    act(() => seenRef.current?.setDrawerOpen(true))
    act(() => lastOptions().editShortcuts())
    expect(actions.editLayout).toHaveBeenCalledTimes(1)
    expect(seenRef.current?.drawerOpen).toBe(false)
  })

  it("closes the drawer behind a routed click", () => {
    render(
      <MobileGlanceProvider actions={makeActions()}>
        <Probe />
      </MobileGlanceProvider>
    )
    act(() => seenRef.current?.setDrawerOpen(true))
    act(() => lastOptions().onRouted?.())
    expect(seenRef.current?.drawerOpen).toBe(false)
  })
})

describe("useMobileGlanceContext", () => {
  it("throws outside the provider", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(() => renderHook(() => useMobileGlanceContext())).toThrow(
        "useMobileGlanceContext must be used inside MobileGlanceProvider"
      )
    } finally {
      spy.mockRestore()
    }
  })
})
