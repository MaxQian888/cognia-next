import {
  CharacterSendConfig,
  TeamRunConfig,
  TeamReconcileConfig,
  TeamComposeConfig,
  TeamStatusConfig,
  TeamDelegateConfig,
  TeamMessageConfig,
  AgentTurnConfig,
  CharacterCreateConfig,
  CharacterUpdateConfig,
  TeamCreateConfig,
  TeamUpdateConfig,
  TeamTaskDispatchConfig,
  PetInteractConfig,
} from "./team-forms"

describe("team-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        CharacterSendConfig,
        TeamRunConfig,
        TeamReconcileConfig,
        TeamComposeConfig,
        TeamStatusConfig,
        TeamDelegateConfig,
        TeamMessageConfig,
        AgentTurnConfig,
        CharacterCreateConfig,
        CharacterUpdateConfig,
        TeamCreateConfig,
        TeamUpdateConfig,
        TeamTaskDispatchConfig,
        PetInteractConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})
