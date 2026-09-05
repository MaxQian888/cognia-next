import { resolveBuiltinProcessSandbox } from "./builtin-process-sandbox"
import type { ResolvedConfig } from "../../config/schema"

const config = (sandbox?: unknown) => ({ cwd: "/workspace", sandbox }) as ResolvedConfig
it("keeps disabled and remote sandboxes out of the local launcher", () => {
  expect(resolveBuiltinProcessSandbox(config())).toBeUndefined()
  expect(resolveBuiltinProcessSandbox(config({ enabled: true, tier: "microvm" }))).toBeUndefined()
})
it("confines local processes to the workspace and disables network by default", () => {
  expect(
    resolveBuiltinProcessSandbox(config({ enabled: true, tier: "os" }), () => "/launcher")
  ).toEqual({
    launcher: "/launcher",
    writableRoots: ["/workspace"],
    readableRoots: ["/workspace"],
    network: false,
  })
})
it("keeps missing helpers fail closed and resolves configured roots", () => {
  expect(
    resolveBuiltinProcessSandbox(
      config({
        enabled: true,
        policy: { writableRoots: ["build"], readableRoots: ["../deps"], network: "allowlist" },
      }),
      () => undefined
    )
  ).toEqual({
    launcher: "",
    unavailableReason: expect.stringContaining("does not support network allowlists"),
    writableRoots: ["/workspace/build"],
    readableRoots: ["/workspace", "/deps"],
    network: false,
  })
})
