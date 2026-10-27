import { projectLumeResource } from "./lume-projection"
import { projectSandboxConnectionCapabilities } from "./runtime-availability"
import type { LumeResource } from "@/lib/automation/lume-client"
jest.mock("@/lib/tauri/transport-instance", () => ({ localTransport: { call: jest.fn() } }))
const resource: LumeResource = {
  resourceId: "r",
  generation: 1,
  bootEpoch: "b",
  connectionId: "c",
  vmName: "owned",
  state: "running",
  readiness: { vm: true, ssh: true, helper: true, gui: false },
  quarantine: false,
  memoryMb: 8192,
  lastErrorCode: null,
  groupId: null,
}
test("feature-off keeps recovery available while execution stays unavailable", () => {
  const row = projectLumeResource(resource, false)
  const caps = projectSandboxConnectionCapabilities(row, true)
  expect(caps).toMatchObject({
    stop: true,
    delete: true,
    health: true,
    start: false,
    workspaceExec: false,
    gui: false,
  })
  expect(Object.keys(row.config)).not.toContain("sshHostKey")
})
test("readiness gates individual channels and non-desktop clients cannot operate", () => {
  const row = projectLumeResource(resource, true)
  expect(projectSandboxConnectionCapabilities(row, true)).toMatchObject({
    workspaceRead: true,
    gui: false,
    suspend: false,
    resume: false,
  })
  expect(Object.values(projectSandboxConnectionCapabilities(row, false)).some(Boolean)).toBe(false)
})
