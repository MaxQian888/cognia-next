import * as sdk from "./auth-provider"
import type {
  AuthSession,
  AuthSessionChangeEvent,
  AuthSessionOptions,
  AuthenticationProvider,
  PluginAuthProvider,
  PluginAuthProviderDef,
} from "./auth-provider"

describe("plugin-sdk api/auth-provider", () => {
  it("exposes the authoring helper, registry functions, and PKCE helpers", () => {
    expect(typeof sdk.defineAuthProvider).toBe("function")
    expect(typeof sdk.registerAuthenticationProvider).toBe("function")
    expect(typeof sdk.unregisterAuthenticationProvider).toBe("function")
    expect(typeof sdk.unregisterProvidersByPlugin).toBe("function")
    expect(typeof sdk.listProviders).toBe("function")
    expect(typeof sdk.getProvider).toBe("function")
    expect(typeof sdk.getSession).toBe("function")
    expect(typeof sdk.removeSession).toBe("function")
    expect(typeof sdk.onDidChangeSessions).toBe("function")
    expect(typeof sdk.hydrateFromSecrets).toBe("function")
    expect(typeof sdk.__makeSession).toBe("function")
    expect(typeof sdk.runPkceAuthFlow).toBe("function")
  })

  it("re-exports auth provider and session contract types", () => {
    const assertTypes = <
      _T extends
        | PluginAuthProvider
        | PluginAuthProviderDef
        | AuthenticationProvider
        | AuthSession
        | AuthSessionOptions
        | AuthSessionChangeEvent,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
