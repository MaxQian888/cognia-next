import { getMigrations } from "better-auth/db/migration"

import { createAuth } from "./auth"
import type { Env } from "./env"
import { demoClientPage } from "./demo-client"
import { signInPage } from "./pages"

/** The Cognia apps, registered as one public PKCE client (ADR-0215 §2). */
const COGNIA_APP_REDIRECTS = [
  // RFC 8252 §7.1 private-use scheme: reverse domain of cognia.cn, no authority.
  "cn.cognia.app:/auth/callback",
  // Loopback for the CLI and for this spike's verification script.
  "http://127.0.0.1:53682/callback",
  // The spike's in-browser demo client (src/demo-client.ts).
  "http://localhost:8787/demo/client/callback",
]

function authorized(request: Request, env: Env): boolean {
  return (
    request.headers.get("x-spike-admin") === env.SPIKE_ADMIN_TOKEN &&
    env.SPIKE_ADMIN_TOKEN.length >= 16
  )
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    const auth = createAuth(env)

    if (url.pathname === "/sign-in" && request.method === "GET") {
      return new Response(signInPage(Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET)), {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }

    if (
      (url.pathname === "/demo/client" || url.pathname === "/demo/client/callback") &&
      env.DEMO_CLIENT_ID
    ) {
      return new Response(demoClientPage(env.DEMO_CLIENT_ID, env.SYNC_AUDIENCE), {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }

    if (url.pathname.startsWith("/spike/")) {
      if (!authorized(request, env)) return new Response("forbidden", { status: 403 })
      if (url.pathname === "/spike/migrate" && request.method === "POST") {
        const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options)
        await runMigrations()
        return Response.json({
          created: toBeCreated.map((table) => table.table),
          added: toBeAdded.map((table) => table.table),
        })
      }
      if (url.pathname === "/spike/seed-client" && request.method === "POST") {
        try {
          // A managed client must be owned by a session. The official deployment
          // seeds it once from an operator account; the spike does the same.
          const operator = await auth.api.signUpEmail({
            body: {
              email: `operator-${Date.now()}@cognia.invalid`,
              password: crypto.randomUUID(),
              name: "operator",
            },
            returnHeaders: true,
          })
          const cookie = (operator.headers.get("set-cookie") ?? "")
            .split(/,(?=\s*[^;=,\s]+=)/)
            .map((part) => part.split(";")[0]?.trim())
            .filter(Boolean)
            .join("; ")
          const client = await auth.api.adminCreateOAuthClient({
            headers: new Headers({ cookie }),
            body: {
              client_name: "Cognia",
              redirect_uris: COGNIA_APP_REDIRECTS,
              token_endpoint_auth_method: "none",
              application_type: "native",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              require_pkce: true,
              // First-party app: no consent screen for our own client.
              skip_consent: true,
            },
          })
          // Per-client resource linkage is enforced: the sync API audience must
          // be granted to this client explicitly.
          await auth.api.adminLinkClientResource({
            headers: new Headers({ cookie }),
            params: {
              identifier: encodeURIComponent(env.SYNC_AUDIENCE),
              client_id: client.client_id,
            },
          })
          return Response.json(client)
        } catch (error) {
          const detail = error as { status?: string; body?: unknown; message?: string }
          return Response.json(
            { status: detail.status, body: detail.body, message: detail.message },
            { status: 500 }
          )
        }
      }
      if (url.pathname === "/spike/hook-check" && request.method === "POST") {
        // Writes a social account WITH tokens through the hooked adapter and
        // reads back what was stored.
        const context = await auth.$context
        const user = await context.internalAdapter.createUser(
          { email: `hook-${Date.now()}@example.com`, name: "hook", emailVerified: false },
          { method: "email-password" } as never
        )
        const account = await context.internalAdapter.createAccount({
          userId: user.id,
          providerId: "feishu",
          accountId: `tenant:on_${Date.now()}`,
          accessToken: "u-provider-access",
          refreshToken: "ur-provider-refresh",
          idToken: "provider-id-token",
        })
        await context.internalAdapter.updateAccount(account.id, {
          accessToken: "u-provider-access-2",
        })
        const stored = await env.DB.prepare(
          "select accessToken, refreshToken, idToken from account where id = ?"
        )
          .bind(account.id)
          .first()
        return Response.json({ userId: user.id, stored })
      }
      return new Response("not found", { status: 404 })
    }

    if (url.pathname.startsWith("/api/auth/")) return auth.handler(request)
    return new Response("not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
