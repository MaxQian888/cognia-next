/**
 * Pairing, and what a paired browser is allowed to be.
 *
 * Runs on the `granted` profile — see `extension-profile.ts` for the one way
 * that build differs from the shipped one and for what the difference costs.
 * Everything exercised here is production code: WebCrypto key generation, the
 * SPKI export, the registration proof, the token exchange and the storage
 * write.
 */
// Reached by relative path, not through `@ext/*`: the root tsconfig excludes
// `browser-extension/` (the workspace type-checks itself), so the alias does
// not exist here. This one module is safe to import across that line because
// it has no imports of its own — it is the interface and the storage-key
// table, nothing else — so pulling it in drags no `chrome` globals or bundler
// aliases into the root program.
import { STORAGE_KEYS } from "../../../browser-extension/src/lib/browser-api"

import { expect, pairThroughPanel, test } from "./fixtures"

test.use({ extensionProfile: "granted" })

test.describe("pairing a browser", () => {
  test("registers a device the Host will only ever let submit and read its own", async ({
    panel,
    mockHost,
    extensionOrigin,
  }) => {
    await pairThroughPanel(panel, mockHost.issueEnrollment())

    // The panel reaching its ready state is the end-to-end proof: it only gets
    // there after a challenge, a verified registration proof, a token exchange
    // and an accepted `browser_companion_capability`.
    await expect(
      panel.getByTestId("workspace-select").or(panel.getByTestId("capture-empty"))
    ).toBeVisible()

    expect(mockHost.devices()).toEqual([
      {
        deviceId: expect.any(String),
        extensionOrigin,
        // The closed set. A browser holds no `agent.run`, no `workspace.write`,
        // no `terminal.open` and no `process.spawn`, and the absence is the
        // security property — so it is asserted as an exact list, not by
        // checking the two are present.
        capabilities: ["browser.submit", "browser.read-own"],
      },
    ])
  })

  test("carries its bound origin on every authenticated request", async ({
    panel,
    mockHost,
    extensionOrigin,
  }) => {
    await pairThroughPanel(panel, mockHost.issueEnrollment())
    await expect(panel.getByTestId("capture-empty")).toBeVisible()

    const authenticated = mockHost.requests().filter((request) => request.hasAuthorization)
    expect(authenticated.length).toBeGreaterThan(0)
    // `WebOriginPolicy` reads a request with no `Origin` header as `Native` and
    // allows it, so the binding is only real if the browser actually sends one
    // every time. The mock refuses a mismatch, which is why reaching a ready
    // panel at all already proves this — the assertion records what was proved.
    expect(authenticated.every((request) => request.origin === extensionOrigin)).toBe(true)
  })

  test("refuses an expired code without registering anything", async ({ panel, mockHost }) => {
    await pairThroughPanel(panel, mockHost.issueEnrollment({ expiresInMs: -1 }))

    await expect(panel.getByTestId("pair-failure")).toContainText(/expired/i)
    expect(mockHost.devices()).toEqual([])
    // And nothing was sent: the code is decoded before a key is generated, so
    // a dead code does not leave an orphaned identity behind either.
    expect(mockHost.requests()).toEqual([])
  })

  test("spends a code once, so a copied one is not a shared one", async ({ panel, mockHost }) => {
    const code = mockHost.issueEnrollment()
    await pairThroughPanel(panel, code)
    await expect(panel.getByTestId("capture-empty")).toBeVisible()

    // A second browser profile cannot exist inside one persistent context, so
    // the second attempt is this panel disconnecting and redeeming the same
    // code again — which is exactly what a user pasting a copy would do.
    await panel.getByTestId("disconnect").click()
    await expect(panel.getByLabel("Paste the pairing code")).toBeVisible()
    await pairThroughPanel(panel, code)

    await expect(panel.getByTestId("pair-failure")).toBeVisible()
    expect(mockHost.devices()).toHaveLength(1)
  })

  test("keeps the secret out of storage and unreadable in the database", async ({
    panel,
    mockHost,
    serviceWorker,
  }) => {
    await pairThroughPanel(panel, mockHost.issueEnrollment())
    await expect(panel.getByTestId("capture-empty")).toBeVisible()

    const stored = await serviceWorker.evaluate(() => chrome.storage.local.get(null))
    // Exactly two keys, and `lastWorkspaceId` is deliberately not among them:
    // the workspace choice is written when a submission uses it, not when the
    // panel picks a default nobody has confirmed.
    expect(Object.keys(stored).sort()).toEqual(
      [STORAGE_KEYS.appearance, STORAGE_KEYS.pairing].sort()
    )
    const serialized = JSON.stringify(stored)
    // Nothing token-shaped, nothing key-shaped. Access tokens live in memory
    // for five minutes; the private key lives somewhere it cannot be read at
    // all, which the next assertion proves rather than assumes.
    expect(serialized).not.toContain("BEGIN PRIVATE KEY")
    expect(serialized).not.toContain('"d":')
    expect(serialized).not.toMatch(/Bearer /)

    const keyState = await panel.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("cognia-companion", 1)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const key = await new Promise<CryptoKey | undefined>((resolve, reject) => {
        const request = db
          .transaction("device-keys", "readonly")
          .objectStore("device-keys")
          .get("device")
        request.onsuccess = () => resolve(request.result as CryptoKey | undefined)
        request.onerror = () => reject(request.error)
      })
      db.close()
      if (!key) return { present: false }
      let exportError: string | null = null
      try {
        await crypto.subtle.exportKey("jwk", key)
      } catch (error) {
        exportError = error instanceof Error ? error.name : String(error)
      }
      // Signing must still work — an unreadable key that cannot sign is just a
      // broken one.
      const signature = await crypto.subtle
        .sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode("probe"))
        .then((bytes) => bytes.byteLength)
        .catch(() => -1)
      return { present: true, extractable: key.extractable, exportError, signature }
    })

    // This is the assertion the unit suite cannot make: `fake-indexeddb`
    // structured-clones a `CryptoKey` down to `{}`, so in jsdom there is no key
    // to interrogate and `extractable` is not observable at all.
    expect(keyState).toEqual({
      present: true,
      extractable: false,
      exportError: "InvalidAccessError",
      signature: 64,
    })
  })

  test("tells a revoked browser from an unreachable one", async ({ panel, mockHost }) => {
    await pairThroughPanel(panel, mockHost.issueEnrollment())
    await expect(panel.getByTestId("capture-empty")).toBeVisible()

    mockHost.setUnreachable(true)
    await panel.reload()
    // Recoverable: the pairing is still good and the remedy is to start Cognia,
    // so the panel offers to retry rather than to pair again.
    await expect(panel.getByTestId("panel-offline")).toBeVisible()

    mockHost.setUnreachable(false)
    mockHost.revokeDevices()
    await panel.getByRole("button", { name: "Try again" }).click()
    // Terminal: only a new pairing fixes it, so the panel says so instead of
    // offering a retry that can only fail.
    await expect(panel.getByTestId("panel-revoked")).toBeVisible()
  })
})

test.describe("a Host this build cannot speak to", () => {
  test.use({ hostSchemaVersion: 2 })

  test("is named as a version problem, not as a failure", async ({ panel, mockHost }) => {
    await pairThroughPanel(panel, mockHost.issueEnrollment())
    // Pairing succeeds — the device is real — and the capability answer is what
    // this build cannot act on. Collapsing the two would send the user to
    // re-pair, which cannot help.
    await expect(panel.getByTestId("panel-incompatible")).toBeVisible()
    expect(mockHost.devices()).toHaveLength(1)
  })
})
