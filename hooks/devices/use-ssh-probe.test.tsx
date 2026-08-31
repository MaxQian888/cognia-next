/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import {
  getSshProbes,
  readSshProbe,
  resetSshProbesForTests,
  sshProbeTarget,
} from "@/lib/devices/ssh-probe-store"
import type { SshProbeOutcome } from "@/lib/terminal/ssh-probe"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"

import { useSshProbe } from "./use-ssh-probe"

const TARGET: SshHostProfile = {
  id: "s1",
  name: "prod-web-01",
  host: "10.0.4.21",
  port: 22,
  username: "deploy",
  authMethod: "agent",
}
const OTHER: SshHostProfile = { ...TARGET, id: "s2", name: "staging", host: "10.0.4.22" }

const NOW = 5_000

function reachable(fingerprint = "SHA256:a"): SshProbeOutcome {
  return { kind: "reachable", hostKeyStatus: "verified", hostKeyFingerprint: fingerprint }
}

beforeEach(() => {
  resetSshProbesForTests()
})

it("starts idle and never probes on its own", () => {
  const run = jest.fn()
  renderHook(() => useSshProbe(TARGET, [TARGET], { run, now: () => NOW }))
  expect(run).not.toHaveBeenCalled()
})

it("records a reachable answer for the row and its fingerprint", async () => {
  const run = jest.fn().mockResolvedValue(reachable())
  const { result } = renderHook(() => useSshProbe(TARGET, [TARGET], { run, now: () => NOW }))
  act(() => result.current.probe())
  await waitFor(() => expect(result.current.state.status).toBe("settled"))
  expect(readSshProbe("s1", sshProbeTarget(TARGET), NOW)).toMatchObject({
    online: true,
    at: NOW,
    fingerprint: "SHA256:a",
  })
})

it("records a refusal, because being told no is an answer", async () => {
  const run = jest.fn().mockResolvedValue({ kind: "unreachable", message: "refused" })
  const { result } = renderHook(() => useSshProbe(TARGET, [TARGET], { run, now: () => NOW }))
  act(() => result.current.probe())
  await waitFor(() => expect(result.current.state.status).toBe("settled"))
  expect(readSshProbe("s1", sshProbeTarget(TARGET), NOW)).toMatchObject({
    online: false,
    fingerprint: undefined,
  })
})

/**
 * An unbuildable profile says nothing about the machine, which may be entirely
 * healthy. Recording it would put a red dot on a host that was never asked.
 */
it("records nothing when the profile could not produce a request", async () => {
  const run = jest.fn().mockResolvedValue({ kind: "invalid", reason: "jumpChain" })
  const { result } = renderHook(() => useSshProbe(TARGET, [TARGET], { run, now: () => NOW }))
  act(() => result.current.probe())
  await waitFor(() => expect(result.current.state.status).toBe("settled"))
  expect(getSshProbes().size).toBe(0)
})

it("carries the whole saved set, so a bastion-backed host is not probed direct", async () => {
  const run = jest.fn().mockResolvedValue(reachable())
  const { result } = renderHook(() => useSshProbe(TARGET, [OTHER, TARGET], { run, now: () => NOW }))
  act(() => result.current.probe())
  await waitFor(() => expect(run).toHaveBeenCalled())
  expect(run).toHaveBeenCalledWith({ profile: TARGET, allProfiles: [OTHER, TARGET] })
})

it("resets to idle when the selection moves to another host", () => {
  const run = jest.fn().mockResolvedValue(reachable())
  const { result, rerender } = renderHook(
    ({ profile }) => useSshProbe(profile, [TARGET, OTHER], { run, now: () => NOW }),
    { initialProps: { profile: TARGET as SshHostProfile | null } }
  )
  act(() => result.current.probe())
  rerender({ profile: OTHER })
  expect(result.current.state).toEqual({ status: "idle" })
})

/**
 * Probing A, switching to B and probing again must not land A's verdict under
 * B's name when A answers second.
 */
it("drops a verdict that arrives after the selection moved on", async () => {
  let settleFirst: ((outcome: SshProbeOutcome) => void) | undefined
  const run = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<SshProbeOutcome>((resolve) => {
          settleFirst = resolve
        })
    )
    .mockResolvedValue({ kind: "unreachable", message: "refused" })

  const { result, rerender } = renderHook(
    ({ profile }) => useSshProbe(profile, [TARGET, OTHER], { run, now: () => NOW }),
    { initialProps: { profile: TARGET as SshHostProfile | null } }
  )
  act(() => result.current.probe())
  rerender({ profile: OTHER })
  act(() => result.current.probe())
  await waitFor(() => expect(result.current.state.status).toBe("settled"))

  await act(async () => {
    settleFirst?.(reachable())
  })
  expect(result.current.state).toMatchObject({
    status: "settled",
    outcome: { kind: "unreachable" },
  })
})

it("does nothing at all for a row with no saved profile", () => {
  const run = jest.fn()
  const { result } = renderHook(() => useSshProbe(null, [], { run, now: () => NOW }))
  act(() => result.current.probe())
  expect(run).not.toHaveBeenCalled()
  expect(result.current.state).toEqual({ status: "idle" })
})
