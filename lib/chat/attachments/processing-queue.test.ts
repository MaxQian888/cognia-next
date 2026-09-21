import { runAttachmentProcessing } from "./processing-queue"

it("bounds actual work and removes cancelled queued jobs", async () => {
  const releases: Array<() => void> = []
  let active = 0
  let maximum = 0
  const work = jest.fn(async () => {
    active++
    maximum = Math.max(maximum, active)
    await new Promise<void>((resolve) => releases.push(resolve))
    active--
  })
  const first = runAttachmentProcessing(work, new AbortController().signal)
  const second = runAttachmentProcessing(work, new AbortController().signal)
  const controller = new AbortController()
  const third = runAttachmentProcessing(work, controller.signal)
  const rejection = expect(third).rejects.toMatchObject({ name: "AbortError" })
  controller.abort()
  await Promise.resolve()
  expect(work).toHaveBeenCalledTimes(2)
  releases.forEach((release) => release())
  await Promise.all([first, second, rejection])
  expect(maximum).toBe(2)
})
