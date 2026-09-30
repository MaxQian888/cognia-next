import { ensureMicrophonePermission, type MicrophoneLoader } from "./microphone"

function loader(has: boolean, requested = false) {
  const request = jest.fn(async () => ({ value: requested }))
  const load: MicrophoneLoader = async () => ({
    hasAudioRecordingPermission: async () => ({ value: has }),
    requestAudioRecordingPermission: request,
  })
  return { load, request }
}

describe("ensureMicrophonePermission", () => {
  it("resolves granted without prompting when already allowed", async () => {
    const { load, request } = loader(true)
    await expect(ensureMicrophonePermission(load)).resolves.toEqual({
      kind: "ok",
      value: "granted",
    })
    expect(request).not.toHaveBeenCalled()
  })

  it("prompts and reports the user's answer", async () => {
    const granted = loader(false, true)
    await expect(ensureMicrophonePermission(granted.load)).resolves.toEqual({
      kind: "ok",
      value: "granted",
    })
    expect(granted.request).toHaveBeenCalledTimes(1)

    const denied = loader(false, false)
    await expect(ensureMicrophonePermission(denied.load)).resolves.toEqual({
      kind: "ok",
      value: "denied",
    })
  })

  it("is unsupported off the native shell and surfaces plugin errors", async () => {
    await expect(
      ensureMicrophonePermission(async () => {
        throw new Error("not on web")
      })
    ).resolves.toEqual({ kind: "unsupported" })

    await expect(
      ensureMicrophonePermission(async () => ({
        hasAudioRecordingPermission: async () => {
          throw new Error("bridge down")
        },
        requestAudioRecordingPermission: async () => ({ value: false }),
      }))
    ).resolves.toEqual({ kind: "error", message: "bridge down" })
  })
})
