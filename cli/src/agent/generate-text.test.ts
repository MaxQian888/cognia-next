/**
 * @jest-environment node
 */
import { lockdownTextOptions, generateText } from "./generate-text"
import type { SendOptions } from "@/lib/claude/types"
import type { BuildOptionsContext } from "@/lib/claude/build-options"
import type { ResolvedConfig } from "../config/schema"

describe("lockdownTextOptions", () => {
  it("strips every tool and bypasses approvals", async () => {
    const base = {
      allowedTools: ["Bash", "Edit"],
      permissionMode: "default",
    } as unknown as SendOptions
    const opts = await lockdownTextOptions({} as BuildOptionsContext, async () => base)
    expect(opts.allowedTools).toEqual([])
    expect(opts.permissionMode).toBe("bypassPermissions")
  })
})

describe("generateText", () => {
  it("runs a locked-down headless turn and returns its text", async () => {
    const run = jest.fn(
      async (_p: { prompt: string; timeoutMs?: number; home?: string; config: { cwd: string } }) =>
        ({ text: "hello", sessionId: "s", usage: undefined }) as never
    )
    const text = await generateText(
      { prompt: "hi", config: { cwd: "/w" } as ResolvedConfig, cwd: "/w", home: "/home" },
      run as never
    )
    expect(text).toBe("hello")
    const [params] = run.mock.calls[0]
    expect(params.prompt).toBe("hi")
    expect(params.home).toBe("/home")
    expect(params.config.cwd).toBe("/w")
    expect(params.timeoutMs).toBe(60_000)
  })
})
