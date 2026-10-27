import { crushManifest, CRUSH_CAPABILITIES } from "./manifest"
it("declares its real protocol and unsupported MCP without a runtime import", () => {
  expect(crushManifest.protocols?.[0]?.protocol).toBe("crush-http")
  expect(CRUSH_CAPABILITIES.protocols?.["crush-http"]?.capabilities.mcp?.level).toBe("unsupported")
})
