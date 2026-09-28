import { createEgressGuard, validateRemoteUrl } from "../../platform/net/egress-guard.ts"
import { buildProvider } from "./provider.ts"
import { buildTransport, isUnauthorized, loadSdk } from "./transport.ts"
import {
  msg,
  type HeadlessInput,
  type FlowDeps,
  type FlowResult,
  type OAuthClient,
  type HeadlessStageContext,
} from "./types.ts"

export async function prepareHeadlessFlow(
  { server, entry, redirectUrl, state: csrf }: HeadlessInput,
  deps: FlowDeps = {}
): Promise<FlowResult> {
  if (!/^[0-9a-f]{64}$/i.test(String(csrf ?? ""))) {
    return {
      result: { ok: false, status: "error", message: "invalid 256-bit OAuth state" },
      entry: entry ?? {},
    }
  }
  return runHeadlessStage(
    { server, entry, redirectUrl, csrf },
    deps,
    async ({ client, transport, authState, getAuthorizationUrl }) => {
      try {
        await client.connect(transport)
        return {
          result: { ok: true, status: "authorized", message: "already authorized" },
          entry: authState,
        }
      } catch (err) {
        if (!isUnauthorized(err)) {
          return {
            result: { ok: false, status: "error", message: `connect failed: ${msg(err)}` },
            entry: authState,
          }
        }
        const authorizationUrl = getAuthorizationUrl()
        if (!authorizationUrl) {
          return {
            result: {
              ok: false,
              status: "error",
              message: "authorization server returned no authorization URL",
            },
            entry: authState,
          }
        }
        return {
          result: { ok: true, status: "pending", message: "authorization required" },
          authorizationUrl,
          entry: authState,
        }
      }
    }
  )
}

export async function completeHeadlessFlow(
  { server, entry, redirectUrl, state: csrf, code }: HeadlessInput,
  deps: FlowDeps = {}
): Promise<FlowResult> {
  if (typeof code !== "string" || code.length === 0 || code.length > 8192) {
    return {
      result: { ok: false, status: "error", message: "invalid authorization code" },
      entry: entry ?? {},
    }
  }
  return runHeadlessStage(
    { server, entry, redirectUrl, csrf },
    deps,
    async ({ client, transport, authState }) => {
      if (typeof transport.finishAuth !== "function") {
        return {
          result: { ok: false, status: "error", message: "transport has no finishAuth" },
          entry: authState,
        }
      }
      try {
        await transport.finishAuth(code)
        await client.connect(transport)
        return {
          result: { ok: true, status: "authorized", message: "authorized" },
          entry: authState,
        }
      } catch (err) {
        return {
          result: { ok: false, status: "error", message: `token exchange: ${msg(err)}` },
          entry: authState,
        }
      }
    }
  )
}

async function runHeadlessStage(
  input: Omit<HeadlessInput, "state"> & { csrf?: string },
  deps: FlowDeps,
  stage: (context: HeadlessStageContext) => Promise<FlowResult>
): Promise<FlowResult> {
  const { server, redirectUrl, csrf } = input
  const authState = { ...(input.entry ?? {}) }
  if (server?.transport === "stdio") {
    return {
      result: { ok: false, status: "unsupported", message: "OAuth applies to sse/http only" },
      entry: authState,
    }
  }
  let parsedRedirect
  let egress
  try {
    parsedRedirect = new URL(String(redirectUrl))
    if (
      parsedRedirect.protocol !== "https:" &&
      parsedRedirect.hostname !== "127.0.0.1" &&
      parsedRedirect.hostname !== "localhost"
    ) {
      throw new Error("Headless OAuth redirect requires HTTPS")
    }
    const allowPrivateNetwork = server?.config?.allowPrivateNetwork === true
    validateRemoteUrl(server?.config?.url, allowPrivateNetwork)
    egress = (deps.createEgressGuard ?? createEgressGuard)({
      allowPrivateNetwork,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.lookup ? { lookup: deps.lookup } : {}),
      ...(deps.AgentCtor ? { AgentCtor: deps.AgentCtor } : {}),
    })
  } catch (err) {
    return {
      result: { ok: false, status: "error", message: `egress blocked: ${msg(err)}` },
      entry: authState,
    }
  }
  let sdk
  try {
    sdk = deps.sdk ?? (await loadSdk())
  } catch (err) {
    await egress.close().catch(() => undefined)
    return {
      result: { ok: false, status: "error", message: `SDK load failed: ${msg(err)}` },
      entry: authState,
    }
  }
  let authorizationUrl: string | undefined
  let client: OAuthClient | undefined
  try {
    const allowPrivateNetwork = server?.config?.allowPrivateNetwork === true
    const provider = buildProvider(authState, {
      redirectUrl: parsedRedirect.href,
      scope: server.config?.scope,
      state: csrf,
      onRedirect: async (url) => {
        authorizationUrl = validateRemoteUrl(url, allowPrivateNetwork).href
      },
    })
    const transport = buildTransport(sdk, server, provider, egress.fetch)
    client = new sdk.Client({ name: "cognia-mcp-oauth", version: "1.0.0" }, { capabilities: {} })
    return await stage({
      client,
      transport,
      authState,
      getAuthorizationUrl: () => authorizationUrl,
    })
  } finally {
    await client?.close?.().catch(() => undefined)
    await egress.close().catch(() => undefined)
  }
}
