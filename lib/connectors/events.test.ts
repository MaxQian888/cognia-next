/**
 * connectorListen seam — default Tauri delegation, swap, restore.
 */

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
