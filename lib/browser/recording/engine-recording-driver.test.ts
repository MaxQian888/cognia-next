import type { BrowserEngine } from "@/lib/browser/agent-engine"
import { createEngineRecordingDriver } from "./engine-recording-driver"

const evaluate = jest.fn()
const engine = { evaluate } as unknown as BrowserEngine

beforeEach(() => {
  jest.clearAllMocks()
})

it("routes recording controls through the engine's injected page helpers", async () => {
  evaluate.mockResolvedValue({ ok: true, value: "1" })
  const driver = createEngineRecordingDriver(engine)

  await driver.start()
  await driver.resume()
  await driver.stop()

  expect(evaluate.mock.calls.map(([expression]) => expression)).toEqual([
    "window.__cogniaStartRecord()",
    "window.__cogniaResumeRecord()",
    "window.__cogniaStopRecord()",
  ])
})

it("parses drained steps from the host-neutral evaluate envelope", async () => {
  evaluate.mockResolvedValue({
    ok: true,
    value: JSON.stringify([
      {
        act: "click",
        at: 1,
        target: { selector: "#buy", role: "button", name: "Buy", domPath: "body > button" },
      },
    ]),
  })

  await expect(createEngineRecordingDriver(engine).drain()).resolves.toEqual([
    expect.objectContaining({ act: "click" }),
  ])
})

it("fails explicitly when the page helper cannot be evaluated", async () => {
  evaluate.mockResolvedValue({ ok: false, error: "blocked" })

  await expect(createEngineRecordingDriver(engine).start()).rejects.toThrow("blocked")
})
