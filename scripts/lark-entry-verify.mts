/**
 * Entry-surface verification harness for the Feishu dual-entry epic
 * (ADR-0091, runbook §3).
 *
 * Companion to `lark-live-smoke.mts`, which covers messaging. This one drives
 * the ENTRY surfaces through the same seam — real adapter code, real Feishu
 * OpenAPI, only the Tauri invoker swapped for Node fetch + an in-memory
 * keyring — so the parts of the runbook matrix a machine can check stop being
 * a manual read-through:
 *
 *   registry admission + bind approval · chat enumeration (the Chat Tab
 *   seeding source) · Chat Tab create/update/delete · group-menu create/delete
 *   · the p2p guard · surface withdrawal
 *
 * It then prints the steps that genuinely need a human in a Feishu client,
 * with the exact audit kind and metric each should produce, so the runbook
 * matrix is filled in against observed evidence rather than from memory.
 *
 * Usage:
 *   LARK_APP_ID=cli_… LARK_APP_SECRET=… npx tsx scripts/lark-entry-verify.mts
 *
 * Optional:
 *   LARK_TEST_CHAT_ID=oc_…   pin the chat to reconcile against
 *   LARK_WEB_BASE=https://…  web entry base used to build surface URLs
 *   LARK_VERIFY_KEEP=1       leave the created tab / menu in place
 *
 * Read-only unless a chat is reachable: without `im:chat.tabs:write_only` /
 * `im:chat.menu_tree:write_only` the write steps report the missing scope
 * instead of failing the run, which is itself the answer to "did the console
 * permissions land".
 */

import "fake-indexeddb/auto"

// getDb() refuses to run "on the server"; this harness IS the client.
if (typeof (globalThis as Record<string, unknown>).window === "undefined") {
  ;(globalThis as Record<string, unknown>).window = globalThis
}
function makeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, v),
  } as Storage
}
if (typeof (globalThis as Record<string, unknown>).localStorage === "undefined") {
  ;(globalThis as Record<string, unknown>).localStorage = makeStorage()
}

const APP_ID = process.env.LARK_APP_ID ?? ""
const APP_SECRET = process.env.LARK_APP_SECRET ?? ""
if (!APP_ID || !APP_SECRET) {
  console.error("lark-entry-verify: set LARK_APP_ID and LARK_APP_SECRET")
  process.exit(2)
}
const ADAPTER_ID = "lark-entry-verify"
const WEB_BASE = process.env.LARK_WEB_BASE ?? "https://cognia.invalid"
const KEEP = process.env.LARK_VERIFY_KEEP === "1"

const keyring = new Map<string, string>()

async function httpRequest(req: {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body === undefined ? {} : { body: req.body }),
  })
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: await res.text(),
  }
}

const { setConnectorCommandInvoker } = await import("../lib/connectors/tauri/commands")
setConnectorCommandInvoker(async <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
  switch (name) {
    case "connectors_http_request":
      return (await httpRequest(args!.req as Parameters<typeof httpRequest>[0])) as T
    case "connectors_keyring_get":
      return (keyring.get(`${args!.adapterId}:${args!.credential}`) ?? null) as T
    case "connectors_keyring_set":
      keyring.set(`${args!.adapterId}:${args!.credential}`, String(args!.value))
      return undefined as T
    // Metrics are fire-and-forget by contract; there is no companion here.
    case "lark_metrics_record":
      return undefined as T
    default:
      throw new Error(`entry-verify invoker: unmapped command '${name}'`)
  }
})

const { probeBotIdentity } = await import("../lib/connectors/adapters/lark/whoami")
const { getDb } = await import("../lib/db/schema")
const { seedLarkChatSurfaces, listBotChats } = await import(
  "../lib/connectors/adapters/lark/chat-seed"
)
const { reconcileChatTabSurface } = await import("../lib/connectors/adapters/lark/chat-tabs")
const { reconcileGroupMenuSurface } = await import("../lib/connectors/adapters/lark/group-menu")
const { removeChatSurface } = await import("../lib/connectors/adapters/lark/surface-removal")
const { getChatSurface, listChatSurfaces } = await import("../lib/db/lark-chat-surfaces")
const { registerFeishuTenant, approveFeishuBind, listFeishuPrincipals } = await import(
  "../lib/connectors/principal/admin"
)
const { createBindRequest } = await import("../lib/db/feishu-principals")
const { resolveConnectorPrincipal } = await import("../lib/connectors/principal/resolve")
const { larkMenuManifest } = await import("../lib/connectors/commands/registry")

const creds = { appId: APP_ID, appSecret: APP_SECRET }

type Status = "PASS" | "FAIL" | "SKIP"
const results: Array<{ step: string; status: Status; detail: string }> = []
function record(step: string, status: Status, detail = ""): void {
  results.push({ step, status, detail })
  const icon = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "—"
  console.log(`  ${icon} [${status}] ${step}${detail ? ` — ${detail}` : ""}`)
}
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await fn()
    record(name, "PASS", typeof value === "string" ? value : "")
    return value
  } catch (err) {
    record(name, "FAIL", err instanceof Error ? err.message : String(err))
    return undefined
  }
}

console.log(`\nLark entry-surface verification — app ${APP_ID}\n`)
console.log("1. Identity registry\n")

keyring.set(`${ADAPTER_ID}:appId`, APP_ID)
keyring.set(`${ADAPTER_ID}:appSecret`, APP_SECRET)
await getDb().adapterInstances.put({
  id: ADAPTER_ID,
  type: "lark",
  displayName: "Entry Verify",
  enabled: true,
  transportMode: "gateway",
  settings: { webEntryBaseUrl: WEB_BASE, larkChatTab: true, larkGroupMenu: true },
  credentialsRef: { keyringService: "cognia", accounts: ["appId", "appSecret"] },
  trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
  defaultMode: "auto",
  createdAt: Date.now(),
  updatedAt: Date.now(),
} as never)

await step("whoami probe resolves the bot identity", async () => {
  const probe = await probeBotIdentity(ADAPTER_ID, async () => creds)
  const row = await getDb().adapterInstances.get(ADAPTER_ID)
  const tenantKey = row?.lastWhoamiResult?.tenantKey
  return `app ${probe.appId}${tenantKey ? `, tenant ${tenantKey}` : ", tenant UNKNOWN"}`
})

// tenant_key is only learnable from inbound traffic; without it the registry
// and every surface URL fail closed, so say so loudly rather than pressing on.
const adapterRow = await getDb().adapterInstances.get(ADAPTER_ID)
const tenantKey = (adapterRow as { lastWhoamiResult?: { tenantKey?: string } } | undefined)
  ?.lastWhoamiResult?.tenantKey
if (!tenantKey) {
  record(
    "tenant scope known",
    "SKIP",
    "no tenant_key yet — send the bot one message, then re-run (whoami cannot report it)"
  )
} else {
  await step("tenant admission is idempotent", async () => {
    const first = await registerFeishuTenant({ adapterId: ADAPTER_ID, tenantKey, appId: APP_ID })
    const second = await registerFeishuTenant({ adapterId: ADAPTER_ID, tenantKey, appId: APP_ID })
    if (first.id !== second.id) throw new Error("re-admission minted a second tenant row")
    return `tenant ${first.id}`
  })

  await step("bind request → approval → principal resolves", async () => {
    const openId = `ou_verify_${Date.now()}`
    const request = await createBindRequest({
      openId,
      adapterId: ADAPTER_ID,
      tenantKey,
      appId: APP_ID,
    })
    await approveFeishuBind({ code: request.id })
    const resolution = await resolveConnectorPrincipal({
      platform: "lark",
      adapterRow: { settings: { larkPrincipalRegistry: true }, lastWhoamiResult: { appId: APP_ID } },
      remoteUserId: openId,
      identityScope: { tenantKey, appId: APP_ID },
    })
    if (resolution.status !== "resolved") {
      throw new Error(`approved principal resolved as ${resolution.status}`)
    }
    const bound = await listFeishuPrincipals(tenantKey, APP_ID)
    return `${bound.length} principal(s) bound`
  })
}

console.log("\n2. Chat surfaces (real Feishu API)\n")

const seedDeps = {
  request: (await import("../lib/connectors/adapters/lark/http")).larkTenantRequest,
  getAdapter: (await import("../lib/db/adapter-instances")).getAdapterInstance,
  ensure: (await import("../lib/db/lark-chat-surfaces")).ensureChatSurface,
  now: Date.now,
}

const chats = await listBotChats(seedDeps, creds).catch(() => [])
record(
  "enumerate the bot's chats (Chat Tab seeding source)",
  chats.length > 0 ? "PASS" : "SKIP",
  `${chats.length} chat(s), ${chats.filter((c) => c.chat_mode === "p2p").length} p2p`
)

// Group-only, because `menu_tree` refuses p2p by design.
const chatId =
  process.env.LARK_TEST_CHAT_ID ?? chats.find((c) => c.chat_mode !== "p2p")?.chat_id

if (!chatId) {
  record("chat surface reconcile", "SKIP", "no group chat reachable — set LARK_TEST_CHAT_ID")
} else {
  await step("seeding creates desired-state rows without duplicating", async () => {
    await seedLarkChatSurfaces({ adapterId: ADAPTER_ID, resolveCreds: async () => creds })
    const before = (await listChatSurfaces(ADAPTER_ID)).length
    await seedLarkChatSurfaces({ adapterId: ADAPTER_ID, resolveCreds: async () => creds })
    const after = (await listChatSurfaces(ADAPTER_ID)).length
    if (after !== before) throw new Error(`re-seed changed row count ${before} → ${after}`)
    return `${after} surface row(s), stable across re-seed`
  })

  await step(`Chat Tab reconcile in ${chatId}`, async () => {
    const outcome = await reconcileChatTabSurface(
      { adapterId: ADAPTER_ID, resolveCreds: async () => creds },
      chatId
    )
    const row = await getChatSurface(ADAPTER_ID, chatId, "chat_tab")
    if (outcome === "blocked") throw new Error(`blocked: ${row?.lastError ?? "unknown"}`)
    if (outcome === "error") throw new Error(`error: ${row?.lastError ?? "unknown"}`)
    return `${outcome} (tab ${row?.platformSurfaceId ?? "n/a"})`
  })

  await step("Chat Tab reconcile is idempotent (no second tab)", async () => {
    const first = await getChatSurface(ADAPTER_ID, chatId, "chat_tab")
    await reconcileChatTabSurface(
      { adapterId: ADAPTER_ID, resolveCreds: async () => creds },
      chatId
    )
    const second = await getChatSurface(ADAPTER_ID, chatId, "chat_tab")
    if (first?.platformSurfaceId !== second?.platformSurfaceId) {
      throw new Error("second reconcile produced a different tab id")
    }
    return `tab ${second?.platformSurfaceId ?? "n/a"} reused`
  })

  await step(`group menu reconcile in ${chatId}`, async () => {
    const outcome = await reconcileGroupMenuSurface(
      { adapterId: ADAPTER_ID, resolveCreds: async () => creds },
      chatId
    )
    const row = await getChatSurface(ADAPTER_ID, chatId, "group_menu")
    if (outcome === "blocked") throw new Error(`blocked: ${row?.lastError ?? "unknown"}`)
    if (outcome === "error") throw new Error(`error: ${row?.lastError ?? "unknown"}`)
    return `${outcome} (menu ${row?.platformSurfaceId ?? "n/a"})`
  })

  if (KEEP) {
    record("surface withdrawal", "SKIP", "LARK_VERIFY_KEEP=1 — tab and menu left in place")
  } else {
    await step("withdrawal removes the published tab and menu", async () => {
      const ctx = { adapterId: ADAPTER_ID, resolveCreds: async () => creds }
      for (const surfaceType of ["chat_tab", "group_menu"] as const) {
        const row = await getChatSurface(ADAPTER_ID, chatId, surfaceType)
        if (!row) continue
        const ok = await removeChatSurface(ctx, row)
        if (!ok) throw new Error(`${surfaceType} delete did not land platform-side`)
      }
      return "tab + menu withdrawn"
    })
  }
}

console.log("\n3. Console manifest (transcribe into the developer console)\n")
for (const item of larkMenuManifest()) {
  console.log(`   ${item.name}\t发送文字消息\t${item.text}`)
}

console.log("\n4. Steps that need a human in a Feishu client (runbook §3)\n")
const MANUAL: Array<[string, string]> = [
  ["Bot menu click, each reserved key", "mapped keys run; workbench replies with a link"],
  ["Unknown menu key", "bilingual notice + audit `menu.unknown_key`; NO model turn"],
  ["Chat Tab open as a member", "SSO once → lands in /inbox/c; metric lark_entry_resolve_ok_total"],
  ["Chat Tab open with a copied link, non-member", "forbidden page; audit `entry.denied`"],
  ["Chat Tab open as a DISABLED principal", "refused; audit `entry.denied` reason principal_*"],
  ["Personal entry link re-open", "`entry_consumed`; metric lark_entry_resolve_denied_total"],
  ["Message shortcut, ≤20 messages", "import lands; audit `shortcut.import`; re-run replays"],
  ["Message shortcut with a recalled message", "import succeeds, recalled id listed as skipped"],
  ["`+` menu inside a chat", "new session bound; audit `plus.create` — RECORD THE LAUNCH PARAMS"],
  ["JSSDK h5sdk.config on the shortcut page", "no ticket errors in the client console"],
  ["Approval card tapped by a non-requester", "refused with an explanation; `callback.forbidden`"],
  ["Same card tapped twice by the requester", "second tap explains it already ran"],
]
for (const [check, expected] of MANUAL) console.log(`   ☐ ${check}\n       expect: ${expected}`)

console.log(
  "\n   Two contracts remain unverified against a real client and can only be\n" +
    "   closed here: the `+`-menu launch-query parameter names, and the shape of\n" +
    "   the JSSDK `getBlockActionSourceDetail` payload. `parseShortcutLaunch` and\n" +
    "   `extractMessageRefs` scan tolerantly until they are pinned — record what\n" +
    "   you observe in docs/runbooks/lark-entry-surfaces.md §2.6.\n"
)

const failed = results.filter((r) => r.status === "FAIL")
console.log(
  `\nAutomated: ${results.filter((r) => r.status === "PASS").length} passed, ` +
    `${failed.length} failed, ${results.filter((r) => r.status === "SKIP").length} skipped\n`
)
process.exit(failed.length > 0 ? 1 : 0)
