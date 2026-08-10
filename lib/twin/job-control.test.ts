import {
  __resetActiveTwinJobsForTesting,
  interruptActiveTwinJob,
  isTwinJobInterrupted,
  registerActiveTwinJob,
  throwIfTwinJobInterrupted,
} from "./job-control"

afterEach(__resetActiveTwinJobsForTesting)

it("interrupts an active job with a typed cooperative signal", () => {
  const active = registerActiveTwinJob("job-1")
  expect(interruptActiveTwinJob("job-1", "pause")).toBe(true)
  expect(() => throwIfTwinJobInterrupted(active.signal)).toThrow("interrupted: pause")
  try {
    throwIfTwinJobInterrupted(active.signal)
  } catch (error) {
    expect(isTwinJobInterrupted(error)).toBe(true)
  }
})

it("does not interrupt a released or unknown job", () => {
  const active = registerActiveTwinJob("job-1")
  active.release()
  expect(interruptActiveTwinJob("job-1", "cancel")).toBe(false)
  expect(interruptActiveTwinJob("missing", "cancel")).toBe(false)
})
