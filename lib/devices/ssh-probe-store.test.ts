import {
  forgetSshProbe,
  getSshProbes,
  getSshProbesServerSnapshot,
  readSshProbe,
  recordSshProbe,
  resetSshProbesForTests,
  SSH_PROBE_TTL_MS,
  sshProbeTarget,
  subscribeSshProbes,
} from "./ssh-probe-store"

const PROFILE = { host: "10.0.4.21", port: 22, username: "deploy" }
const TARGET = sshProbeTarget(PROFILE)

beforeEach(() => {
  resetSshProbesForTests()
})

describe("ssh probe store", () => {
  it("answers with the record it was given", () => {
    recordSshProbe("s1", { online: true, at: 1_000, fingerprint: "SHA256:a", target: TARGET })
    expect(readSshProbe("s1", TARGET, 1_500)).toMatchObject({ online: true, at: 1_000 })
  })

  /**
   * A refusal is a real answer. Collapsing it into "no record" would put the
   * row back on `unknown`, which reads as "never asked" and hides the fact that
   * the machine was asked and said no.
   */
  it("keeps an unreachable answer rather than treating it as no answer", () => {
    recordSshProbe("s1", { online: false, at: 1_000, target: TARGET })
    expect(readSshProbe("s1", TARGET, 1_500)?.online).toBe(false)
  })

  it("stops answering once the result is older than the TTL", () => {
    recordSshProbe("s1", { online: true, at: 1_000, target: TARGET })
    expect(readSshProbe("s1", TARGET, 1_000 + SSH_PROBE_TTL_MS - 1)).toBeDefined()
    expect(readSshProbe("s1", TARGET, 1_000 + SSH_PROBE_TTL_MS)).toBeUndefined()
  })

  /**
   * A probe answers about an address, not about a name. Editing the port in
   * Settings makes the previous answer a statement about a machine the row no
   * longer points at.
   */
  it("drops an answer recorded against a different address", () => {
    recordSshProbe("s1", { online: true, at: 1_000, target: TARGET })
    const moved = sshProbeTarget({ ...PROFILE, port: 2222 })
    expect(readSshProbe("s1", moved, 1_500)).toBeUndefined()
  })

  /** Direct and through-a-bastion are different claims, so they are different targets. */
  it("treats a change of jump host as a change of target", () => {
    const direct = sshProbeTarget(PROFILE)
    const viaBastion = sshProbeTarget({ ...PROFILE, jumpHostId: "s0" })
    expect(direct).not.toBe(viaBastion)
  })

  it("notifies subscribers on a write and stops after unsubscribe", () => {
    const listener = jest.fn()
    const off = subscribeSshProbes(listener)
    recordSshProbe("s1", { online: true, at: 1, target: TARGET })
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    recordSshProbe("s2", { online: true, at: 2, target: TARGET })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  /** `useSyncExternalStore` re-reads on every render and loops on a fresh identity. */
  it("keeps a stable snapshot identity between writes", () => {
    const first = getSshProbes()
    expect(getSshProbes()).toBe(first)
    recordSshProbe("s1", { online: true, at: 1, target: TARGET })
    const second = getSshProbes()
    expect(second).not.toBe(first)
    expect(getSshProbes()).toBe(second)
  })

  it("forgets one host without disturbing the others", () => {
    recordSshProbe("s1", { online: true, at: 1, target: TARGET })
    recordSshProbe("s2", { online: true, at: 1, target: TARGET })
    forgetSshProbe("s1")
    expect(readSshProbe("s1", TARGET, 2)).toBeUndefined()
    expect(readSshProbe("s2", TARGET, 2)).toBeDefined()
  })

  it("does not notify when forgetting a host it never held", () => {
    const listener = jest.fn()
    subscribeSshProbes(listener)
    forgetSshProbe("nobody")
    expect(listener).not.toHaveBeenCalled()
  })

  /** A prerender that observed a client-side probe would hydrate into a mismatch. */
  it("hands the server an empty snapshot regardless of what was recorded", () => {
    recordSshProbe("s1", { online: true, at: 1, target: TARGET })
    expect(getSshProbesServerSnapshot().size).toBe(0)
  })
})
