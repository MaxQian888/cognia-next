import { E2BSandboxPool } from "./sandbox-pool"
import {
  clearE2BPanelRuntime,
  getE2BPanelRuntimeVersion,
  notifyE2BPanelRuntime,
  peekE2BPanelRuntime,
  setE2BPanelRuntime,
  subscribeE2BPanelRuntime,
  type E2BConnectionStatus,
} from "./panel-runtime"

const status: E2BConnectionStatus = { endpoint: "", kind: "cloud", apiKey: "missing" }

function runtime() {
  return {
    pool: new E2BSandboxPool(),
    ui: { showToast: jest.fn() },
    provisioningAvailable: false,
    getConnectionStatus: () => status,
  }
}

describe("panel runtime bridge", () => {
  afterEach(() => clearE2BPanelRuntime())

  it("hands the panel what activate parked, and nothing after deactivate", () => {
    expect(peekE2BPanelRuntime()).toBeNull()
    const rt = runtime()
    setE2BPanelRuntime(rt)
    expect(peekE2BPanelRuntime()).toBe(rt)
    clearE2BPanelRuntime()
    expect(peekE2BPanelRuntime()).toBeNull()
  })

  it("notifies subscribers on set, clear, and manual notify — with a monotonic version", () => {
    const calls: number[] = []
    const unsubscribe = subscribeE2BPanelRuntime(() => calls.push(getE2BPanelRuntimeVersion()))
    const before = getE2BPanelRuntimeVersion()
    setE2BPanelRuntime(runtime())
    notifyE2BPanelRuntime()
    clearE2BPanelRuntime()

    expect(calls).toHaveLength(3)
    expect(calls[0]).toBe(before + 1)
    expect(calls).toEqual([...calls].sort((a, b) => a - b))

    unsubscribe()
    setE2BPanelRuntime(runtime())
    expect(calls).toHaveLength(3)
  })

  it("a throwing listener never breaks a lifecycle transition", () => {
    subscribeE2BPanelRuntime(() => {
      throw new Error("panel exploded")
    })
    expect(() => setE2BPanelRuntime(runtime())).not.toThrow()
    expect(peekE2BPanelRuntime()).not.toBeNull()
  })
})
