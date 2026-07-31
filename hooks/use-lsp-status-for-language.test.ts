import { serverForLanguage } from "./use-lsp-status-for-language"
import type { LspServerConfig } from "@/types/lsp/config"

describe("serverForLanguage", () => {
  it("matches a builtin by Monaco language id", () => {
    expect(serverForLanguage("typescript", [])?.id).toBe("typescript")
    expect(serverForLanguage("python", undefined)?.id).toBe("pyright")
    expect(serverForLanguage("yaml", [])?.id).toBe("yaml")
  })

  it("returns null for an unowned language", () => {
    expect(serverForLanguage("cobol", [])).toBeNull()
  })

  it("honours a user override of a builtin (merged fields, enabled: false removal)", () => {
    const disabled: LspServerConfig[] = [
      { id: "typescript", name: "ts", languages: ["typescript"], command: "x", enabled: false },
    ]
    expect(serverForLanguage("typescript", disabled)).toBeNull()

    const overridden: LspServerConfig[] = [
      {
        id: "typescript",
        name: "TS custom",
        languages: ["typescript", "javascript", "typescriptreact", "javascriptreact"],
        command: "/opt/tsls",
      },
    ]
    const hit = serverForLanguage("typescript", overridden)
    expect(hit?.command).toBe("/opt/tsls")
    expect(hit?.id).toBe("typescript")
  })

  it("falls back to custom user servers after builtins", () => {
    const users: LspServerConfig[] = [
      { id: "lsp_lua", name: "Lua", languages: ["lua"], command: "lua-ls" },
      { id: "lsp_off", name: "Off", languages: ["nim"], command: "nim-ls", enabled: false },
    ]
    expect(serverForLanguage("lua", users)?.id).toBe("lsp_lua")
    expect(serverForLanguage("nim", users)).toBeNull()
  })
})
