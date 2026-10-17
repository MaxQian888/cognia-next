import { MAX_LEASE_WAIT_MS, recoverBestOfNAfterRestart } from "./restart-recovery"
import type { BestOfNGroup } from "@/types/best-of-n"

const group = (groupId: string, phase: string, lease = 0, archiveStatus = "pending") =>
  ({ groupId, phase, ownerLeaseExpiresAt: lease, archiveStatus }) as BestOfNGroup

function deps(groups: BestOfNGroup[]) {
  return {
    canManage: jest.fn(() => true),
    list: jest.fn(async () => groups),
    recover: jest.fn(async (id: string) => {
      const found = groups.find((item) => item.groupId === id)!
      return found.phase === "running" ? { ...found, phase: "recoveryRequired" as const } : found
    }),
    release: jest.fn(async () => true),
    project: jest.fn(async () => undefined),
    sleep: jest.fn(async () => undefined),
    now: () => 1_000,
  }
}

it("rebinds unfinished runs without replay and releases a held publishing winner", async () => {
  const d = deps([
    group("run", "running"),
    group("pub", "publishing"),
    group("done", "published"),
    group("stopped", "cancelled"),
    group("cleanup", "cancelled", 0, "archiving"),
  ])
  const report = await recoverBestOfNAfterRestart(d)
  expect(d.recover.mock.calls.map(([id]) => id)).toEqual(["run", "pub", "cleanup"])
  expect(d.release).toHaveBeenCalledTimes(1)
  expect(d.release).toHaveBeenCalledWith("pub")
  expect(report).toEqual({ recovered: ["run", "pub", "cleanup"], released: ["pub"], failed: [] })
  expect(d.project).toHaveBeenCalledWith(expect.objectContaining({ phase: "recoveryRequired" }))
  expect(d.project).toHaveBeenCalledTimes(5)
  expect(d.sleep).not.toHaveBeenCalled()
})

it("waits once for the previous process's lease to lapse, bounded", async () => {
  const d = deps([group("a", "running", 4_000), group("b", "running", 2_000)])
  await recoverBestOfNAfterRestart(d)
  expect(d.sleep).toHaveBeenCalledTimes(1)
  expect(d.sleep).toHaveBeenCalledWith(3_050)
  const far = deps([group("a", "running", 10 * MAX_LEASE_WAIT_MS)])
  await recoverBestOfNAfterRestart(far)
  expect(far.sleep).toHaveBeenCalledWith(MAX_LEASE_WAIT_MS)
})

it("keeps going after one group fails and reports it", async () => {
  const d = deps([group("bad", "running"), group("good", "publishing")])
  d.recover.mockRejectedValueOnce(new Error("best-of-N owner lease is held by another owner"))
  d.release.mockResolvedValueOnce(false)
  const report = await recoverBestOfNAfterRestart(d)
  expect(report.failed).toEqual([
    { groupId: "bad", error: "best-of-N owner lease is held by another owner" },
  ])
  expect(report.recovered).toEqual(["good"])
  expect(report.released).toEqual([])
})

it("does nothing on a paired observer", async () => {
  const d = deps([group("run", "running")])
  d.canManage.mockReturnValue(false)
  expect(await recoverBestOfNAfterRestart(d)).toEqual({ recovered: [], released: [], failed: [] })
  expect(d.list).not.toHaveBeenCalled()
})
