# Runbook — Official account identity Worker (ADR-0215)

Incident and maintenance steps for `cognia-identity` (`id.cognia.cn`), the
OIDC issuer behind the official Cognia account. Provisioning, secrets and
deployment live in [`services/identity-server/README.md`](../../services/identity-server/README.md).

## Every request answers 503 `server_misconfigured`

The Worker refuses to issue tokens under a configuration it cannot trust.

1. Read the reason: `wrangler tail cognia-identity` (add `--env staging` for staging) and look for `[identity] configuration error: …`.
2. The usual causes:
   - `BETTER_AUTH_SECRETS` is unset, or a version is shorter than 32 characters.
   - A provider is half configured, e.g. `GOOGLE_CLIENT_ID` without `GOOGLE_CLIENT_SECRET`.
   - `BASE_URL` or `WEB_ORIGINS` is not an https origin.
3. Fix the secret or variable and redeploy. Nothing else needs to change.

## People cannot sign in with one provider

1. Open `https://id.cognia.cn/sign-in` from the app. A provider whose secrets are missing is not offered at all.
2. The provider's error page names the problem.
   - **Feishu 20029** means the redirect URL `https://id.cognia.cn/api/auth/callback/feishu` is not registered on the login app.
   - **Google `redirect_uri_mismatch`** has the same cause.
3. `/error?error=account_not_linked` means the person's verified email already belongs to an account that signs in another way. This is working as intended: they sign in with the original method.
4. Only the self-built Feishu app's own tenant can sign in until the marketplace (ISV) app exists.

## A signing key or secret is suspected compromised

1. Rotate `BETTER_AUTH_SECRETS` by prepending a new version, then deploy.
2. Delete the compromised ES256 key from D1:
   ```bash
   wrangler d1 execute cognia-identity --remote --command 'DELETE FROM "jwks" WHERE "id" = ?'
   ```
   Pass the key's `kid` as the id. The next signature mints a new key.
3. Tokens signed by the deleted key stop verifying as soon as verifiers refetch the JWKS. The desktop and the collab server cache it for at most 10 minutes.
4. To force everyone to sign in again, also delete all rows in `session` and `oauthRefreshToken`.

## A person asks to delete their account outside the app

The in-app flow (Settings → Account → Delete account) proves a fresh sign-in.

For a verified request received through support:

1. Insert a pending row:
   ```sql
   INSERT INTO account_deletion (user_id, status, requested_at, purge_after)
   VALUES ('usr_…', 'pending', <now ISO>, <now ISO>)
   ```
2. The next hourly cron purges the account.
3. Record the ticket.

## A purge keeps failing

The cron logs `[identity] purged N account(s); M failed` with the reason. A failed purge stays `pending` and is retried hourly.

Check what is still waiting:

```sql
SELECT * FROM account_deletion WHERE status = 'pending' AND purge_after <= <now ISO>
```

Fix the cause, which from phase 3 on will usually be a purge hook's downstream service. Then let the next run retry.
