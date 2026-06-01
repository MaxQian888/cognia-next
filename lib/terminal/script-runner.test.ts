/**
 * @jest-environment node
 */

import { buildScriptSpawnRequest, detectScriptType, parseShebang } from "./script-runner"

describe("detectScriptType — by extension", () => {
  it.each([
    ["deploy.sh", "bash"],
    ["build.bash", "bash"],
    ["theme.zsh", "zsh"],
    ["hook.fish", "fish"],
    ["setup.ps1", "powershell"],
    ["main.py", "python"],
    ["main.pyw", "python"],
    ["index.js", "node"],
    ["index.mjs", "node"],
    ["server.cjs", "node"],
    ["app.ts", "ts"],
    ["task.rb", "ruby"],
    ["x.pl", "perl"],
    ["site.php", "php"],
    ["a.lua", "lua"],
    ["mod.nu", "nu"],
    ["analyze.R", "r"],
    ["run.bat", "batch"],
    ["go.cmd", "batch"],
  ] as const)("maps %s → %s", (path, kind) => {
    expect(detectScriptType(path)?.kind).toBe(kind)
  })

  it("returns null for an unknown / extensionless path", () => {
    expect(detectScriptType("README")).toBeNull()
    expect(detectScriptType("data.bin")).toBeNull()
  })

  it("picks pwsh on non-windows and powershell.exe-friendly pwsh everywhere", () => {
    const t = detectScriptType("x.ps1")
    expect(t?.interpreter).toBe("pwsh")
    expect(t?.interpreterArgs).toEqual(["-NoLogo", "-File"])
  })

  it("python3 on unix, python on windows", () => {
    expect(detectScriptType("x.py", { platform: "linux" })?.interpreter).toBe("python3")
    expect(detectScriptType("x.py", { platform: "windows" })?.interpreter).toBe("python")
  })
})

describe("parseShebang", () => {
  it("parses a direct interpreter path", () => {
    expect(parseShebang("#!/bin/bash")).toEqual({ interpreter: "bash", interpreterArgs: [] })
  })
  it("resolves /usr/bin/env <prog>", () => {
    expect(parseShebang("#!/usr/bin/env python3")).toEqual({
      interpreter: "python3",
      interpreterArgs: [],
    })
  })
  it("keeps trailing interpreter flags", () => {
    expect(parseShebang("#!/usr/bin/env node --experimental-vm-modules")).toEqual({
      interpreter: "node",
      interpreterArgs: ["--experimental-vm-modules"],
    })
  })
  it("returns null when there is no shebang", () => {
    expect(parseShebang("echo hi")).toBeNull()
    expect(parseShebang("")).toBeNull()
  })
})

describe("detectScriptType — shebang kind mapping (interpreterToKind branches)", () => {
  it.each([
    ["#!/bin/sh", "bash"],
    ["#!/bin/dash", "bash"],
    ["#!/bin/zsh", "zsh"],
    ["#!/usr/bin/fish", "fish"],
    ["#!/usr/bin/pwsh", "powershell"],
    ["#!/usr/bin/powershell", "powershell"],
    ["#!/usr/bin/env node", "node"],
    ["#!/usr/bin/env nodejs", "node"],
    ["#!/usr/bin/env tsx", "ts"],
    ["#!/usr/bin/env ts-node", "ts"],
    ["#!/usr/bin/ruby", "ruby"],
    ["#!/usr/bin/perl", "perl"],
    ["#!/usr/bin/php", "php"],
    ["#!/usr/bin/lua", "lua"],
    ["#!/usr/bin/nu", "nu"],
    ["#!/usr/bin/Rscript", "r"],
    ["#!/usr/bin/env python2", "python"],
    ["#!/usr/bin/env pythonw", "python"],
    ["#!/bin/cmd", "batch"],
    ["#!/usr/bin/env deno", "deno"],
  ] as const)("shebang %s → kind %s", (shebang, kind) => {
    expect(detectScriptType("noext", { shebang })?.kind).toBe(kind)
  })

  it("resolves env -S <prog> <args>", () => {
    expect(parseShebang("#!/usr/bin/env -S deno run")).toEqual({
      interpreter: "deno",
      interpreterArgs: ["run"],
    })
  })

  it("returns null for `env` with nothing after it", () => {
    expect(parseShebang("#!/usr/bin/env")).toBeNull()
    expect(parseShebang("#!/usr/bin/env -S")).toBeNull()
  })

  it("returns null for a dotfile / extensionless name with no shebang", () => {
    expect(detectScriptType(".bashrc")).toBeNull()
    expect(detectScriptType("Makefile")).toBeNull()
  })
})

describe("detectScriptType — shebang precedence", () => {
  it("a shebang overrides the extension", () => {
    // .txt has no mapping, but the shebang says python
    const t = detectScriptType("script.txt", { shebang: "#!/usr/bin/env python3" })
    expect(t?.interpreter).toBe("python3")
    expect(t?.kind).toBe("python")
  })
  it("falls back to the extension when the shebang is absent", () => {
    expect(detectScriptType("a.rb", { shebang: "puts 1" })?.kind).toBe("ruby")
  })
})

describe("buildScriptSpawnRequest", () => {
  it("builds a SpawnRequest running the interpreter on the script", () => {
    const req = buildScriptSpawnRequest("/home/me/deploy.sh", {
      cwd: "/home/me",
      args: ["--prod"],
      platform: "linux",
    })
    expect(req.shell).toBe("bash")
    expect(req.args).toEqual(["/home/me/deploy.sh", "--prod"])
    expect(req.cwd).toBe("/home/me")
  })

  it("uses -File for PowerShell scripts", () => {
    const req = buildScriptSpawnRequest("C:\\x\\setup.ps1", { platform: "windows" })
    expect(req.shell).toBe("pwsh")
    expect(req.args).toEqual(["-NoLogo", "-File", "C:\\x\\setup.ps1"])
  })

  it("honors an explicit interpreter override", () => {
    const req = buildScriptSpawnRequest("x.py", { interpreter: "python3.12", platform: "windows" })
    expect(req.shell).toBe("python3.12")
    expect(req.args).toEqual(["x.py"])
  })

  it("throws for an undetectable script with no override", () => {
    expect(() => buildScriptSpawnRequest("mystery.bin")).toThrow(/cannot determine/i)
  })

  it("passes through rows/cols/env/projectId", () => {
    const req = buildScriptSpawnRequest("a.js", {
      rows: 40,
      cols: 120,
      env: { NODE_ENV: "test" },
      projectId: "p1",
    })
    expect(req.rows).toBe(40)
    expect(req.cols).toBe(120)
    expect(req.env).toEqual({ NODE_ENV: "test" })
    expect(req.projectId).toBe("p1")
  })
})
