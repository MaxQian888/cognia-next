const call = jest.fn(async (..._args: unknown[]): Promise<unknown> => 0)
jest.mock("@/lib/tauri", () => ({ transport: { call: (...args: unknown[]) => call(...args) } }))

import { forgetSshHostKey, parseHostKeyChange, HOST_KEY_CHANGED_CODE } from "./ssh-host-key"

const payload = {
  host: "prod.example.com",
  port: 2222,
  knownFingerprint: "SHA256:old",
  presentedFingerprint: "SHA256:new",
}

function errorFor(body: unknown): string {
  return `${HOST_KEY_CHANGED_CODE}:${JSON.stringify(body)}`
}

beforeEach(() => {
  call.mockClear()
  call.mockResolvedValue(0)
})

describe("parseHostKeyChange", () => {
  it("decodes the native mismatch report", () => {
    expect(parseHostKeyChange(errorFor(payload))).toEqual(payload)
  })

  it("finds the marker inside a wrapped host error", () => {
    // The host wraps the process error, so the code is not at position 0.
    const wrapped = `terminal process error: ${errorFor(payload)}`
    expect(parseHostKeyChange(wrapped)).toEqual(payload)
  })

  it("normalises a missing stored fingerprint to null", () => {
    // A hand-edited known_hosts can leave the "was" half unreadable; the
    // warning still stands on the presented half alone.
    const { knownFingerprint: _omitted, ...rest } = payload
    expect(parseHostKeyChange(errorFor(rest))?.knownFingerprint).toBeNull()
    expect(parseHostKeyChange(errorFor({ ...payload, knownFingerprint: null }))).toEqual({
      ...payload,
      knownFingerprint: null,
    })
  })

  it("returns null for ordinary connection failures", () => {
    expect(parseHostKeyChange("SSH connection failed: timed out")).toBeNull()
    expect(parseHostKeyChange("SSH authentication was rejected by the server")).toBeNull()
  })

  it("returns null rather than half-rendering a malformed payload", () => {
    // Degrading to the generic path beats a security dialog with blank
    // fingerprints, which reads as "nothing changed".
    expect(parseHostKeyChange(`${HOST_KEY_CHANGED_CODE}:not json`)).toBeNull()
    expect(parseHostKeyChange(errorFor({ host: "h", port: 22 }))).toBeNull()
    expect(parseHostKeyChange(errorFor({ ...payload, host: "" }))).toBeNull()
    expect(parseHostKeyChange(errorFor({ ...payload, presentedFingerprint: "" }))).toBeNull()
    expect(parseHostKeyChange(errorFor({ ...payload, port: 22.5 }))).toBeNull()
    expect(parseHostKeyChange(errorFor({ ...payload, knownFingerprint: 7 }))).toBeNull()
    expect(parseHostKeyChange(errorFor(["not", "an", "object"]))).toBeNull()
    expect(parseHostKeyChange(errorFor(null))).toBeNull()
  })

  it("returns null for non-string inputs", () => {
    expect(parseHostKeyChange(new Error("boom"))).toBeNull()
    expect(parseHostKeyChange(undefined)).toBeNull()
    expect(parseHostKeyChange({ code: HOST_KEY_CHANGED_CODE })).toBeNull()
  })
})

describe("forgetSshHostKey", () => {
  it("asks the native side to drop the recorded key", async () => {
    call.mockResolvedValue(1)
    await expect(forgetSshHostKey("prod.example.com", 2222)).resolves.toBe(1)
    expect(call).toHaveBeenCalledWith("ssh_forget_host_key", {
      host: "prod.example.com",
      port: 2222,
    })
  })

  it("reports zero removals without treating it as a failure", async () => {
    await expect(forgetSshHostKey("absent.example.com", 22)).resolves.toBe(0)
  })

  it("propagates a native rejection", async () => {
    call.mockRejectedValueOnce(new Error("known_hosts could not be written"))
    await expect(forgetSshHostKey("prod.example.com", 22)).rejects.toThrow(
      "known_hosts could not be written"
    )
  })
})
