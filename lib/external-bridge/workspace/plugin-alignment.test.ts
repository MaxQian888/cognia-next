import { missingBridgeScopesForPlugin } from "./plugin-alignment"

describe("missingBridgeScopesForPlugin", () => {
  it("requires the bridge scope matching each workspace-class permission", () => {
    expect(
      missingBridgeScopesForPlugin(
        ["filesystem:read", "filesystem:write", "shell:execute", "process:spawn", "network:fetch"],
        ["plugin:tools"]
      )
    ).toEqual(["shell:run", "workspace:read", "workspace:write"])
  })

  it("passes when the caller holds them, and ignores unrelated permissions", () => {
    expect(missingBridgeScopesForPlugin(["filesystem:read"], ["workspace:read"])).toEqual([])
    expect(missingBridgeScopesForPlugin(["network:fetch", "ai:chat"], [])).toEqual([])
  })
})
