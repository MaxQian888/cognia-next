import { startMemoryJobWorker } from "@/lib/memory/lifecycle/job-worker"
import { __resetHeadlessRuntimesForTesting, listHeadlessRuntimes } from "../registry"

jest.mock("@/lib/memory/lifecycle/job-worker", () => ({
  startMemoryJobWorker: jest.fn(),
}))

describe("memory job worker headless runtime", () => {
  beforeEach(() => {
    __resetHeadlessRuntimesForTesting()
    jest.clearAllMocks()
  })

  it("registers the brain worker and starts it with a stable worker id", async () => {
    await import("./memory-job-worker")
    const runtime = listHeadlessRuntimes().find(({ name }) => name === "memory-job-worker")

    expect(runtime).toMatchObject({ name: "memory-job-worker", hosts: ["brain"] })
    await runtime!.start({} as never)
    expect(startMemoryJobWorker).toHaveBeenCalledWith({ workerId: "headless-memory-job-worker" })
  })
})
