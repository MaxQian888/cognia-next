const getSecret = jest.fn()
const setSecret = jest.fn()
const clearSecret = jest.fn()

jest.mock("@/lib/keyring", () => ({
  getSecret: (...args: unknown[]) => getSecret(...args),
  setSecret: (...args: unknown[]) => setSecret(...args),
  clearSecret: (...args: unknown[]) => clearSecret(...args),
}))

import {
  clearAgentEnvSecret,
  createAgentEnvSecretRef,
  loadAgentEnvSecret,
  saveAgentEnvSecret,
} from "./agent-env-keyring"

beforeEach(() => jest.clearAllMocks())

it("creates an opaque reference without including the secret value", () => {
  const ref = createAgentEnvSecretRef("agent-1", "API_TOKEN", "nonce-1")
  expect(ref).toBe("agent-1:API_TOKEN:nonce-1")
  expect(ref).not.toContain("secret-value")
})

it("stores, reads, and clears values in the Agent environment namespace", async () => {
  getSecret.mockResolvedValue("secret")

  await saveAgentEnvSecret("ref-1", "secret")
  await expect(loadAgentEnvSecret("ref-1")).resolves.toBe("secret")
  await clearAgentEnvSecret("ref-1")

  const keyringRef = { namespace: "agent-env", key: "ref-1" }
  expect(setSecret).toHaveBeenCalledWith(keyringRef, "secret")
  expect(getSecret).toHaveBeenCalledWith(keyringRef)
  expect(clearSecret).toHaveBeenCalledWith(keyringRef)
})

it("rejects an empty secret instead of silently storing it", async () => {
  await expect(saveAgentEnvSecret("ref-1", "")).rejects.toThrow("must not be empty")
  expect(setSecret).not.toHaveBeenCalled()
})
