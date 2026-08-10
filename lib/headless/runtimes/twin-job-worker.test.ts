import { getTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { startJobWorker } from "@/lib/twin/job-worker"
import { buildTwinWorkerConfig } from "@/lib/twin/worker-runtime"
import { __resetHeadlessRuntimesForTesting, listHeadlessRuntimes } from "../registry"

jest.mock("@/lib/db/twin-runtime-settings", () => ({ getTwinRuntimeSettings: jest.fn() }))
jest.mock("@/lib/twin/job-worker", () => ({ startJobWorker: jest.fn() }))
jest.mock("@/lib/twin/worker-runtime", () => ({ buildTwinWorkerConfig: jest.fn() }))

describe("Twin job worker headless runtime", () => {
  beforeEach(() => {
    __resetHeadlessRuntimesForTesting()
    jest.clearAllMocks()
  })

  it("registers the all-twins worker and handles ready and incomplete settings", async () => {
    const stop = jest.fn()
    ;(getTwinRuntimeSettings as jest.Mock).mockResolvedValue({ workerEnabled: true })
    ;(buildTwinWorkerConfig as jest.Mock).mockResolvedValue({ store: {} })
    ;(startJobWorker as jest.Mock).mockReturnValue({ stop })

    await import("./twin-job-worker")
    const runtime = listHeadlessRuntimes().find(({ name }) => name === "twin-job-worker")
    const teardown = await runtime!.start({ log: jest.fn() } as never)

    expect(runtime).toMatchObject({ hosts: ["brain"] })
    expect(startJobWorker).toHaveBeenCalledWith({ store: {} })
    await teardown!()
    expect(stop).toHaveBeenCalled()
    ;(getTwinRuntimeSettings as jest.Mock).mockResolvedValue({ workerEnabled: false })
    ;(buildTwinWorkerConfig as jest.Mock).mockResolvedValue(null)
    const log = jest.fn()

    await expect(runtime!.start({ log } as never)).resolves.toBeUndefined()
    expect(startJobWorker).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("disabled"))
  })
})
