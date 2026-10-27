import { rovoDevManifest, ROVO_CAPABILITIES } from "./manifest"
it("declares its real protocol and unsupported MCP without a runtime import", () => {
  expect(rovoDevManifest.protocols?.[0]?.protocol).toBe("rovo-http")
  expect(ROVO_CAPABILITIES.protocols?.["rovo-http"]?.capabilities.mcp?.level).toBe("unsupported")
})
