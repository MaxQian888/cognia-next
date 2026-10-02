// Bootstrap credential handoff and session derivation for the managed broker.
//
// Cognia never puts the broker secret in code-server's environment, because
// every terminal, task and language server code-server starts inherits that
// environment. The environment names a file instead
// (`COGNIA_CS_AGENT_CREDENTIAL_FILE`); this module reads it once and unlinks
// it. The secret inside is single use: the first successful hello consumes it,
// and both sides derive the next session key from it plus the two handshake
// nonces. Reconnects present the session; the host rotates it every time.
//
// Kept free of the `vscode` API so it is unit-testable with `node --test`.
// The derivation must match `crates/cognia-codeserver/src/credential.rs` byte
// for byte; `tests/fixtures/*.vector` pins both sides to one test vector.

import { createHmac, hkdfSync, randomBytes } from "node:crypto"
import { promises as fsPromises } from "node:fs"

const SESSION_INFO = "cognia-broker-session"
const CONTENT_LABEL = "content"
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_INTERVAL_MS = 250

/**
 * Wait for the bootstrap credential file, read it, and unlink it.
 *
 * The host re-mints the file whenever no extension host is connected, so a
 * missing file is waited for rather than treated as fatal. A file that does not
 * parse yet is assumed to be mid-write and is retried, not deleted.
 */
export async function readBootstrapCredential(
  path,
  {
    fs = fsPromises,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    now = Date.now,
    sleep = defaultSleep,
  } = {}
) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("IDE_BROKER_CREDENTIAL_UNAVAILABLE: no credential file configured")
  }
  const deadline = now() + timeoutMs
  while (true) {
    let raw = null
    try {
      raw = await fs.readFile(path, "utf8")
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    if (raw !== null) {
      const credential = parseBootstrap(raw)
      if (credential) {
        try {
          await fs.unlink(path)
        } catch (error) {
          if (error?.code !== "ENOENT") throw error
        }
        return credential
      }
    }
    if (now() >= deadline) {
      throw new Error("IDE_BROKER_CREDENTIAL_UNAVAILABLE: credential file did not appear")
    }
    await sleep(intervalMs)
  }
}

function parseBootstrap(raw) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (
    !value ||
    typeof value.tokenId !== "string" ||
    value.tokenId.length === 0 ||
    typeof value.secret !== "string" ||
    value.secret.length === 0
  ) {
    return null
  }
  return Object.freeze({
    kind: "bootstrap",
    tokenId: value.tokenId,
    secret: Buffer.from(value.secret, "utf8"),
  })
}

/** A fresh handshake nonce. The host requires 16–256 characters. */
export function newClientNonce() {
  return randomBytes(16).toString("hex")
}

/** Hex `HMAC-SHA256(secret, challenge)`: the hello's proof of possession. */
export function challengeProof(secret, challenge) {
  return createHmac("sha256", secret).update(challenge).digest("hex")
}

/**
 * `HKDF-SHA256(ikm = presented secret, info = label ‖ server nonce ‖ client
 * nonce)`, 32 bytes. Never sent: both sides compute it after a successful hello.
 */
export function deriveSessionKey(secret, serverNonce, clientNonce) {
  const info = Buffer.concat([
    Buffer.from(SESSION_INFO, "utf8"),
    Buffer.from(serverNonce, "utf8"),
    Buffer.from(clientNonce, "utf8"),
  ])
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), info, 32))
}

/** The content endpoint's bearer for a session: `<sessionId>.<HMAC(key, "content")>`. */
export function contentBearer(sessionId, sessionKey) {
  const mac = createHmac("sha256", sessionKey).update(CONTENT_LABEL).digest("hex")
  return `${sessionId}.${mac}`
}

/** The session credential that replaces a credential after a successful hello. */
export function nextSessionCredential(presented, serverNonce, clientNonce, sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("IDE_BROKER_NEGOTIATION_INVALID: missing sessionId")
  }
  return Object.freeze({
    kind: "session",
    tokenId: sessionId,
    secret: deriveSessionKey(presented.secret, serverNonce, clientNonce),
  })
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
