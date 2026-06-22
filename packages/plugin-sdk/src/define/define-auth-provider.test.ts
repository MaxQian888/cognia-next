import { defineAuthProvider } from "./define-auth-provider"
import { __makeSession } from "@/lib/plugin/auth/auth-provider-registry"

describe("defineAuthProvider", () => {
  it("returns the provider unchanged (pure pass-through)", () => {
    const session = __makeSession({
      accessToken: "t",
      account: { id: "u", label: "U" },
      scopes: [],
    })
    const provider = defineAuthProvider({
      id: "acme",
      label: "Acme",
      getSessions: async () => [session],
      createSession: async () => session,
      removeSession: async () => {},
    })
    expect(provider.id).toBe("acme")
    expect(provider.label).toBe("Acme")
    expect(typeof provider.getSessions).toBe("function")
  })
})
