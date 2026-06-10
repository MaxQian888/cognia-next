/**
 * @jest-environment node
 */
import { renderTui } from "./mount"
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
})
