/** @jest-environment jsdom */
import {
  AUTOSTART_CHANGED_EVENT,
  broadcastAutostartChanged,
  onAutostartChanged,
  toggleTrayAutostart,
} from "./autostart-control"

const isEnabled = jest.fn<Promise<boolean>, []>()
const setAuto = jest.fn<Promise<void>, [boolean]>()

jest.mock("@/lib/tauri/autostart", () => ({
  isAutostartEnabled: () => isEnabled(),
  setAutostart: (on: boolean) => setAuto(on),
}))

beforeEach(() => {
  isEnabled.mockReset()
  setAuto.mockReset().mockResolvedValue(undefined)
})

describe("toggleTrayAutostart", () => {
  it("flips off→on and returns the value read back", async () => {
    isEnabled.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const result = await toggleTrayAutostart()
    expect(setAuto).toHaveBeenCalledWith(true)
    expect(result).toBe(true)
  })

  it("flips on→off", async () => {
    isEnabled.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const result = await toggleTrayAutostart()
    expect(setAuto).toHaveBeenCalledWith(false)
    expect(result).toBe(false)
  })

  it("broadcasts the new state to subscribers", async () => {
    isEnabled.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const seen: boolean[] = []
    const off = onAutostartChanged((on) => seen.push(on))
    await toggleTrayAutostart()
    off()
    expect(seen).toEqual([true])
  })
})

describe("onAutostartChanged", () => {
  it("stops firing after unsubscribe", () => {
    const seen: boolean[] = []
    const off = onAutostartChanged((on) => seen.push(on))
    broadcastAutostartChanged(true)
    off()
    broadcastAutostartChanged(false)
    expect(seen).toEqual([true])
  })

  it("uses the documented event name", () => {
    const handler = jest.fn()
    window.addEventListener(AUTOSTART_CHANGED_EVENT, handler)
    broadcastAutostartChanged(false)
    window.removeEventListener(AUTOSTART_CHANGED_EVENT, handler)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

// DOM-less (SSR) guards live in `autostart-control.ssr.test.ts` — jsdom's
// `window` is non-configurable from Node 26 on and cannot be deleted.
