import { normalizedBackupPath, withBackupLock } from "./backup-write-lock"

it("queues same-target requests without sharing results, and releases on failure", async () => {
  let release!: () => void
  const events: string[] = []
  const first = withBackupLock("target", async () => {
    events.push("first")
    await new Promise<void>((resolve) => {
      release = resolve
    })
    throw new Error("failed")
  })
  const rejected = expect(first).rejects.toThrow("failed")
  await Promise.resolve()
  const second = withBackupLock("target", async () => {
    events.push("second")
    return 2
  })
  await expect(withBackupLock("other", async () => 3)).resolves.toBe(3)
  expect(events).toEqual(["first"])
  release()
  await rejected
  await expect(second).resolves.toBe(2)
  expect(events).toEqual(["first", "second"])
})

it("normalizes Windows target spelling for cross-window sink locks", () => {
  expect(normalizedBackupPath("C:\\Backups\\file.cbk")).toBe("c:/backups/file.cbk")
})
