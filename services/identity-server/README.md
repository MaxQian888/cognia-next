# Identity Worker — spike (ADR-0215 phase 1)

Throwaway prototype answering ADR-0215's identity assumptions before phase 1
is built. Not production code: email sign-up is on, the setup routes are
guarded only by a dev token, and there are no tests.

## Run

```bash
cd services/identity-server
pnpm install
# .dev.vars (gitignored): BETTER_AUTH_SECRET, SPIKE_ADMIN_TOKEN,
# optional FEISHU_APP_ID / FEISHU_APP_SECRET, DEMO_CLIENT_ID
pnpm dev                                   # http://localhost:8787, local D1
curl -X POST -H "x-spike-admin: $TOKEN" localhost:8787/spike/migrate
curl -X POST -H "x-spike-admin: $TOKEN" localhost:8787/spike/seed-client
node scripts/pkce-flow.mjs http://localhost:8787/api/auth <client_id> https://sync.cognia.cn
```

`/demo/client` is an in-browser public PKCE client for the Feishu round trip.

## Results (2026-10-04, better-auth 1.7.7, wrangler 4.141)

| Assumption                                                                 | Result                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better Auth on Workers + D1 is an OIDC issuer                              | Yes. D1 auto-detected; discovery at `<issuer>/.well-known/openid-configuration`; issuer is `BASE_URL/api/auth`. Bundle 3.0 MiB / 510 KiB gzip.                                                                                                                                                                                        |
| Access token `aud` = sync API, `sub` = `usr_`                              | Yes. `resource=https://sync.cognia.cn` yields an ES256 `at+jwt` with `kid`; `aud` is an array (sync API + userinfo). `advanced.database.generateId` mints `usr_<32 hex>`.                                                                                                                                                             |
| The Rust verifiers accept it                                               | Yes. The real `cognia-tenant-auth::oidc::OidcAuthenticator::authenticate_subject` accepts it, `UserId` validates the `sub`, and wrong audience, wrong issuer and a tampered payload are rejected.                                                                                                                                     |
| Feishu through `genericOAuth`, token v2, keyed on `(tenant_key, union_id)` | Yes, end to end in a real browser. Custom `getToken` (v2 takes JSON) and `getUserInfo` (unwrap `data`); account id `<tenant_key>:<union_id>`. Feishu returned no email, so a non-routable placeholder is used, never verified.                                                                                                        |
| The app client signs in to both issuers unchanged                          | **No, one line.** `lib/logto/client.ts` always sends `prompt=consent` (a Logto workaround to get a refresh token); Better Auth then shows a consent page even for a `skip_consent` client. With `prompt` dropped the unchanged client does login, refresh (rotating), revoke, and classifies refresh-after-revoke as `invalid_grant`. |

## Findings that change the plan

1. **Native callback scheme.** Better Auth enforces RFC 8252 §7.1: `cognia://auth/callback` (ADR-0215) and today's `cognia://logto/callback` are rejected. Use a reverse-domain private-use scheme without authority, e.g. `cn.cognia.app:/auth/callback`, registered in Tauri and Capacitor. _Done: the apps register it and send it to non-Logto issuers._
2. **`prompt=consent` must become issuer-specific** in the client (Logto only). _Done: `/api/auth/config` announces `oidc.issuerKind`; set `COGNIA_OIDC_ISSUER_KIND=oidc` for this Worker._
3. **Provider tokens.** Better Auth stores the Feishu login access token in D1 in clear by default and has no switch to stop it. A `databaseHooks.account` before-hook now drops provider tokens (verified on create and update); the issuer keeps only the `(tenant_key, union_id)` key.
4. **Resources and clients need explicit seeding.** Per-client resource linkage is enforced (`adminLinkClientResource`); resource seeding defaults to `insertOnly`, so set `resourceSeedMode: "overwrite"`; scopes not in a resource's `allowedScopes` are silently dropped (no `id_token` if `openid` is missing). Managed clients must be owned by a session, so the official client is seeded from an operator account.
5. **Lock down client management.** Without `clientPrivileges` / `resourcePrivileges`, any signed-in user can create OAuth clients.
6. **The issuer has to publish the person's social identities.** Today the app learns them from the collaboration server reading the Logto Management API; personal accounts have no collaboration server, so the issuer must expose `(provider, tenant, subject)` itself (a userinfo / id-token claim).
7. **Existing bug, Logto side.** `crates/cognia-collab-server/src/logto_management.rs:identities_from_user` looks for `details.unionId` / `details.tenantKey`, but Logto's Feishu connector stores them under `details.rawData` (`union_id`, `tenant_key`) and keys `userId` on `open_id`. The join therefore files an untenanted `ou_…` open id, and the sign-in ↔ Feishu principal link never forms.
8. **Smaller notes.** The authorize endpoint answers non-navigation requests with `{redirect, url}` JSON instead of a 302. Discovery does not list `none` in `token_endpoint_auth_methods_supported` although public clients work. The Rust verifier does not check `typ: at+jwt` (RFC 9068), so it relies on `aud` alone to refuse an ID token.
