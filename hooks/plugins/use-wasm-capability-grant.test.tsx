import { render, renderHook, act } from "@testing-library/react"
import { useState, useEffect } from "react"
import { useWasmCapabilityGrant } from "./use-wasm-capability-grant"
import type { PluginManifest } from "@/types/plugin"

jest.mock("./wasm-capability-grant-sheet", () => {
  // Capture the props passed to the sheet so tests can drive confirm /
  // cancel / openChange callbacks.
  const calls: Array<Record<string, unknown>> = []
  return {
    __sheetCalls: calls,
    WasmCapabilityGrantSheet: (props: Record<string, unknown>) => {
      calls.push(props)
      return null
    },
  }
})

jest.mock("@/lib/plugin/security/wasm-grant", () => ({
  applyWasmCapabilityGrant: jest.fn((decision: { grantedPermissions: string[] }) => ({
    permissions: decision.grantedPermissions,
    preopens: ["/tmp/x"],
  })),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sheetModule = require("./wasm-capability-grant-sheet") as {
  __sheetCalls: Array<{
    onConfirm?: (decision: unknown) => void
    onCancel?: () => void
    onOpenChange?: (next: boolean) => void
    open?: boolean
  }>
}

function makeWasmManifest(): PluginManifest {
  return {
    id: "w1",
    name: "Wasm One",
    version: "1.0.0",
    type: "wasm",
    permissions: ["network:fetch"],
  } as unknown as PluginManifest
}

function makeNonWasmManifest(): PluginManifest {
  return {
    id: "f1",
    name: "Frontend",
    version: "1.0.0",
    type: "frontend",
    main: "index.js",
    permissions: [],
  } as unknown as PluginManifest
}

beforeEach(() => {
  sheetModule.__sheetCalls.length = 0
})

/**
 * Render the hook AND its `sheet` JSX inside one tree so the mocked
 * `WasmCapabilityGrantSheet` actually mounts and captures its props.
 * Returns a ref-like object the test can drive.
 */
function renderHostedHook(): {
  trigger: (m: PluginManifest) => Promise<unknown>
} {
  const ref: { trigger: (m: PluginManifest) => Promise<unknown> } = {
    trigger: () => Promise.reject(new Error("hook not ready")),
  }
  function Host(): React.ReactElement {
    const hook = useWasmCapabilityGrant()
    const [_, force] = useState(0)
    useEffect(() => {
      ref.trigger = (m) => {
        const p = hook.requestGrant({ manifest: m })
        force((x) => x + 1)
        return p
      }
    }, [hook])
    return <>{hook.sheet}</>
  }
  render(<Host />)
  return ref
}

describe("useWasmCapabilityGrant", () => {
  it("rejects with a clear error when called with a non-wasm manifest", async () => {
    const { result } = renderHook(() => useWasmCapabilityGrant())
    await expect(result.current.requestGrant({ manifest: makeNonWasmManifest() })).rejects.toThrow(
      /manifest\.type must be "wasm"/
    )
  })

  it("returns a `sheet` of null until requestGrant has been called", () => {
    const { result } = renderHook(() => useWasmCapabilityGrant())
    expect(result.current.sheet).toBeNull()
  })

  it("resolves with the decision + persisted preopens when the user confirms", async () => {
    const host = renderHostedHook()
    let promise!: Promise<unknown>
    await act(async () => {
      promise = host.trigger(makeWasmManifest())
    })
    expect(sheetModule.__sheetCalls.length).toBeGreaterThan(0)
    const props = sheetModule.__sheetCalls[sheetModule.__sheetCalls.length - 1]
    expect(props.open).toBe(true)

    await act(async () => {
      props.onConfirm?.({
        grantedPermissions: ["network:fetch"],
        grantedPreopens: [],
      })
    })

    await expect(promise).resolves.toEqual(
      expect.objectContaining({
        preopens: ["/tmp/x"],
        decision: expect.objectContaining({
          grantedPermissions: ["network:fetch"],
          grantedPreopens: ["/tmp/x"],
        }),
      })
    )
  })

  it("resolves with null when the user cancels", async () => {
    const host = renderHostedHook()
    let promise!: Promise<unknown>
    await act(async () => {
      promise = host.trigger(makeWasmManifest())
    })
    const props = sheetModule.__sheetCalls[sheetModule.__sheetCalls.length - 1]
    await act(async () => {
      props.onCancel?.()
    })
    await expect(promise).resolves.toBeNull()
  })

  it("resolves with null when the dialog is dismissed (ESC / overlay click)", async () => {
    const host = renderHostedHook()
    let promise!: Promise<unknown>
    await act(async () => {
      promise = host.trigger(makeWasmManifest())
    })
    const props = sheetModule.__sheetCalls[sheetModule.__sheetCalls.length - 1]
    await act(async () => {
      props.onOpenChange?.(false)
    })
    await expect(promise).resolves.toBeNull()
  })
})
