jest.mock("@/lib/credentials/keyring-store", () => ({
  createKeyringStore: jest.fn(() => ({ save: jest.fn(), load: jest.fn(), delete: jest.fn() })),
}))

import { getWebhookSigningSecret, setWebhookSigningSecret } from "./signing-secret"

const { createKeyringStore } = jest.requireMock("@/lib/credentials/keyring-store") as {
  createKeyringStore: jest.Mock
}
const keyring = createKeyringStore.mock.results[0].value as {
  save: jest.Mock
  load: jest.Mock
  delete: jest.Mock
}

describe("webhook signing secret", () => {
  beforeEach(() => jest.clearAllMocks())

  it("uses the shared keyring namespace and key", async () => {
    keyring.load.mockResolvedValue("secret")
    await expect(getWebhookSigningSecret()).resolves.toBe("secret")
    expect(keyring.load).toHaveBeenCalledWith("standard-signing-secret")

    await setWebhookSigningSecret("next")
    expect(keyring.save).toHaveBeenCalledWith("standard-signing-secret", "next")
  })

  it("deletes the key for null or empty values", async () => {
    await setWebhookSigningSecret(null)
    await setWebhookSigningSecret("")
    expect(keyring.delete).toHaveBeenCalledTimes(2)
    expect(keyring.save).not.toHaveBeenCalled()
  })
})
