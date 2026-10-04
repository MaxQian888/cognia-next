import type { PluginPiPackageDef } from "@/types/plugin/plugin-pi-package"
import { definePiPackage } from "./define-pi-package"

const valid: PluginPiPackageDef = {
  id: "latex-workbench",
  name: "LaTeX workbench",
  path: "pi",
  minPiVersion: "0.85.1",
  prepare: { program: "npm", args: ["ci"], marker: "pi/node_modules/.package-lock.json" },
  hostedSession: {
    extensions: ["pi/extensions/latex.ts"],
    env: [{ name: "TEX_ENGINE", from: { config: "engine" } }],
    tools: ["latex_compile"],
    controlsSession: true,
  },
}

describe("definePiPackage", () => {
  it("returns a valid definition unchanged", () => {
    expect(definePiPackage(valid)).toBe(valid)
    expect(definePiPackage({ id: "root", name: "Root", path: "." }).path).toBe(".")
  })

  it.each<[string, Partial<PluginPiPackageDef>, RegExp]>([
    ["non-kebab id", { id: "Latex_WB" }, /kebab-case/],
    ["missing name", { name: " " }, /name/],
    ["escaping path", { path: "../x" }, /leave the plugin/],
    ["absolute path", { path: "/opt/x" }, /relative/],
    ["backslash path", { path: "pi\\x" }, /forward slashes/],
    ["shell program", { prepare: { program: "sh" as never, args: [] } }, /prepare.program/],
    ["escaping marker", { prepare: { program: "npm", args: [], marker: "../m" } }, /marker/],
    ["no extensions", { hostedSession: { extensions: [] } }, /at least one/],
    ["python extension", { hostedSession: { extensions: ["pi/x.py"] } }, /must end in/],
    [
      "lower-case env",
      { hostedSession: { extensions: ["pi/x.ts"], env: [{ name: "x", from: { value: "1" } }] } },
      /env name/,
    ],
    [
      "built-in tool",
      { hostedSession: { extensions: ["pi/x.ts"], tools: ["bash"] } },
      /tool "bash"/,
    ],
  ])("rejects %s", (_label, overrides, message) => {
    expect(() => definePiPackage({ ...valid, ...overrides })).toThrow(message)
  })
})
