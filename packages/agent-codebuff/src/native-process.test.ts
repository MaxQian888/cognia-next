/** @jest-environment node */
import childProcess from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
  installCodebuffSubprocessGuard,
  runCodebuffProcess,
  spawnCodebuffReadHelper,
  validateCodebuffSearchFlags,
} from "./native-process"
it("rejects hidden shell execution through search flags or helper binary names", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cb-native-"))
  try {
    expect(validateCodebuffSearchFlags("-i -g *.ts -A 3")).toEqual(["-i", "-g", "*.ts", "-A", "3"])
    expect(() => validateCodebuffSearchFlags("--pre /bin/bash")).toThrow(/flags/)
    expect(() => validateCodebuffSearchFlags("--hostname-bin=/bin/bash")).toThrow(/flags/)
    expect(() => spawnCodebuffReadHelper(dir, "/malicious/git", ["status"])).toThrow(/unbrokered/)
    expect(() => spawnCodebuffReadHelper(dir, "git", ["diff", "--ext-diff"])).toThrow(/unbrokered/)
    expect(() => spawnCodebuffReadHelper(dir, "git", ["status"], { shell: true })).toThrow(
      /unbrokered/
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
it("denies SDK/MCP subprocess APIs while keeping approved bounded tool execution available", async () => {
  const restore = installCodebuffSubprocessGuard()
  try {
    expect(() => childProcess.spawn("/bin/echo", ["forbidden"])).toThrow(/Unbrokered/)
    expect(() => childProcess.exec("echo forbidden")).toThrow(/Unbrokered/)
    const result = await runCodebuffProcess("/bin/echo", ["approved"], os.tmpdir(), 5)
    expect(result).toMatchObject({ stdout: "approved\n", exitCode: 0 })
    await expect(
      runCodebuffProcess(
        process.execPath,
        ["-e", 'process.stdout.write("a".repeat(600000))'],
        os.tmpdir(),
        5
      )
    ).rejects.toThrow(/limit/)
  } finally {
    restore()
  }
})

it.each(["external", "textconv"])(
  "never executes repository-configured %s programs from a read-only Git helper",
  async (driver) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cb-git-"))
    const git = (args: string[]) =>
      childProcess.execFileSync("git", args, {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        stdio: "pipe",
      })
    try {
      git(["init", "--quiet"])
      await fs.writeFile(path.join(root, "tracked.txt"), "before")
      git(["add", "tracked.txt"])
      await fs.writeFile(path.join(root, "tracked.txt"), "after")
      const script = path.join(root, "unsafe-diff")
      await fs.writeFile(script, "#!/bin/sh\n: > unexpected-exec\nprintf external-output\n", {
        mode: 0o700,
      })
      if (driver === "external") git(["config", "diff.external", script])
      else {
        await fs.writeFile(path.join(root, ".gitattributes"), "*.txt diff=unsafe\n")
        git(["config", "diff.unsafe.textconv", script])
      }
      const child = spawnCodebuffReadHelper(await fs.realpath(root), "git", ["diff"])
      child.stdout?.resume()
      child.stderr?.resume()
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", () => resolve())
      })
      await expect(fs.stat(path.join(root, "unexpected-exec"))).rejects.toMatchObject({
        code: "ENOENT",
      })
      expect(() =>
        spawnCodebuffReadHelper(root, "git", ["diff", "--output=unapproved-write"])
      ).toThrow(/unbrokered/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
)
