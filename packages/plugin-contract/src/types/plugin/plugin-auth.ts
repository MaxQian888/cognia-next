// Native auth/OAuth provider contribution (C1). A plugin declares
// `manifest.authProviders[]` (id + label, for validation + the consent UI) and
// supplies the live provider object imperatively at activation via
// `ctx.auth.registerProvider(...)` — mirroring `ctx.quickActions.register`.
// The richer provider/session/API types live in `lib/plugin/api/auth-api.ts`
// and `lib/plugin/auth/auth-provider-registry.ts`.

export interface PluginAuthProviderDef {
  /** Stable provider id, e.g. `"github"`, `"acme"`. */
  id: string
  /** Human-readable label shown in the consent UI. */
  label: string
}
