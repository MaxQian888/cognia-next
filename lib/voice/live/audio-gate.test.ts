import { createLiveVoiceAudioGate, type LiveVoiceAudioGateDeps } from "./audio-gate"

function makeDeps(overrides: Partial<LiveVoiceAudioGateDeps> = {}) {
  const deps = {
    setMicrophoneEnabled: jest.fn(),
    cancelResponse: jest.fn(),
    interruptPlayback: jest.fn(),
    isUserMuted: jest.fn(() => false),
    ...overrides,
  }
  return deps
}

describe("LiveVoiceAudioGate", () => {
  it("starts open", () => {
    const gate = createLiveVoiceAudioGate(makeDeps())
    expect(gate.suspended).toBe(false)
    expect(gate.holds).toBe(0)
  })

  it("stops the model before muting on the first hold", () => {
    // Muting while the model is mid-sentence leaves it talking over the modal.
    const order: string[] = []
    const gate = createLiveVoiceAudioGate(
      makeDeps({
        cancelResponse: jest.fn(() => void order.push("cancel")),
        interruptPlayback: jest.fn(() => void order.push("interrupt")),
        setMicrophoneEnabled: jest.fn(() => void order.push("mic")),
      })
    )

    gate.suspend()

    expect(order).toEqual(["cancel", "interrupt", "mic"])
  })

  it("mutes the microphone rather than stopping the track", () => {
    const deps = makeDeps()
    createLiveVoiceAudioGate(deps).suspend()
    expect(deps.setMicrophoneEnabled).toHaveBeenCalledWith(false)
  })

  it("does not re-cancel for a second concurrent hold", () => {
    // One response can emit several function calls; only the first suspends.
    const deps = makeDeps()
    const gate = createLiveVoiceAudioGate(deps)

    gate.suspend()
    gate.suspend()

    expect(deps.cancelResponse).toHaveBeenCalledTimes(1)
    expect(deps.setMicrophoneEnabled).toHaveBeenCalledTimes(1)
    expect(gate.holds).toBe(2)
  })

  it("keeps audio suspended until the last hold is released", () => {
    const deps = makeDeps()
    const gate = createLiveVoiceAudioGate(deps)
    const releaseA = gate.suspend()
    const releaseB = gate.suspend()

    releaseA()

    // The user is still answering the second dialog — unmuting here would
    // record their answer into the conversation.
    expect(gate.suspended).toBe(true)
    expect(deps.setMicrophoneEnabled).toHaveBeenCalledTimes(1)

    releaseB()

    expect(gate.suspended).toBe(false)
    expect(deps.setMicrophoneEnabled).toHaveBeenLastCalledWith(true)
  })

  it("leaves the user muted if that is what they chose", () => {
    const deps = makeDeps({ isUserMuted: jest.fn(() => true) })
    const gate = createLiveVoiceAudioGate(deps)

    gate.suspend()()

    expect(deps.setMicrophoneEnabled).toHaveBeenLastCalledWith(false)
  })

  it("ignores a double release", () => {
    // Under-counting would unmute while another tool still holds the gate.
    const deps = makeDeps()
    const gate = createLiveVoiceAudioGate(deps)
    const release = gate.suspend()
    gate.suspend()

    release()
    release()

    expect(gate.holds).toBe(1)
    expect(deps.setMicrophoneEnabled).toHaveBeenCalledTimes(1)
  })

  it("ignores a release belonging to a session that already ended", () => {
    // The user can end a session and immediately start another; a late release
    // from the old one must not unmute the new one.
    const deps = makeDeps()
    const gate = createLiveVoiceAudioGate(deps)
    const staleRelease = gate.suspend()

    gate.reset()
    const freshRelease = gate.suspend()
    staleRelease()

    expect(gate.holds).toBe(1)

    freshRelease()
    expect(gate.holds).toBe(0)
  })

  it("does not touch audio when reset, because the session is being torn down", () => {
    const deps = makeDeps()
    const gate = createLiveVoiceAudioGate(deps)
    gate.suspend()
    jest.mocked(deps.setMicrophoneEnabled).mockClear()

    gate.reset()

    expect(deps.setMicrophoneEnabled).not.toHaveBeenCalled()
    expect(gate.holds).toBe(0)
  })

  it("suspends again cleanly after a full release cycle", () => {
    const deps = makeDeps()
    const gate = createLiveVoiceAudioGate(deps)

    gate.suspend()()
    gate.suspend()

    expect(deps.cancelResponse).toHaveBeenCalledTimes(2)
  })
})
