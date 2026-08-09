import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
import { createServer } from "node:http"

const port = Number.parseInt(process.env.PORT ?? "4020", 10)
const issuer = process.env.ISSUER ?? `http://oidc-fixture:${port}/oidc`
const allowedOrigin = process.env.ALLOWED_ORIGIN ?? "https://cognia.localhost"
const keyId = "web-headless-e2e-rs256"
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const publicJwk = publicKey.export({ format: "jwk" })
const authorizationCodes = new Map()
const refreshTokens = new Map()

function base64Url(value) {
  return Buffer.from(value).toString("base64url")
}

function json(response, status, body, origin) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...(origin === allowedOrigin
      ? {
          "access-control-allow-origin": allowedOrigin,
          vary: "Origin",
        }
      : {}),
  })
  response.end(JSON.stringify(body))
}

function jwt(claims) {
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: keyId, typ: "JWT" }))
  const payload = base64Url(JSON.stringify(claims))
  const signingInput = `${header}.${payload}`
  const signature = createSign("RSA-SHA256").update(signingInput).end().sign(privateKey)
  return `${signingInput}.${base64Url(signature)}`
}

function opaque(prefix) {
  return `${prefix}_${randomBytes(18).toString("base64url")}`
}

function redirect(response, redirectUri, values) {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
  response.writeHead(302, { location: url.toString(), "cache-control": "no-store" })
  response.end()
}

function validPkce(verifier, expectedChallenge) {
  if (!verifier || !expectedChallenge) return false
  const actual = createHash("sha256").update(verifier).digest("base64url")
  const left = Buffer.from(actual)
  const right = Buffer.from(expectedChallenge)
  return left.length === right.length && timingSafeEqual(left, right)
}

function issueToken(response, grant, origin) {
  const now = Math.floor(Date.now() / 1000)
  const accessToken = jwt({
    iss: issuer,
    aud: grant.resource,
    sub: `user:${grant.clientId}`,
    organization_id: grant.organizationId,
    scope: grant.scope,
    iat: now,
    exp: now + 300,
  })
  const refreshToken = opaque("refresh")
  refreshTokens.set(refreshToken, grant)
  json(
    response,
    200,
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 300,
      refresh_token: refreshToken,
      scope: grant.scope,
    },
    origin
  )
}

const server = createServer((request, response) => {
  const origin = request.headers.origin
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`)

  if (request.method === "OPTIONS") {
    if (origin !== allowedOrigin) {
      response.writeHead(403)
      response.end()
      return
    }
    response.writeHead(204, {
      "access-control-allow-origin": allowedOrigin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
      vary: "Origin",
    })
    response.end()
    return
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    response.writeHead(204)
    response.end()
    return
  }
  if (request.method === "GET" && url.pathname === "/oidc/.well-known/openid-configuration") {
    json(
      response,
      200,
      {
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      },
      origin
    )
    return
  }
  if (request.method === "GET" && url.pathname === "/oidc/jwks") {
    json(response, 200, { keys: [{ ...publicJwk, alg: "RS256", kid: keyId, use: "sig" }] }, origin)
    return
  }
  if (request.method === "GET" && url.pathname === "/oidc/auth") {
    const state = url.searchParams.get("state")
    const redirectUri = url.searchParams.get("redirect_uri")
    const clientId = url.searchParams.get("client_id")
    const resource = url.searchParams.get("resource")
    const challenge = url.searchParams.get("code_challenge")
    const challengeMethod = url.searchParams.get("code_challenge_method")
    if (
      !state ||
      !redirectUri ||
      !redirectUri.startsWith(`${allowedOrigin}/logto/callback`) ||
      !clientId ||
      !resource ||
      !challenge ||
      challengeMethod !== "S256"
    ) {
      json(response, 400, { error: "invalid_request" }, origin)
      return
    }
    const code = opaque("code")
    authorizationCodes.set(code, {
      clientId,
      redirectUri,
      resource,
      scope: url.searchParams.get("scope") ?? "openid",
      challenge,
      expiresAt: Date.now() + 60_000,
    })
    redirect(response, redirectUri, { code, state })
    return
  }
  if (request.method === "POST" && url.pathname === "/oidc/token") {
    let raw = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => {
      raw += chunk
    })
    request.on("end", () => {
      const body = new URLSearchParams(raw)
      const grantType = body.get("grant_type")
      if (grantType === "authorization_code") {
        const code = body.get("code") ?? ""
        const grant = authorizationCodes.get(code)
        authorizationCodes.delete(code)
        if (
          !grant ||
          grant.expiresAt <= Date.now() ||
          grant.clientId !== body.get("client_id") ||
          grant.redirectUri !== body.get("redirect_uri") ||
          grant.resource !== body.get("resource") ||
          !validPkce(body.get("code_verifier"), grant.challenge)
        ) {
          json(response, 400, { error: "invalid_grant" }, origin)
          return
        }
        issueToken(
          response,
          { ...grant, organizationId: body.get("organization_id") ?? undefined },
          origin
        )
        return
      }
      if (grantType === "refresh_token") {
        const refreshToken = body.get("refresh_token") ?? ""
        const grant = refreshTokens.get(refreshToken)
        refreshTokens.delete(refreshToken)
        if (
          !grant ||
          grant.clientId !== body.get("client_id") ||
          grant.resource !== body.get("resource")
        ) {
          json(response, 400, { error: "invalid_grant" }, origin)
          return
        }
        issueToken(response, grant, origin)
        return
      }
      json(response, 400, { error: "unsupported_grant_type" }, origin)
    })
    return
  }

  json(response, 404, { error: "not_found" }, origin)
})

server.listen(port, "0.0.0.0")

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
