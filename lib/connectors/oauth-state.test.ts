import { CONNECTOR_OAUTH_STATE_KEY } from "./oauth-state"

it("keeps the connector OAuth state storage contract stable", () => {
  expect(CONNECTOR_OAUTH_STATE_KEY).toBe("connector-oauth-state")
})
