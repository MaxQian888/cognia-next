import { isTauri, transport } from "@/lib/tauri"
import {
  createWorkerEnrollment,
  listExecutionWorkers,
  revokeExecutionWorker,
  workerEnrollmentCommand,
} from "./execution-workers"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
  transport: { call: jest.fn() },
}))
jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: () => ({
    baseUrl: "https://brain.test",
    serverFingerprint: "sha256:test",
  }),
}))
const call = transport.call as jest.Mock
const tauri = isTauri as jest.Mock

describe("execution worker management", () => {
  beforeEach(() => {
    call.mockReset()
    tauri.mockReturnValue(true)
  })

  it("builds a copyable pinned enrollment command when a fingerprint is present", () => {
    const command = workerEnrollmentCommand({
      enrollment: "once",
      expiresAtMs: 1,
      baseUrl: "https://brain.example",
      fingerprint: "sha256:certificate",
      tenantId: "tenant-a",
    })
    expect(command).toContain('worker enroll --server-url "https://brain.example"')
    expect(command).toContain('--enrollment "once"')
    expect(command).toContain('--fingerprint "sha256:certificate"')
  })

  it("uses the existing transport for create, list, and capability revoke", async () => {
    call.mockResolvedValueOnce({ enrollment: "once" }).mockResolvedValueOnce([])
    await createWorkerEnrollment()
    await listExecutionWorkers()
    await revokeExecutionWorker("worker-a")
    expect(call.mock.calls).toEqual([
      ["companion_create_worker_enrollment"],
      ["companion_list_workers"],
      ["companion_set_worker", { deviceId: "worker-a", allowed: false }],
    ])
  })

  it("uses owner-gated Companion RPCs from web", async () => {
    tauri.mockReturnValue(false)
    call.mockResolvedValueOnce({ enrollment: "once" }).mockResolvedValueOnce([])
    await createWorkerEnrollment()
    await listExecutionWorkers()
    await revokeExecutionWorker("worker-a")
    expect(call.mock.calls).toEqual([
      [
        "fleet_worker_enrollment_create",
        { baseUrl: "https://brain.test", fingerprint: "sha256:test" },
      ],
      ["fleet_worker_list"],
      ["fleet_worker_set", { deviceId: "worker-a", allowed: false }],
    ])
  })
})
