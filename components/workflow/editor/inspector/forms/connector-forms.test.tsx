import {
  ConnectorSendConfig,
  ConnectorReactionConfig,
  ConnectorDeleteConfig,
  ConnectorForwardConfig,
  ConnectorWaitReplyConfig,
  ConnectorDraftConfig,
} from "./connector-forms"

describe("connector-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        ConnectorSendConfig,
        ConnectorReactionConfig,
        ConnectorDeleteConfig,
        ConnectorForwardConfig,
        ConnectorWaitReplyConfig,
        ConnectorDraftConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})
