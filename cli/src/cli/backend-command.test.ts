import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { parseArgv } from "./args"

const dataRoots: string[] = []

jest.mock("../runtime/external/dsh-installer", () => {
  const actual = jest.requireActual("../runtime/external/dsh-installer")
  return {
    ...actual,
    defaultDataRoot: () => dataRoots[dataRoots.length - 1],
  }
})

// Imported after the mock so `defaultDataRoot` is the stubbed one.
import { backendCommand, resolveRuntimeSourceDir } from "./backend-command"
import { RUNTIME_ARTIFACTS } from "../runtime/external/dsh-installer"

function sink() {
  const out: string[] = []
  const err: string[] = []
  return {
    ctx: { out: { write: (t: string) => out.push(t), error: (t: string) => err.push(t) } },
    out,
    err,
  }
}

function args(line: string) {
  return parseArgv(line.split(" ").filter(Boolean))
}

let dataRoot: string

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cmd-"))
  dataRoots.push(dataRoot)
})

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true })
  dataRoots.pop()
})

describe("argument handling", () => {
  it("requires an action", async () => {
    const { ctx, err } = sink()
    expect(await backendCommand(args("backend"), ctx)).toBe(1)
    expect(err.join()).toContain("usage:")
  })

  it("requires a backend name", async () => {
    const { ctx, err } = sink()
    expect(await backendCommand(args("backend install"), ctx)).toBe(1)
    expect(err.join()).toContain("usage:")
  })

  it("rejects an unknown backend and lists the supported ones", async () => {
    const { ctx, err } = sink()
    expect(await backendCommand(args("backend install nonesuch"), ctx)).toBe(1)
    expect(err.join()).toContain("deepseek-harness")
  })

  it("rejects an unknown action", async () => {
    const { ctx, err } = sink()
    expect(await backendCommand(args("backend frobnicate deepseek-harness"), ctx)).toBe(1)
    expect(err.join()).toContain("expected install, doctor, or remove")
  })
})

describe("doctor", () => {
  it("reports an uninstalled runtime as unhealthy", async () => {
    const { ctx, err } = sink()
    expect(await backendCommand(args("backend doctor deepseek-harness"), ctx)).toBe(1)
    expect(err.join("\n")).toContain("unhealthy")
  })

  it("defaults to the read-only profile", async () => {
    // Read-only is the only profile whose authority cannot be escalated at
    // runtime on this transport, so it must be what an unqualified command means.
    const { ctx, err } = sink()
    await backendCommand(args("backend doctor deepseek-harness"), ctx)
    expect(err.join("\n")).toContain("cognia-sdk-readonly")
  })

  it("honours --profile workspace", async () => {
    const { ctx, err } = sink()
    await backendCommand(args("backend doctor deepseek-harness --profile workspace"), ctx)
    expect(err.join("\n")).toContain("cognia-sdk-workspace")
  })
})

describe("remove", () => {
  it("is idempotent when nothing is installed", async () => {
    const { ctx, out } = sink()
    expect(await backendCommand(args("backend remove deepseek-harness"), ctx)).toBe(0)
    expect(out.join()).toContain("Removed")
  })
})

describe("resolveRuntimeSourceDir", () => {
  it("resolves to the repo runtime directory holding the real artifacts", () => {
    // Guards the path arithmetic: a wrong number of `..` would only surface as
    // a confusing "artifact missing" at install time.
    const dir = resolveRuntimeSourceDir(import.meta.url)
    expect(path.basename(dir)).toBe("deepseek-harness")
    for (const artifact of RUNTIME_ARTIFACTS) {
      expect(fs.existsSync(path.join(dir, artifact))).toBe(true)
    }
  })
})

describe("install", () => {
  it("installs from the real runtime source and reports the channel", async () => {
    const { ctx, out } = sink()
    const install = jest.fn(async (options: { sourceDir: string }) => {
      // The command must hand the installer the real artifact directory.
      for (const artifact of RUNTIME_ARTIFACTS) {
        expect(fs.existsSync(path.join(options.sourceDir, artifact))).toBe(true)
      }
      return {
        channelId: "dsh-0.1.0-rc.6-abcdef12",
        upstreamVersion: "0.1.0-rc.6",
      } as never
    })

    const code = await backendCommand(args("backend install deepseek-harness"), {
      ...ctx,
      install: install as never,
    })

    expect(code).toBe(0)
    expect(install).toHaveBeenCalledTimes(1)
    const text = out.join("")
    expect(text).toContain("Installed to")
    expect(text).toContain("dsh-0.1.0-rc.6-abcdef12")
    // Upstream promises breaking changes; this warning is not optional.
    expect(text).toContain("EXPERIMENTAL")
  })

  it("reports an install failure without a stack trace", async () => {
    const { ctx, err } = sink()
    const { DshInstallError } = jest.requireActual("../runtime/external/dsh-installer")
    const install = jest.fn(async () => {
      throw new DshInstallError("npm install failed; the previous runtime was left in place.")
    })
    const code = await backendCommand(args("backend install deepseek-harness"), {
      ...ctx,
      install: install as never,
    })
    expect(code).toBe(1)
    expect(err.join()).toContain("previous runtime was left in place")
  })

  it("lets an unexpected error propagate rather than reporting success", async () => {
    const { ctx } = sink()
    const install = jest.fn(async () => {
      throw new TypeError("programmer error")
    })
    await expect(
      backendCommand(args("backend install deepseek-harness"), {
        ...ctx,
        install: install as never,
      })
    ).rejects.toThrow(TypeError)
  })
})
