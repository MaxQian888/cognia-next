import { PLUGIN_SERVICE_CONTRACTS } from "@cognia/plugin-sdk/contracts"
import { REALM_OVERRIDABLE_PLUGIN_SERVICES } from "./service-catalog"

describe("plugin service catalog projection", () => {
  it("matches the author contract", () => {
    expect([...REALM_OVERRIDABLE_PLUGIN_SERVICES].sort()).toEqual(
      PLUGIN_SERVICE_CONTRACTS.filter((service) => service.realmOverridable)
        .map((service) => service.id)
        .sort()
    )
  })
})
