import { HOST_FALLBACK_RUNTIME_REF, MicrovmAdapterError, SandboxRuntimeError } from "./sandbox"

describe("sandbox API runtime contracts", () => {
  it("keeps the host fallback sentinel stable for explicitly sessionless calls", () => {
    expect(HOST_FALLBACK_RUNTIME_REF).toBe("sandbox-runtime:host-default")
  })

  it("preserves typed adapter and runtime error codes", () => {
    const cause = new Error("provider refused")
    const adapterError = new MicrovmAdapterError("workspace-unavailable", "no workspace", {
      cause,
    })
    const runtimeError = new SandboxRuntimeError("placement-unavailable", "not placed", { cause })

    expect(adapterError).toMatchObject({
      name: "MicrovmAdapterError",
      code: "workspace-unavailable",
      cause,
    })
    expect(runtimeError).toMatchObject({
      name: "SandboxRuntimeError",
      code: "placement-unavailable",
      cause,
    })
  })
})
