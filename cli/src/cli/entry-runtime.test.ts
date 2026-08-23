/**
 * @jest-environment node
 */
import {
  normalizeProcessExitCode,
  runProcessEntrypoint,
  type EntrypointProcess,
} from "./entry-runtime"

describe("normalizeProcessExitCode", () => {
  it("normalizes Node's numeric-string exit code without hiding invalid values", () => {
    expect(normalizeProcessExitCode(undefined)).toBe(0)
    expect(normalizeProcessExitCode(null)).toBe(0)
    expect(normalizeProcessExitCode(7)).toBe(7)
    expect(normalizeProcessExitCode("9")).toBe(9)
    expect(normalizeProcessExitCode("not-an-exit-code")).toBe(1)
  })
})

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

  it("forces a successful Bun standalone process to terminate after cleanup", async () => {
    const proc: EntrypointProcess = {
      stderr: { write: jest.fn() },
      exit: jest.fn((): never => {
        throw new Error("process-exit:0")
      }),
      exitCode: undefined,
    }

    await expect(
      runProcessEntrypoint(async () => 0, proc, { forceExitOnSuccess: true })
    ).rejects.toThrow("process-exit:0")
    expect(proc.exitCode).toBe(0)
    expect(proc.exit).toHaveBeenCalledWith(0)
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
