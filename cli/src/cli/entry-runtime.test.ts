/**
 * @jest-environment node
 */
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import path from "node:path"
import {
  fatalExitCode,
  withCliProductionEnvironment,
  installClosedPipeHandler,
  normalizeProcessExitCode,
  runProcessEntrypoint,
  type EntrypointProcess,
} from "./entry-runtime"

describe("withCliProductionEnvironment", () => {
  it("loads in production and restores an unset ambient mode before user commands", async () => {
    const env: Record<string, string | undefined> = {}
    const value = await withCliProductionEnvironment(async () => {
      expect(env.NODE_ENV).toBe("production")
      return "loaded"
    }, env)
    expect(value).toBe("loaded")
    expect(env).not.toHaveProperty("NODE_ENV")
  })

  it.each(["development", "test", "production", ""])(
    "preserves explicit NODE_ENV=%s",
    async (value) => {
      const env = { NODE_ENV: value }
      await withCliProductionEnvironment(async () => {
        expect(env.NODE_ENV).toBe(value)
      }, env)
      expect(env.NODE_ENV).toBe(value)
    }
  )

  it("restores the ambient environment when dependency loading fails", async () => {
    const env: Record<string, string | undefined> = {}
    await expect(
      withCliProductionEnvironment(async () => {
        throw Error("load failed")
      }, env)
    ).rejects.toThrow("load failed")
    expect(env).not.toHaveProperty("NODE_ENV")
  })

  it("does not retain React development performance entries during real Ink rerenders", () => {
    const env = { ...process.env }
    Reflect.deleteProperty(env, "NODE_ENV")
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {withCliProductionEnvironment} from ${JSON.stringify(pathToFileURL(path.join(__dirname, "entry-runtime.ts")).href)};
      const {createRequire} = await import("node:module");
      const nativeRequire = createRequire(${JSON.stringify(path.join(__dirname, "../../package.json"))});
      const {React, render, Text} = await withCliProductionEnvironment(async () => {
        const {default: React} = await import(nativeRequire.resolve("react"));
        const {render, Text} = await import(nativeRequire.resolve("ink"));
        return {React, render, Text};
      });
      const {PassThrough} = await import("node:stream");
      const stdout = new PassThrough(); stdout.columns = 80; stdout.rows = 24; stdout.resume();
      const instance = render(React.createElement(Text, null, "start"), {
        stdout, stderr: stdout, stdin: new PassThrough(), exitOnCtrlC: false, patchConsole: false,
      });
      for (let i = 0; i < 200; i++) {
        instance.rerender(React.createElement(Text, null, "stream " + i));
        await new Promise(resolve => setImmediate(resolve));
      }
      instance.unmount(); await instance.waitUntilExit();
      const {execFileSync} = await import("node:child_process");
      const childMode = execFileSync(process.execPath, ["-p", "String(process.env.NODE_ENV)"], {encoding:"utf8"}).trim();
      console.log(JSON.stringify({childMode, measures: performance.getEntriesByType("measure").length}));
    `,
      ],
      { env, encoding: "utf8", timeout: 15000 }
    )
    expect(result.error).toBeUndefined()
    if (result.status !== 0) throw new Error(result.stderr)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ childMode: "undefined", measures: 0 })
  })
})

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

  it("exits with the code a fatal error asks for, so a refused brain is not a crash", async () => {
    const exit = jest.fn((code?: number): never => {
      throw new Error(`process-exit:${code}`)
    })
    const proc: EntrypointProcess = { stderr: { write: () => true }, exit, exitCode: undefined }

    await expect(
      runProcessEntrypoint(async () => {
        throw Object.assign(new Error("the server refused this brain"), { exitCode: 78 })
      }, proc)
    ).rejects.toThrow("process-exit:78")
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

describe("installClosedPipeHandler", () => {
  function pipeProc() {
    type Listener = (error: NodeJS.ErrnoException) => void
    const listeners = { stdout: [] as Listener[], stderr: [] as Listener[] }
    const exit = jest.fn((code?: number): never => {
      throw new Error(`process-exit:${code}`)
    })
    const proc = {
      stdout: { on: (_: "error", cb: Listener) => listeners.stdout.push(cb) },
      stderr: { on: (_: "error", cb: Listener) => listeners.stderr.push(cb) },
      exit,
    }
    const emit = (end: "stdout" | "stderr", err: NodeJS.ErrnoException) => {
      for (const cb of listeners[end]) cb(err)
    }
    return { proc, exit, emit }
  }

  it("exits quietly when the stdout consumer closes the pipe", () => {
    const { proc, exit, emit } = pipeProc()
    installClosedPipeHandler(proc)
    expect(() =>
      emit("stdout", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))
    ).toThrow("process-exit:0")
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("exits quietly when the stderr consumer closes the pipe", () => {
    const { proc, exit, emit } = pipeProc()
    installClosedPipeHandler(proc)
    expect(() =>
      emit("stderr", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))
    ).toThrow("process-exit:0")
    expect(exit).toHaveBeenCalledWith(0)
  })

  it("rethrows non-EPIPE stream faults so a broken channel stays loud", () => {
    const { proc, exit, emit } = pipeProc()
    installClosedPipeHandler(proc)
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
    expect(() => emit("stdout", reset)).toThrow("read ECONNRESET")
    expect(exit).not.toHaveBeenCalled()
  })
})

describe("fatalExitCode", () => {
  it("takes an integer exit code from 1 to 255 and treats anything else as 1", () => {
    expect(fatalExitCode(Object.assign(new Error("x"), { exitCode: 78 }))).toBe(78)
    expect(fatalExitCode(new Error("plain"))).toBe(1)
    expect(fatalExitCode({ exitCode: 0 })).toBe(1)
    expect(fatalExitCode({ exitCode: 300 })).toBe(1)
    expect(fatalExitCode({ exitCode: "78" })).toBe(1)
    expect(fatalExitCode(null)).toBe(1)
  })
})
