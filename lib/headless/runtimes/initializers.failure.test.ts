/** @jest-environment node */
import { bootstrapHeadlessRuntimes } from "../bootstrap"
import {
  __resetHeadlessRuntimesForTesting,
  listHeadlessRuntimes,
  registerHeadlessRuntime,
} from "../registry"
import type { HeadlessRuntime, HeadlessRuntimeContext } from "../types"

jest.mock("@/stores/scheduler", () => ({
  useSchedulerStore: {
    getState: () => ({ initialize: mockInitialize, setSchedulerStatus: mockStatus }),
  },
}))
const mockInitialize = jest.fn()
const mockStatus = jest.fn()
const mockStopScheduler = jest.fn()
const mockStopBridge = jest.fn()
jest.mock("@/lib/scheduler", () => ({ stopSchedulerSystem: () => mockStopScheduler() }))
jest.mock("@/lib/execution/event-bridge", () => ({
  installExecutionEventBridge: () => mockStopBridge,
}))
jest.mock("@/lib/ai/agent/team/workflow-nodes/install", () => ({
  installTeamWorkflowNodeRuntime: jest.fn(),
}))
jest.mock("@/lib/workflow/runtime/trigger-subscriptions", () => ({
  initTriggerSubscriptions: jest.fn(),
  disposeTriggerSubscriptions: jest.fn(),
}))
jest.mock("@/lib/workflow/runtime/pet-event-trigger", () => ({
  initPetEventTrigger: jest.fn(),
  disposePetEventTrigger: jest.fn(),
}))
jest.mock("@/lib/workflow/runtime/issue-event-trigger", () => ({
  initIssueEventTrigger: jest.fn(),
  disposeIssueEventTrigger: jest.fn(),
}))
jest.mock("@/lib/workflow/runtime/plan-event-trigger", () => ({
  initPlanEventTrigger: jest.fn(),
  disposePlanEventTrigger: jest.fn(),
}))
jest.mock("@/lib/workflow/runtime/memory-written-trigger", () => ({
  initMemoryWrittenTrigger: jest.fn(),
  disposeMemoryWrittenTrigger: jest.fn(),
}))
jest.mock("@/lib/workflow/triggers/lifecycle", () => ({
  initPluginTriggerLifecycle: jest.fn(),
  disposePluginTriggerLifecycle: jest.fn(),
}))
jest.mock("@/lib/goal/verification", () => ({
  reconcilePendingGoalVerifications: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/workflow/runtime/schedule-handoff-delivery", () => ({
  registerScheduleHandoffDelivery: () => jest.fn(),
}))
jest.mock("@/lib/thread-handoff/delivery", () => ({
  registerThreadHandoffDelivery: () => jest.fn(),
}))
jest.mock("@/lib/placement/host-dispatch-runtime", () => ({
  installHostDispatchRuntime: () => ({ stop: jest.fn() }),
}))
jest.mock("@/lib/db/workflows", () => ({ listWorkflows: jest.fn() }))
jest.mock("@/lib/db/workflow-deployments", () => ({ resolveWorkflowDeployment: jest.fn() }))
jest.mock("@/lib/workflow/runtime/webhook-bridge", () => ({
  syncWorkflowTriggers: jest.fn(),
  unsyncWorkflowTriggers: jest.fn(),
}))
jest.mock("@/lib/workflow/runtime/resume-controller", () => ({ resumeInFlightRuns: jest.fn() }))
jest.mock("@/lib/templates/runtime", () => ({
  getTemplateRuntime: () => ({ service: { hydrateCatalog: mockHydrateCatalog } }),
}))
const mockHydrateCatalog = jest.fn()
import { listWorkflows } from "@/lib/db/workflows"
import { resolveWorkflowDeployment } from "@/lib/db/workflow-deployments"
import { syncWorkflowTriggers } from "@/lib/workflow/runtime/webhook-bridge"
import { resumeInFlightRuns } from "@/lib/workflow/runtime/resume-controller"
import { initIssueEventTrigger } from "@/lib/workflow/runtime/issue-event-trigger"
import { disposeTriggerSubscriptions } from "@/lib/workflow/runtime/trigger-subscriptions"
import {
  initPluginTriggerLifecycle,
  disposePluginTriggerLifecycle,
} from "@/lib/workflow/triggers/lifecycle"

const context: HeadlessRuntimeContext = {
  host: "brain",
  localAccountId: "account",
  bridge: {
    listen: async () => () => undefined,
    invoke: async () => null,
    respondMedia: async () => {},
  },
  notifyDbWrite: jest.fn(),
  resolveMessage: (key) => key,
  log: jest.fn(),
}
let runtimes: HeadlessRuntime[]
beforeAll(async () => {
  __resetHeadlessRuntimesForTesting()
  await import("./initializers")
  runtimes = listHeadlessRuntimes()
})
beforeEach(() => {
  jest.clearAllMocks()
  __resetHeadlessRuntimesForTesting()
})
function select(name: string) {
  registerHeadlessRuntime(runtimes.find((runtime) => runtime.name === name)!)
}

it("cleans up and reports a scheduler installation failure, then recovers on restart", async () => {
  select("scheduler")
  mockInitialize.mockRejectedValueOnce(new Error("scheduler unavailable"))
  const result = await bootstrapHeadlessRuntimes(context)
  expect(result.status()[0]).toMatchObject({ criticality: "required", state: "failed" })
  expect(mockStopBridge).toHaveBeenCalledTimes(1)
  expect(mockStopScheduler).toHaveBeenCalledTimes(1)
  expect(mockStatus).toHaveBeenCalledWith("stopped")
  await expect(result.restart("scheduler")).resolves.toMatchObject({ state: "running" })
  await result.stop()
})

it("keeps required workflow infrastructure running when individual sync and resume fail", async () => {
  select("workflow-runtime")
  jest.mocked(listWorkflows).mockResolvedValue([{ id: "bad" }, { id: "good" }] as never)
  jest
    .mocked(resolveWorkflowDeployment)
    .mockImplementation(async (id) => ({ workflow: { id } }) as never)
  jest.mocked(syncWorkflowTriggers).mockRejectedValueOnce(new Error("bad workflow"))
  jest.mocked(resumeInFlightRuns).mockRejectedValueOnce(new Error("bad run"))
  const result = await bootstrapHeadlessRuntimes(context)
  expect(syncWorkflowTriggers).toHaveBeenCalledTimes(2)
  expect(result.status()[0]).toMatchObject({ criticality: "required", state: "running" })
  expect(context.log).toHaveBeenCalledWith("warn", expect.stringContaining("bad run"))
  await result.stop()
})

it("reports trust reconciliation failures instead of trusting a stale catalog", async () => {
  select("template-trust-reconciliation")
  mockHydrateCatalog.mockRejectedValueOnce(new Error("trust store unavailable"))
  const result = await bootstrapHeadlessRuntimes(context)
  expect(result.status()[0]).toMatchObject({ criticality: "required", state: "failed" })
})

it("fails workflow installation and releases already installed subscriptions", async () => {
  select("workflow-runtime")
  jest.mocked(initIssueEventTrigger).mockImplementationOnce(() => {
    throw new Error("listener unavailable")
  })
  const result = await bootstrapHeadlessRuntimes(context)
  expect(result.status()[0]).toMatchObject({ state: "failed" })
  expect(disposeTriggerSubscriptions).toHaveBeenCalledTimes(1)
})

it("retries only failed workflow cleanups and blocks reinstallation until they succeed", async () => {
  select("workflow-runtime")
  jest.mocked(listWorkflows).mockResolvedValue([])
  const result = await bootstrapHeadlessRuntimes(context)
  jest
    .mocked(disposePluginTriggerLifecycle)
    .mockRejectedValueOnce(new Error("cleanup blocked"))
    .mockRejectedValueOnce(new Error("cleanup still blocked"))

  await expect(result.restart("workflow-runtime")).resolves.toMatchObject({ state: "failed" })
  await expect(result.restart("workflow-runtime")).resolves.toMatchObject({ state: "failed" })
  expect(disposePluginTriggerLifecycle).toHaveBeenCalledTimes(2)
  expect(disposeTriggerSubscriptions).toHaveBeenCalledTimes(1)
  expect(initPluginTriggerLifecycle).toHaveBeenCalledTimes(1)

  await expect(result.restart("workflow-runtime")).resolves.toMatchObject({ state: "running" })
  expect(disposePluginTriggerLifecycle).toHaveBeenCalledTimes(3)
  expect(disposeTriggerSubscriptions).toHaveBeenCalledTimes(1)
  expect(initPluginTriggerLifecycle).toHaveBeenCalledTimes(2)
  await result.stop()
})

it("retains failed cleanup after a partial workflow installation before allowing another start", async () => {
  select("workflow-runtime")
  jest.mocked(listWorkflows).mockResolvedValue([])
  jest.mocked(initIssueEventTrigger).mockImplementationOnce(() => {
    throw new Error("installation failed")
  })
  jest
    .mocked(disposeTriggerSubscriptions)
    .mockImplementationOnce(() => {
      throw new Error("cleanup blocked")
    })
    .mockImplementationOnce(() => {
      throw new Error("cleanup still blocked")
    })
  const result = await bootstrapHeadlessRuntimes(context)
  expect(result.status()[0]).toMatchObject({ state: "failed" })

  await expect(result.restart("workflow-runtime")).resolves.toMatchObject({ state: "failed" })
  expect(disposeTriggerSubscriptions).toHaveBeenCalledTimes(2)
  expect(initIssueEventTrigger).toHaveBeenCalledTimes(1)

  await expect(result.restart("workflow-runtime")).resolves.toMatchObject({ state: "running" })
  expect(disposeTriggerSubscriptions).toHaveBeenCalledTimes(3)
  expect(initIssueEventTrigger).toHaveBeenCalledTimes(2)
  await result.stop()
})
