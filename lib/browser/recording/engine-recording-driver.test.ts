import type { BrowserEngine } from "@/lib/browser/agent-engine"
import { createEngineRecordingDriver } from "./engine-recording-driver"

const evaluate = jest.fn()
const recordingControl = jest.fn()
const engine = { evaluate, recordingControl } as unknown as BrowserEngine

beforeEach(() => {
  jest.clearAllMocks()
})

it("uses fixed recording controls while arbitrary evaluation remains forbidden", async () => {
  evaluate.mockRejectedValue(new Error("browser_human_input_required"))
  recordingControl.mockResolvedValue(undefined)
  const driver = createEngineRecordingDriver(engine)

  await driver.start()
  await driver.resume()
  await driver.stop()

  expect(recordingControl.mock.calls).toEqual([["start"], ["resume"], ["stop"]])
  expect(evaluate).not.toHaveBeenCalled()
})

it("reads drained steps without evaluating page-authored expressions", async () => {
  recordingControl.mockResolvedValue([
    {
      act: "click",
      at: 1,
      target: { selector: "#buy", role: "button", name: "Buy", domPath: "body > button" },
    },
  ])

  await expect(createEngineRecordingDriver(engine).drain()).resolves.toEqual([
    expect.objectContaining({ act: "click" }),
  ])
})

it("keeps an explicit recording-control failure", async () => {
  recordingControl.mockRejectedValue(new Error("blocked"))

  await expect(createEngineRecordingDriver(engine).start()).rejects.toThrow("blocked")
})

it("refuses engines without recording controls instead of falling back to evaluate", async () => {
  const unsupported = { evaluate } as unknown as BrowserEngine
  await expect(createEngineRecordingDriver(unsupported).start()).rejects.toThrow(/recording/i)
  expect(evaluate).not.toHaveBeenCalled()
})

it("marks unknown helper failures permanent but preserves navigation context races", async () => {
  recordingControl.mockRejectedValueOnce(new Error("Recording helper unavailable"))
  await expect(createEngineRecordingDriver(engine).drain()).rejects.toMatchObject({
    code: "browser_recording_invalid",
  })
  const transient = new Error("Execution context was destroyed during navigation")
  recordingControl.mockRejectedValueOnce(transient)
  await expect(createEngineRecordingDriver(engine).drain()).rejects.toBe(transient)
})

it.each(["{broken", "null", { steps: [] }, undefined])(
  "invalidates malformed recording output instead of returning an empty take: %p",
  async (value) => {
    recordingControl.mockResolvedValue(value)

    await expect(createEngineRecordingDriver(engine).drain()).rejects.toMatchObject({
      code: "browser_recording_invalid",
    })
    expect(evaluate).not.toHaveBeenCalled()
  }
)

it("accepts serialized steps returned by embedded recording controls", async () => {
  const steps = [{ act: "navigate", at: 1, url: "https://example.com" }]
  recordingControl.mockResolvedValue(JSON.stringify(steps))

  await expect(createEngineRecordingDriver(engine).drain()).resolves.toEqual(steps)
})
