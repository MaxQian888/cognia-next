import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { build } from "esbuild"

import {
  parseCallback,
  randomState,
  buildProvider,
  createEgressGuard,
  validateRemoteUrl,
  runFlow,
  prepareHeadlessFlow,
  completeHeadlessFlow,
  isMcpOauthHelperEntry,
} from "./mcp-oauth-helper.mjs"

test("collapsed sidecar URLs are not OAuth helper entrypoints, with or without a role", () => {
  for (const role of [undefined, "sidecar"]) {
    for (const argvPath of ["/dist/sidecar/claude-host.mjs", "/$bunfs/root/cognia-agent"]) {
      assert.equal(
        isMcpOauthHelperEntry({ role, importUrl: pathToFileURL(argvPath).href, argvPath }),
        false
      )
    }
  }
})

test("standalone helper retains entry support even with an inherited sidecar role", () => {
  const argvPath = path.resolve("directory with spaces/mcp-oauth-helper.mjs")
  for (const role of [undefined, "sidecar"]) {
    assert.equal(
      isMcpOauthHelperEntry({ role, importUrl: pathToFileURL(argvPath).href, argvPath }),
      true
    )
  }
  assert.equal(
    isMcpOauthHelperEntry({ argvPath: undefined, importUrl: "file:///helper.mjs" }),
    false
  )
  assert.equal(
    isMcpOauthHelperEntry({ argvPath, importUrl: "file:///another/mcp-oauth-helper.mjs" }),
    false
  )
})

test("real standalone helper consumes its own request with inherited role", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "mcp-oauth-helper.mjs"), "refresh"],
    {
      input: JSON.stringify({ server: { transport: "stdio" }, entry: {} }) + "\n",
      env: { ...process.env, COGNIA_ROLE: "sidecar" },
      encoding: "utf8",
      timeout: 5000,
    }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).result.status, "unsupported")
})

test("bundled library import cannot consume host IPC or exit after its first command", async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cognia-oauth-entry-")))
  const outfile = path.join(directory, "claude-host.mjs")
  let child
  try {
    await build({
      stdin: {
        contents: `
import {isPrivateOrReservedHost} from ${JSON.stringify(path.join(import.meta.dirname, "mcp-oauth-helper.mjs"))};
import readline from "node:readline";
const rl = readline.createInterface({input: process.stdin});
rl.on("line", line => {
  const command = JSON.parse(line);
  setImmediate(() => process.stdout.write(JSON.stringify({type: "control_response", requestId: command.requestId, privateHost: isPrivateOrReservedHost("localhost")}) + "\\n"));
});
process.stdout.write('{"type":"ready"}\\n');
`,
        resolveDir: import.meta.dirname,
      },
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node26",
      banner: {
        js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);',
      },
      logLevel: "silent",
    })
    const env = { PATH: process.env.PATH, HOME: directory }
    child = spawn(process.execPath, [outfile], {
      cwd: directory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr.on("data", (data) => {
      stderr += data
    })
    child.stdin.on("error", () => {})
    const frames = []
    let buffer = ""
    let notify = () => {}
    child.stdout.on("data", (data) => {
      buffer += data.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop()
      frames.push(...lines.filter(Boolean).map((line) => JSON.parse(line)))
      notify()
    })
    const waitFor = (predicate) =>
      new Promise((resolve, reject) => {
        const fail = () => {
          cleanup()
          reject(new Error(`bundled host exited: ${stderr}`))
        }
        const timer = setTimeout(fail, 5000)
        const cleanup = () => {
          clearTimeout(timer)
          child.off("exit", fail)
          notify = () => {}
        }
        child.once("exit", fail)
        notify = () => {
          if (frames.some(predicate)) {
            cleanup()
            resolve()
          }
        }
        if (child.exitCode !== null) fail()
        else notify()
      })
    await waitFor((frame) => frame.type === "ready")
    for (const requestId of ["first", "second"]) {
      child.stdin.write(
        JSON.stringify({ type: "control", method: "mcpServerStatus", requestId }) + "\n"
      )
      await waitFor((frame) => frame.type === "control_response" && frame.requestId === requestId)
    }
    assert.ok(frames.every((frame) => frame.type === "ready" || frame.type === "control_response"))
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL")
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("parseCallback extracts code/state/error", () => {
  assert.deepEqual(parseCallback("/callback?code=abc&state=xy"), {
    code: "abc",
    state: "xy",
    error: undefined,
    errorDescription: undefined,
  })
  const denied = parseCallback("/callback?error=access_denied&error_description=nope")
  assert.equal(denied.error, "access_denied")
  assert.equal(denied.errorDescription, "nope")
})

test("parseCallback yields no code for a query-less url", () => {
  assert.equal(parseCallback("::::").code, undefined)
})

test("randomState returns 16 hex chars", () => {
  const s = randomState()
  assert.match(s, /^[0-9a-f]{16}$/)
})

test("buildProvider reads/writes the seeded state and stamps expiry", () => {
  const state = { tokens: { access_token: "seed" } }
  const provider = buildProvider(state, {
    redirectUrl: "http://127.0.0.1:1/callback",
    state: "csrf",
  })
  assert.equal(provider.redirectUrl, "http://127.0.0.1:1/callback")
  assert.equal(provider.state(), "csrf")
  assert.deepEqual(provider.tokens(), { access_token: "seed" })

  provider.saveClientInformation({ client_id: "c" })
  assert.deepEqual(state.clientInformation, { client_id: "c" })

  provider.saveCodeVerifier("v")
  assert.equal(provider.codeVerifier(), "v")

  provider.saveTokens({ access_token: "new", expires_in: 100 })
  assert.equal(state.tokens.access_token, "new")
  assert.equal(state.codeVerifier, undefined) // cleared on token save
  assert.equal(typeof state.expiresAtMs, "number")
})

test("buildProvider.codeVerifier throws when none is saved", () => {
  const provider = buildProvider({}, { redirectUrl: "http://x/callback" })
  assert.throws(() => provider.codeVerifier(), /No PKCE code verifier/)
})

test("runFlow rejects stdio servers as unsupported", async () => {
  const out = await runFlow({ server: { transport: "stdio", config: {} }, mode: "authenticate" })
  assert.equal(out.result.ok, false)
  assert.equal(out.result.status, "unsupported")
})

test("OAuth egress rejects insecure and private endpoints unless explicitly reviewed", () => {
  assert.throws(() => validateRemoteUrl("http://example.com/mcp"), /HTTPS/)
  assert.throws(() => validateRemoteUrl("https://127.0.0.1/mcp"), /private or reserved/)
  assert.equal(validateRemoteUrl("http://127.0.0.1/mcp", true).href, "http://127.0.0.1/mcp")
  assert.throws(() => validateRemoteUrl("http://example.com/mcp", true), /HTTPS/)
})

test("guarded OAuth fetch denies redirects and carries a socket-level DNS guard", async () => {
  let agentOptions
  const dispatcher = { close: async () => undefined }
  class FakeAgent {
    constructor(options) {
      agentOptions = options
      return dispatcher
    }
  }
  let receivedInit
  const guard = createEgressGuard({
    AgentCtor: FakeAgent,
    lookup: (_hostname, _options, callback) =>
      callback(null, [{ address: "127.0.0.1", family: 4 }]),
    fetchImpl: async (_input, init) => {
      receivedInit = init
      return { ok: true }
    },
  })
  await guard.fetch("https://example.com/token", { redirect: "follow" })
  assert.equal(receivedInit.redirect, "error")
  assert.equal(receivedInit.dispatcher, dispatcher)
  assert.equal(typeof agentOptions.connect.lookup, "function")
  const lookupError = await new Promise((resolve) => {
    agentOptions.connect.lookup("rebinding.example", {}, (error) => resolve(error))
  })
  assert.match(lookupError.message, /private or reserved/)
  await guard.close()
})

test("runFlow blocks a private endpoint before starting the callback server", async () => {
  let callbackStarted = false
  const out = await runFlow(
    { server: { transport: "http", config: { url: "https://127.0.0.1/mcp" } } },
    {
      startCallbackServer: async () => {
        callbackStarted = true
        throw new Error("must not run")
      },
    }
  )
  assert.equal(out.result.ok, false)
  assert.match(out.result.message, /egress blocked/)
  assert.equal(callbackStarted, false)
})

test("runFlow returns authorized when the stored token already connects", async () => {
  // Inject fakes so no sockets / browser are touched.
  const fakeSdk = {
    Client: class {
      async connect() {
        return undefined
      }
      async close() {
        return undefined
      }
    },
    StreamableHTTPClientTransport: class {
      constructor() {
        this.finishAuth = async () => undefined
      }
    },
    SSEClientTransport: class {},
  }
  const callback = {
    redirectUrl: "http://127.0.0.1:1/callback",
    waitForCode: async () => ({ code: "x" }),
    close: () => undefined,
  }
  const out = await runFlow(
    {
      server: { transport: "http", config: { url: "https://x/mcp" } },
      entry: { tokens: { access_token: "t" } },
      mode: "authenticate",
    },
    {
      sdk: fakeSdk,
      startCallbackServer: async () => callback,
      openBrowser: () => undefined,
      onAuthUrl: () => undefined,
    }
  )
  assert.equal(out.result.ok, true)
  assert.equal(out.result.status, "authorized")
})

test("runFlow completes the authorization-code exchange on UnauthorizedError", async () => {
  let connects = 0
  const fakeSdk = {
    Client: class {
      async connect() {
        connects += 1
        if (connects === 1) {
          const err = new Error("needs auth")
          err.name = "UnauthorizedError"
          throw err
        }
        return undefined
      }
      async close() {
        return undefined
      }
    },
    StreamableHTTPClientTransport: class {
      constructor() {
        this.finishAuthCalled = false
        this.finishAuth = async () => {
          this.finishAuthCalled = true
        }
      }
    },
    SSEClientTransport: class {},
  }
  let opened = false
  const callback = {
    redirectUrl: "http://127.0.0.1:1/callback",
    waitForCode: async () => ({ code: "authcode", state: undefined }),
    close: () => undefined,
  }
  const out = await runFlow(
    {
      server: { transport: "http", config: { url: "https://x/mcp" } },
      entry: {},
      mode: "authenticate",
    },
    {
      sdk: fakeSdk,
      startCallbackServer: async () => callback,
      openBrowser: () => {
        opened = true
      },
      onAuthUrl: () => undefined,
    }
  )
  assert.equal(out.result.status, "authorized")
  assert.equal(connects, 2) // initial (throws) + post-finishAuth reconnect
})

test("runFlow reports a CSRF state mismatch", async () => {
  const fakeSdk = {
    Client: class {
      async connect() {
        const err = new Error("unauthorized")
        err.name = "UnauthorizedError"
        throw err
      }
      async close() {}
    },
    StreamableHTTPClientTransport: class {
      constructor() {
        this.finishAuth = async () => undefined
      }
    },
    SSEClientTransport: class {},
  }
  const out = await runFlow(
    {
      server: { transport: "http", config: { url: "https://x" } },
      entry: {},
      mode: "authenticate",
    },
    {
      sdk: fakeSdk,
      startCallbackServer: async () => ({
        redirectUrl: "http://127.0.0.1:1/callback",
        waitForCode: async () => ({ code: "c", state: "WRONG" }),
        close: () => undefined,
      }),
      openBrowser: () => undefined,
      onAuthUrl: () => undefined,
      randomState: () => "EXPECTED",
    }
  )
  assert.equal(out.result.ok, false)
  assert.match(out.result.message, /CSRF/)
})

test("prepareHeadlessFlow returns a resumable authorization URL and PKCE entry", async () => {
  const fakeSdk = {
    Client: class {
      async connect(transport) {
        await transport.provider.redirectToAuthorization(new URL("https://issuer.example/auth"))
        transport.provider.saveCodeVerifier("pkce-verifier")
        const error = new Error("unauthorized")
        error.name = "UnauthorizedError"
        throw error
      }
      async close() {}
    },
    StreamableHTTPClientTransport: class {
      constructor(_url, options) {
        this.provider = options.authProvider
      }
    },
    SSEClientTransport: class {},
  }
  const out = await prepareHeadlessFlow(
    {
      server: { transport: "http", config: { url: "https://mcp.example/rpc" } },
      entry: {},
      redirectUrl: "http://localhost:3000/integrations/mcp/oauth/callback",
      state: "a".repeat(64),
    },
    { sdk: fakeSdk }
  )

  assert.equal(out.result.status, "pending")
  assert.equal(out.authorizationUrl, "https://issuer.example/auth")
  assert.equal(out.entry.codeVerifier, "pkce-verifier")
})

test("completeHeadlessFlow exchanges the code with the persisted PKCE state", async () => {
  let finishedWith
  const fakeSdk = {
    Client: class {
      async connect() {}
      async close() {}
    },
    StreamableHTTPClientTransport: class {
      constructor(_url, options) {
        this.finishAuth = async (code) => {
          finishedWith = code
          options.authProvider.saveTokens({ access_token: "token", expires_in: 60 })
        }
      }
    },
    SSEClientTransport: class {},
  }
  const out = await completeHeadlessFlow(
    {
      server: { transport: "http", config: { url: "https://mcp.example/rpc" } },
      entry: { codeVerifier: "pkce-verifier" },
      redirectUrl: "https://brain.example/integrations/mcp/oauth/callback",
      state: "b".repeat(64),
      code: "authorization-code",
    },
    { sdk: fakeSdk }
  )

  assert.equal(finishedWith, "authorization-code")
  assert.equal(out.result.status, "authorized")
  assert.equal(out.entry.tokens.access_token, "token")
  assert.equal(out.entry.codeVerifier, undefined)
})

test("Headless stages reject malformed resumable inputs before loading the SDK", async () => {
  const server = { transport: "http", config: { url: "https://mcp.example/rpc" } }
  const invalidState = await prepareHeadlessFlow({
    server,
    entry: {},
    redirectUrl: "https://brain.example/integrations/mcp/oauth/callback",
    state: "short",
  })
  const invalidCode = await completeHeadlessFlow({
    server,
    entry: {},
    redirectUrl: "https://brain.example/integrations/mcp/oauth/callback",
    state: "c".repeat(64),
    code: "",
  })

  assert.match(invalidState.result.message, /256-bit OAuth state/)
  assert.match(invalidCode.result.message, /authorization code/)
})

test("prepareHeadlessFlow rejects unsupported transports and unsafe redirects", async () => {
  const stdio = await prepareHeadlessFlow({
    server: { transport: "stdio", config: {} },
    entry: {},
    redirectUrl: "https://brain.example/integrations/mcp/oauth/callback",
    state: "d".repeat(64),
  })
  const unsafeRedirect = await prepareHeadlessFlow({
    server: { transport: "http", config: { url: "https://mcp.example/rpc" } },
    entry: {},
    redirectUrl: "http://brain.example/integrations/mcp/oauth/callback",
    state: "e".repeat(64),
  })

  assert.equal(stdio.result.status, "unsupported")
  assert.match(unsafeRedirect.result.message, /redirect requires HTTPS/)
})

test("prepareHeadlessFlow reports non-auth failures and missing authorization URLs", async () => {
  const server = { transport: "http", config: { url: "https://mcp.example/rpc" } }
  const makeSdk = (error) => ({
    Client: class {
      async connect() {
        throw error
      }
      async close() {}
    },
    StreamableHTTPClientTransport: class {},
    SSEClientTransport: class {},
  })
  const input = {
    server,
    entry: {},
    redirectUrl: "https://brain.example/integrations/mcp/oauth/callback",
    state: "f".repeat(64),
  }
  const connectionFailure = await prepareHeadlessFlow(input, {
    sdk: makeSdk(new Error("network down")),
  })
  const unauthorized = new Error("authorization required")
  unauthorized.name = "UnauthorizedError"
  const missingUrl = await prepareHeadlessFlow(input, { sdk: makeSdk(unauthorized) })

  assert.match(connectionFailure.result.message, /connect failed: network down/)
  assert.match(missingUrl.result.message, /no authorization URL/)
})

test("completeHeadlessFlow rejects transports without an authorization-code exchange", async () => {
  const fakeSdk = {
    Client: class {
      async close() {}
    },
    StreamableHTTPClientTransport: class {},
    SSEClientTransport: class {},
  }
  const out = await completeHeadlessFlow(
    {
      server: { transport: "http", config: { url: "https://mcp.example/rpc" } },
      entry: { codeVerifier: "pkce-verifier" },
      redirectUrl: "https://brain.example/integrations/mcp/oauth/callback",
      state: "1".repeat(64),
      code: "authorization-code",
    },
    { sdk: fakeSdk }
  )

  assert.match(out.result.message, /transport has no finishAuth/)
})
