import { continueDevManifest, CONTINUE_CAPABILITIES } from "./manifest"
it("declares its real protocol and unsupported MCP without a runtime import", () => {
  expect(continueDevManifest.protocols?.[0]?.protocol).toBe("continue-cli")
  expect(CONTINUE_CAPABILITIES.protocols?.["continue-cli"]?.capabilities.mcp?.level).toBe(
    "unsupported"
  )
})
