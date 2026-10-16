/**
 * @jest-environment node
 */
import { renderTui, enableBracketedPaste, disableBracketedPaste } from "./mount"
import { DEFAULT_RESOLVED_CONFIG } from "../config/schema"
import type { ResolvedConfig } from "../config/schema"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

describe("renderTui", () => {
  it("enables Ink screen-reader output when requested", async () => {
    const render = jest.fn(() => ({ waitUntilExit: () => Promise.resolve() })) as never
    await renderTui({ config: { ...config, screenReader: true }, render })
    expect(render).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isScreenReaderEnabled: true })
    )
  })
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

  it("waits for the database flush before resolving a clean exit", async () => {
    const order: string[] = []
    const render = jest.fn(() => ({
      unmount: jest.fn(),
      waitUntilExit: async () => {
        order.push("exit")
      },
      rerender: jest.fn(),
      clear: jest.fn(),
      cleanup: jest.fn(),
    })) as never
    const flushDb = jest.fn(async () => {
      await new Promise((r) => setTimeout(r, 5))
      order.push("flushed")
    })
    await renderTui({ config, render, flushDb })
    expect(order).toEqual(["exit", "flushed"])
  })

  it("flushes the database, unmounts and exits 143 on SIGTERM", async () => {
    const listeners = new Map<string, () => void>()
    const exit = jest.fn()
    const signalProcess = {
      on: (event: string, fn: () => void) => listeners.set(event, fn),
      off: (event: string) => listeners.delete(event),
      listenerCount: (event: string) => (listeners.has(event) ? 1 : 0),
      exit,
    }
    let resolveExit: () => void = () => {}
    const unmount = jest.fn(() => resolveExit())
    const render = jest.fn(() => ({
      unmount,
      waitUntilExit: () => new Promise<void>((r) => (resolveExit = r)),
      rerender: jest.fn(),
      clear: jest.fn(),
      cleanup: jest.fn(),
    })) as never
    const flushDb = jest.fn(async () => {})
    const done = renderTui({ config, render, flushDb, signalProcess })
    await Promise.resolve()
    expect([...listeners.keys()].sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"])
    listeners.get("SIGTERM")!()
    await done
    await new Promise((r) => setImmediate(r))
    expect(flushDb).toHaveBeenCalled()
    expect(unmount).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(143)
    // The handlers are removed once the TUI has returned.
    expect(listeners.size).toBe(0)
  })

  it("disables Ink's built-in Ctrl+C exit so the App owns it (input stays alive)", async () => {
    let renderOptions: { exitOnCtrlC?: boolean } | undefined
    const render = jest.fn((_element: unknown, options?: { exitOnCtrlC?: boolean }) => {
      renderOptions = options
      return {
        unmount: jest.fn(),
        waitUntilExit: () => Promise.resolve(),
        rerender: jest.fn(),
        clear: jest.fn(),
        cleanup: jest.fn(),
      }
    }) as never
    await renderTui({ config, render })
    expect(renderOptions?.exitOnCtrlC).toBe(false)
  })

  it("passes a provided session id through to the app element", async () => {
    let mountedSessionId: string | undefined
    // Provider → crash boundary → app.
    const render = jest.fn(
      (element: {
        props: { children: { props: { children: { props: { sessionId: string } } } } }
      }) => {
        mountedSessionId = element.props.children.props.children.props.sessionId
        return {
          unmount: jest.fn(),
          waitUntilExit: () => Promise.resolve(),
          rerender: jest.fn(),
          clear: jest.fn(),
          cleanup: jest.fn(),
        }
      }
    ) as never
    await renderTui({ config, sessionId: "ses-abc", render })
    expect(mountedSessionId).toBe("ses-abc")
  })

  it("threads launch-only options through to the app element", async () => {
    let mounted:
      | { initialCommand?: string; sessionOnlyPermissionMode?: ResolvedConfig["permissionMode"] }
      | undefined
    const render = jest.fn(
      (element: {
        props: {
          children: {
            props: {
              children: {
                props: {
                  initialCommand?: string
                  sessionOnlyPermissionMode?: ResolvedConfig["permissionMode"]
                }
              }
            }
          }
        }
      }) => {
        mounted = element.props.children.props.children.props
        return {
          unmount: jest.fn(),
          waitUntilExit: () => Promise.resolve(),
          rerender: jest.fn(),
          clear: jest.fn(),
          cleanup: jest.fn(),
        }
      }
    ) as never
    await renderTui({
      config,
      initialCommand: "/continue",
      sessionOnlyPermissionMode: "bypassPermissions",
      render,
    })
    expect(mounted).toMatchObject({
      initialCommand: "/continue",
      sessionOnlyPermissionMode: "bypassPermissions",
    })
  })

  it("backfills the active model so the banner matches the model the agent runs", async () => {
    // config has no explicit model; the app must mount with the provider's
    // resolved default rather than `undefined` (the first-entry sync fix).
    let mountedModel: string | undefined
    const render = jest.fn(
      (element: {
        props: { children: { props: { children: { props: { config: ResolvedConfig } } } } }
      }) => {
        mountedModel = element.props.children.props.children.props.config.model
        return {
          unmount: jest.fn(),
          waitUntilExit: () => Promise.resolve(),
          rerender: jest.fn(),
          clear: jest.fn(),
          cleanup: jest.fn(),
        }
      }
    ) as never
    await renderTui({ config: { ...config, model: undefined }, render })
    expect(mountedModel).toBeTruthy()
  })

  it("preserves the theme when backfilling the active model", async () => {
    let mountedTheme: string | undefined
    const render = jest.fn(
      (element: {
        props: { children: { props: { children: { props: { config: ResolvedConfig } } } } }
      }) => {
        mountedTheme = element.props.children.props.children.props.config.theme
        return {
          unmount: jest.fn(),
          waitUntilExit: () => Promise.resolve(),
          rerender: jest.fn(),
          clear: jest.fn(),
          cleanup: jest.fn(),
        }
      }
    ) as never
    await renderTui({ config: { ...config, theme: "dark" }, render })
    expect(mountedTheme).toBe("dark")
  })

  it("forwards the alt-screen pre-enter flag so the app skips the redundant clear", async () => {
    // In the jest node env stdout isn't a TTY, so the layout degrades to
    // scrollback and mount.tsx never enters the alt screen — the flag is `false`.
    // The wiring must still be present (boolean, not undefined) so the production
    // fullscreen path passes `true` and the App's effect skips its blank-screen
    // re-clear after Ink's first paint.
    let preEntered: unknown
    const render = jest.fn(
      (element: {
        props: {
          children: { props: { children: { props: { altScreenPreEntered?: boolean } } } }
        }
      }) => {
        preEntered = element.props.children.props.children.props.altScreenPreEntered
        return {
          unmount: jest.fn(),
          waitUntilExit: () => Promise.resolve(),
          rerender: jest.fn(),
          clear: jest.fn(),
          cleanup: jest.fn(),
        }
      }
    ) as never
    await renderTui({ config, render })
    expect(typeof preEntered).toBe("boolean")
  })

  it("injects the real clipboard-image probe for the composer hint", async () => {
    // Only production mounting wires the probe — App tests that render the
    // component directly leave it undefined and never spawn clipboard helpers.
    let probe: unknown
    const render = jest.fn(
      (element: {
        props: {
          children: { props: { children: { props: { probeClipboardImage?: unknown } } } }
        }
      }) => {
        probe = element.props.children.props.children.props.probeClipboardImage
        return {
          unmount: jest.fn(),
          waitUntilExit: () => Promise.resolve(),
          rerender: jest.fn(),
          clear: jest.fn(),
          cleanup: jest.fn(),
        }
      }
    ) as never
    await renderTui({ config, render })
    expect(typeof probe).toBe("function")
  })

  it("wraps the app in a crash boundary with a render-crash logger", async () => {
    let onCrash: unknown
    const render = jest.fn((element: { props: { children: { props: { onCrash?: unknown } } } }) => {
      onCrash = element.props.children.props.onCrash
      return {
        unmount: jest.fn(),
        waitUntilExit: () => Promise.resolve(),
        rerender: jest.fn(),
        clear: jest.fn(),
        cleanup: jest.fn(),
      }
    }) as never
    await renderTui({ config, render })
    expect(typeof onCrash).toBe("function")
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
