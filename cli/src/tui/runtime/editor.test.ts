/**
 * @jest-environment node
 */
import { EventEmitter } from "node:events"

import {
  commandExists,
  describeEditor,
  detectEditor,
  editorInfo,
  fileUri,
  launchedFromEditor,
  openInEditor,
} from "./editor"

describe("describeEditor", () => {
  it("builds vscode `-g file:line:col` goto args", () => {
    const ed = describeEditor("code")
    expect(ed.family).toBe("vscode")
    expect(ed.displayName).toBe("Visual Studio Code")
    expect(ed.supportsGoto).toBe(true)
    expect(ed.openArgs("/a.ts", 12, 3)).toEqual(["-g", "/a.ts:12:3"])
    expect(ed.openArgs("/a.ts", 12)).toEqual(["-g", "/a.ts:12"])
    expect(ed.openArgs("/a.ts")).toEqual(["/a.ts"])
  })

  it("builds sublime `file:line` goto args", () => {
    expect(describeEditor("subl").openArgs("/a.ts", 9)).toEqual(["/a.ts:9"])
  })

  it("builds vim `+line file` goto args", () => {
    expect(describeEditor("nvim").openArgs("/a.ts", 9)).toEqual(["+9", "/a.ts"])
  })

  it("builds jetbrains `--line N file` goto args", () => {
    expect(describeEditor("idea").openArgs("/a.ts", 9)).toEqual(["--line", "9", "/a.ts"])
  })

  it("treats an unknown command as a generic, goto-less editor", () => {
    const ed = describeEditor("nano")
    expect(ed.family).toBe("generic")
    expect(ed.supportsGoto).toBe(false)
    expect(ed.openArgs("/a.ts", 9)).toEqual(["/a.ts"])
    expect(ed.uri).toBeUndefined()
  })

  it("splits embedded flags into args and prepends config args", () => {
    const ed = describeEditor("code --wait", { args: ["--reuse-window"] })
    expect(ed.command).toBe("code")
    expect(ed.openArgs("/a.ts")).toEqual(["--wait", "--reuse-window", "/a.ts"])
  })

  it("honours an explicit gotoFormat override", () => {
    const ed = describeEditor("myedit", { gotoFormat: "vim" })
    expect(ed.supportsGoto).toBe(true)
    expect(ed.openArgs("/a.ts", 4)).toEqual(["+4", "/a.ts"])
  })

  it("strips a directory and .cmd/.exe extension when matching the table", () => {
    expect(describeEditor("C:/bin/code.cmd").family).toBe("vscode")
  })
})

describe("fileUri", () => {
  it("forward-slashes a Windows path and keeps the drive colon for vscode", () => {
    expect(fileUri("C:\\a\\b.ts", 12, "vscode")).toBe("vscode://file/C:/a/b.ts:12")
  })

  it("keeps a posix path's leading slash for vscode and appends the line", () => {
    expect(fileUri("/home/x/a.ts", 5, "vscode")).toBe("vscode://file/home/x/a.ts:5")
    expect(fileUri("/home/x/a.ts", undefined, "vscode")).toBe("vscode://file/home/x/a.ts")
  })

  it("falls back to a file:// URL for non-vscode families", () => {
    const uri = fileUri("/home/x/a.ts", 5, "vim")
    expect(uri.startsWith("file://")).toBe(true)
    expect(uri.endsWith("/home/x/a.ts")).toBe(true)
  })
})

describe("detectEditor", () => {
  it("prefers the config command and applies its args/gotoFormat", () => {
    const { editor, source } = detectEditor(
      { EDITOR: "vim" },
      { config: { command: "code", args: ["--wait"] } }
    )
    expect(source).toBe("config")
    expect(editor.command).toBe("code")
    expect(editor.openArgs("/a.ts")).toEqual(["--wait", "/a.ts"])
  })

  it("prefers $VISUAL over $EDITOR", () => {
    expect(detectEditor({ VISUAL: "subl", EDITOR: "vim" }).source).toBe("VISUAL")
    expect(detectEditor({ VISUAL: "subl", EDITOR: "vim" }).editor.id).toBe("subl")
  })

  it("uses $EDITOR when $VISUAL is absent/blank", () => {
    const r = detectEditor({ VISUAL: "   ", EDITOR: "nvim" })
    expect(r.source).toBe("EDITOR")
    expect(r.editor.id).toBe("nvim")
  })

  it("maps TERM_PROGRAM=vscode to code", () => {
    const r = detectEditor({ TERM_PROGRAM: "vscode" })
    expect(r.source).toBe("TERM_PROGRAM")
    expect(r.editor.id).toBe("code")
  })

  it("probes the PATH in order when nothing in env names an editor", () => {
    const r = detectEditor({}, { probe: (c) => c === "cursor" })
    expect(r.source).toBe("path-probe")
    expect(r.editor.id).toBe("cursor")
  })

  it("falls back to code when nothing is found", () => {
    const r = detectEditor({}, { probe: () => false })
    expect(r.source).toBe("default")
    expect(r.editor.id).toBe("code")
  })
})

describe("launchedFromEditor", () => {
  it("is true for TERM_PROGRAM=vscode", () => {
    expect(launchedFromEditor({ TERM_PROGRAM: "vscode" })).toBe(true)
  })

  it("is true for a VSCODE_* marker", () => {
    expect(launchedFromEditor({ VSCODE_GIT_ASKPASS_MAIN: "/x/askpass.js" })).toBe(true)
  })

  it("is true when GIT_ASKPASS points at cursor", () => {
    expect(launchedFromEditor({ GIT_ASKPASS: "/Applications/Cursor/askpass.sh" })).toBe(true)
  })

  it("is false for a plain shell", () => {
    expect(launchedFromEditor({ TERM_PROGRAM: "iTerm.app" })).toBe(false)
  })
})

describe("editorInfo", () => {
  it("composes detection, launch marker, terminal, and hyperlink support", () => {
    const info = editorInfo({ TERM_PROGRAM: "vscode" })
    expect(info.editor.id).toBe("code")
    expect(info.source).toBe("TERM_PROGRAM")
    expect(info.launchedFromEditor).toBe(true)
    expect(info.terminalProgram).toBe("vscode")
    expect(info.hyperlinks).toBe(true)
  })

  it("reports no hyperlinks for an unknown terminal", () => {
    const info = editorInfo({ EDITOR: "vim" }, {})
    expect(info.hyperlinks).toBe(false)
    expect(info.terminalProgram).toBeUndefined()
  })
})

describe("commandExists", () => {
  it("finds node on this machine and rejects a bogus command", () => {
    expect(commandExists("node")).toBe(true)
    expect(commandExists("definitely-not-a-real-command-xyz-123")).toBe(false)
  })
})

describe("openInEditor", () => {
  function fakeChild() {
    return new EventEmitter() as EventEmitter & { stdin?: unknown }
  }

  it("spawns the editor directly on posix and resolves true on spawn", async () => {
    const child = fakeChild()
    const spawn = jest.fn(() => child) as never
    const editor = describeEditor("code")
    const p = openInEditor("/a.ts", { line: 3, editor, spawn, platform: "darwin" })
    child.emit("spawn")
    await expect(p).resolves.toBe(true)
    expect(spawn).toHaveBeenCalledWith(
      "code",
      ["-g", "/a.ts:3"],
      expect.objectContaining({ stdio: "ignore" })
    )
  })

  it("runs the launcher through cmd /c on Windows", async () => {
    const child = fakeChild()
    const spawn = jest.fn(() => child) as never
    const editor = describeEditor("code")
    const p = openInEditor("C:/a.ts", { editor, spawn, platform: "win32" })
    child.emit("spawn")
    await expect(p).resolves.toBe(true)
    expect(spawn).toHaveBeenCalledWith("cmd", ["/c", "code", "C:/a.ts"], expect.anything())
  })

  it("resolves false when the editor errors", async () => {
    const child = fakeChild()
    const p = openInEditor("/a.ts", {
      editor: describeEditor("code"),
      spawn: (() => child) as never,
      platform: "linux",
    })
    child.emit("error", new Error("not found"))
    await expect(p).resolves.toBe(false)
  })

  it("resolves false when spawn throws synchronously", async () => {
    const spawn = (() => {
      throw new Error("EACCES")
    }) as never
    await expect(
      openInEditor("/a.ts", { editor: describeEditor("code"), spawn, platform: "darwin" })
    ).resolves.toBe(false)
  })
})
