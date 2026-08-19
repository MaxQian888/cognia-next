/**
 * @jest-environment node
 */
import { runProcessEntrypoint, type EntrypointProcess } from "./entry-runtime"

describe("runProcessEntrypoint", () => {
  it("terminates immediately when boot fails, even if other handles are still live", async () => {
    const stderr: string[] = []
    const exit = jest.fn((code?: number): never => {
      throw new Error(`process-exit:${code}`)
    })
    const proc: EntrypointProcess = {
      stderr: { write: (text) => stderr.push(text) },
      exit,
      exitCode: undefined,
    }

    await expect(
      runProcessEntrypoint(async () => {
        throw new Error("database bootstrap failed")
      }, proc)
    ).rejects.toThrow("process-exit:1")

    expect(stderr.join("")).toBe("cognia-agent: fatal: database bootstrap failed\n")
    expect(exit).toHaveBeenCalledWith(1)
    expect(proc.exitCode).toBeUndefined()
  })

  it("records a successful exit code without forcing termination", async () => {
    const proc: EntrypointProcess = {
      stderr: { write: jest.fn() },
      exit: jest.fn() as unknown as EntrypointProcess["exit"],
      exitCode: undefined,
    }

    await runProcessEntrypoint(async () => 7, proc)

    expect(proc.exitCode).toBe(7)
    expect(proc.exit).not.toHaveBeenCalled()
  })

  it("formats non-Error fatal values before terminating", async () => {
    const stderr: string[] = []
    const proc: EntrypointProcess = {
      stderr: { write: (text) => stderr.push(text) },
      exit: jest.fn((): never => {
        throw new Error("process-exit")
      }),
      exitCode: undefined,
    }

    await expect(
      runProcessEntrypoint(async () => {
        throw "database bootstrap failed"
      }, proc)
    ).rejects.toThrow("process-exit")

    expect(stderr.join("")).toBe("cognia-agent: fatal: database bootstrap failed\n")
    expect(proc.exit).toHaveBeenCalledWith(1)
  })
})
