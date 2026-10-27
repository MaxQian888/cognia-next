import { codebuffManifest, CODEBUFF_CAPABILITIES } from "./manifest"
it("declares its real protocol and unsupported MCP without a runtime import", () => {
  expect(codebuffManifest.protocols?.[0]?.protocol).toBe("codebuff-sdk")
  expect(CODEBUFF_CAPABILITIES.protocols?.["codebuff-sdk"]?.capabilities.mcp?.level).toBe(
    "unsupported"
  )
})
