/**
 * connectorListen seam — default Tauri delegation, swap, restore, and the
 * structural guarantee that transports actually go through it.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { listen } from "@tauri-apps/api/event"
import { connectorListen, setConnectorListen, type ConnectorListenFn } from "./events"

const mockTauriListen = listen as jest.Mock

beforeEach(() => {
  mockTauriListen.mockReset()
  setConnectorListen(null)
})

afterEach(() => {
  setConnectorListen(null)
})

describe("connectorListen", () => {
  it("delegates to Tauri listen by default", async () => {
    const unlisten = jest.fn()
    mockTauriListen.mockResolvedValue(unlisten)
    const handler = jest.fn()

    const result = await connectorListen("connectors://webhook/tg-1", handler)

    expect(mockTauriListen).toHaveBeenCalledWith("connectors://webhook/tg-1", handler)
    expect(result).toBe(unlisten)
  })

  it("routes through a swapped listener instead of Tauri", async () => {
    const customUnlisten = jest.fn()
    const custom = jest.fn().mockResolvedValue(customUnlisten) as unknown as ConnectorListenFn
    setConnectorListen(custom)
    const handler = jest.fn()

    const result = await connectorListen("connectors://webhook/lark-1", handler)

    expect(custom).toHaveBeenCalledWith("connectors://webhook/lark-1", handler)
    expect(result).toBe(customUnlisten)
    expect(mockTauriListen).not.toHaveBeenCalled()
  })

  it("passing null restores the default Tauri listener", async () => {
    const custom = jest.fn().mockResolvedValue(jest.fn()) as unknown as ConnectorListenFn
    setConnectorListen(custom)
    setConnectorListen(null)
    mockTauriListen.mockResolvedValue(jest.fn())

    await connectorListen("connectors://webhook/slack-1", jest.fn())

    expect(custom).not.toHaveBeenCalled()
    expect(mockTauriListen).toHaveBeenCalledTimes(1)
  })

  it("returns the previously-active listener for teardown restore", async () => {
    const first = jest.fn().mockResolvedValue(jest.fn()) as unknown as ConnectorListenFn
    const second = jest.fn().mockResolvedValue(jest.fn()) as unknown as ConnectorListenFn

    setConnectorListen(first)
    const prev = setConnectorListen(second)
    expect(prev).toBe(first)

    setConnectorListen(prev)
    await connectorListen("connectors://webhook/wc-1", jest.fn())
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it("keeps a stable exported identity across swaps (late-bound dispatch)", async () => {
    const ref = connectorListen
    const custom = jest.fn().mockResolvedValue(jest.fn()) as unknown as ConnectorListenFn
    setConnectorListen(custom)

    await ref("connectors://webhook/tg-2", jest.fn())

    expect(custom).toHaveBeenCalledTimes(1)
  })
})

describe("seam adoption", () => {
  /**
   * A behavioural test cannot catch this. Jest's module mock for
   * `@tauri-apps/api/event` sits UNDER the seam's own default delegation, so a
   * transport that bypasses `connectorListen` and imports Tauri's `listen`
   * directly still passes every mocked test — while throwing on the headless
   * brain, which has no `__TAURI_INTERNALS__`. That is precisely how Discord,
   * OneBot, WeCom, DingTalk and Lark's long connection came to be silently
   * dead on cloud installs. The invariant is structural, so the check is too.
   */
  it("is the only connector module importing Tauri's event API", () => {
    const repoRoot = join(__dirname, "..", "..")
    const tracked = execFileSync("git", ["ls-files", "lib/connectors"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16e6,
    })
      .split("\n")
      .filter((p) => /\.tsx?$/.test(p) && !/\.(test|spec|stories)\.tsx?$/.test(p))

    const offenders = tracked.filter((path) => {
      if (path === "lib/connectors/events.ts") return false
      return /from\s+["']@tauri-apps\/api\/event["']/.test(
        readFileSync(join(repoRoot, path), "utf8")
      )
    })

    expect(offenders).toEqual([])
  })
})
