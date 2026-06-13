/**
 * @jest-environment node
 */
import { renderTui, enableBracketedPaste, disableBracketedPaste } from "./mount"
import { DEFAULT_RESOLVED_CONFIG } from "../config/schema"
import type { ResolvedConfig } from "../config/schema"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

describe("renderTui", () => {
  it("mounts the app via the injected render and resolves on exit", async () => {
    const unmount = jest.fn()
    const waitUntilExit = jest.fn(() => Promise.resolve())
    const render = jest.fn(() => ({
      unmount,
      waitUntilExit,
      rerender: jest.fn(),
      clear: jest.fn(),
      cleanup: jest.fn(),
    })) as never
    const code = await renderTui({ config, render })
    expect(render).toHaveBeenCalledTimes(1)
    expect(waitUntilExit).toHaveBeenCalled()
    expect(code).toBe(0)
  })

  it("passes a provided session id through to the app element", async () => {
    let mountedSessionId: string | undefined
    const render = jest.fn((element: { props: { sessionId: string } }) => {
      mountedSessionId = element.props.sessionId
      return {
        unmount: jest.fn(),
        waitUntilExit: () => Promise.resolve(),
        rerender: jest.fn(),
        clear: jest.fn(),
        cleanup: jest.fn(),
      }
    }) as never
    await renderTui({ config, sessionId: "ses-abc", render })
    expect(mountedSessionId).toBe("ses-abc")
  })

  it("backfills the active model so the banner matches the model the agent runs", async () => {
    // config has no explicit model; the app must mount with the provider's
    // resolved default rather than `undefined` (the first-entry sync fix).
    let mountedModel: string | undefined
    const render = jest.fn((element: { props: { config: ResolvedConfig } }) => {
      mountedModel = element.props.config.model
      return {
        unmount: jest.fn(),
        waitUntilExit: () => Promise.resolve(),
        rerender: jest.fn(),
        clear: jest.fn(),
        cleanup: jest.fn(),
      }
    }) as never
    await renderTui({ config: { ...config, model: undefined }, render })
    expect(mountedModel).toBeTruthy()
  })

  it("preserves the theme when backfilling the active model", async () => {
    let mountedTheme: string | undefined
    const render = jest.fn((element: { props: { config: ResolvedConfig } }) => {
      mountedTheme = element.props.config.theme
      return {
        unmount: jest.fn(),
        waitUntilExit: () => Promise.resolve(),
        rerender: jest.fn(),
        clear: jest.fn(),
        cleanup: jest.fn(),
      }
    }) as never
    await renderTui({ config: { ...config, theme: "dark" }, render })
    expect(mountedTheme).toBe("dark")
  })

  it("enables + disables bracketed paste around the render lifecycle", async () => {
    const writes: string[] = []
    const out = {
      isTTY: true,
      write: (s: string) => writes.push(s),
    } as unknown as NodeJS.WriteStream
    enableBracketedPaste(out)
    disableBracketedPaste(out)
    expect(writes).toEqual(["\x1b[?2004h", "\x1b[?2004l"])
  })

  it("no-ops the bracketed-paste toggles when stdout is not a TTY", () => {
    const writes: string[] = []
    const out = {
      isTTY: false,
      write: (s: string) => writes.push(s),
    } as unknown as NodeJS.WriteStream
    enableBracketedPaste(out)
    disableBracketedPaste(out)
    expect(writes).toEqual([])
  })
})
