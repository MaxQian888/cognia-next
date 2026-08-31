/**
 * The artifact users install, in a real Chrome.
 *
 * Everything here is asserted against the **shipped** build, with no granted
 * host permission — which is what makes it the only place the extension's
 * install-time trust posture is proved. The loop specs load a variant
 * (`extension-profile.ts`), and a variant cannot answer "what does this ask
 * for when somebody installs it?".
 *
 * Nothing in this file may click the pairing button. On the shipped build that
 * reaches `chrome.permissions.request()`, which raises browser chrome
 * Playwright cannot click and never settles; the test would hang to its
 * timeout and read as a broken panel.
 */
import { grantedManifest, LOOPBACK_PATTERN, readShippedManifest } from "./extension-profile"
import { expect, test } from "./fixtures"

test.describe("the shipped extension", () => {
  test("is accepted by Chrome, and asks for exactly what it declares", async ({
    serviceWorker,
  }) => {
    // Chrome's own parse, not the file. A manifest key Chrome rejects or
    // silently drops is a key the JSON-level unit test would still see.
    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest())

    expect(manifest.permissions).toEqual([
      "sidePanel",
      "storage",
      "activeTab",
      "scripting",
      "contextMenus",
    ])
    // The absences are the point, and each is a specific decision:
    // `<all_urls>` would make "read and change all your data on all websites"
    // the install prompt; a static content script would run on pages nobody
    // asked about; `debugger` cannot be requested optionally at all.
    expect(manifest.host_permissions ?? []).toEqual([])
    expect(manifest.content_scripts ?? []).toEqual([])
    expect(manifest.optional_host_permissions).toEqual(["http://127.0.0.1/*"])
    expect(manifest.incognito).toBe("not_allowed")
    expect(JSON.stringify(manifest)).not.toContain("<all_urls>")
  })

  test("holds no host permission until somebody grants one", async ({ serviceWorker }) => {
    const granted = await serviceWorker.evaluate(() =>
      chrome.permissions.contains({ origins: ["http://127.0.0.1/*"] })
    )
    expect(granted).toBe(false)

    // And nothing wider was quietly acquired at install either.
    const all = await serviceWorker.evaluate(() => chrome.permissions.getAll())
    expect(all.origins ?? []).toEqual([])
  })

  test("opens on the pairing screen and warns about the prompt first", async ({ panel }) => {
    // The notice exists because Chrome's permission bubble names neither who
    // is asking nor what for. Saying it before the click is the difference
    // between an answerable dialog and an alarming one.
    await expect(panel.getByTestId("pair-permission-notice")).toBeVisible()
    await expect(panel.getByRole("button", { name: /grant access/i })).toBeVisible()
  })

  test("reports the origin the Host will bind it to", async ({ panel, extensionOrigin }) => {
    // The origin registered at pairing is replayed on every later request and
    // compared byte-for-byte, so "what does this extension call itself?" is a
    // contract, not a detail.
    //
    // It is derived from `getURL("/")` rather than from `new URL(...).origin`,
    // and this test records why the two are not interchangeable even though
    // Chrome makes them look it. `chrome-extension:` is not a special scheme
    // in the URL Standard, so a conformant parser gives it an *opaque* origin
    // that serializes to the literal text "null" — which is what jsdom returns
    // and therefore what the unit suite sees. Chrome registers the scheme as
    // standard and hands back a tuple origin instead, so both spellings agree
    // here. The runtime form is used because it is the one that does not
    // depend on that registration.
    const observed = await panel.evaluate(() => ({
      fromRuntime: chrome.runtime.getURL("/").replace(/\/+$/, ""),
      fromUrlApi: new URL(chrome.runtime.getURL("/")).origin,
    }))

    expect(observed.fromRuntime).toBe(extensionOrigin)
    expect(observed.fromRuntime).toMatch(/^chrome-extension:\/\/[a-p]{32}$/)
    expect(observed.fromUrlApi).toBe(extensionOrigin)
  })

  test("stores nothing before it is paired", async ({ serviceWorker }) => {
    const stored = await serviceWorker.evaluate(() => chrome.storage.local.get(null))
    expect(stored).toEqual({})
  })

  test("registers the capture command the manifest declares", async ({ serviceWorker }) => {
    // The keyboard command is one of the three gestures that grant
    // `activeTab`, and the only one with a readable registration — Chrome
    // exposes no way to enumerate context menus. If the manifest and the
    // worker's listener ever disagree, the shortcut silently does nothing.
    const { commands, manifest } = await serviceWorker.evaluate(async () => ({
      commands: await chrome.commands.getAll(),
      manifest: chrome.runtime.getManifest(),
    }))
    const capture = commands.find((command) => command.name === "capture-page")

    expect(capture).toBeDefined()
    // The accelerator is asserted on the manifest, not on the registration:
    // Chrome renders the bound shortcut per platform ("Alt+Shift+C" on Linux
    // and Windows, "\u2325\u21e7C" on macOS), so pinning the rendered string
    // would fail on whichever runner is not the one it was written on.
    expect(manifest.commands?.["capture-page"]?.suggested_key?.default).toBe("Alt+Shift+C")
    // `getAll()` returning the named command proves Chrome accepted the
    // registration. Its `shortcut` may legitimately be blank: Chrome leaves a
    // suggested key unbound when it conflicts with the browser, the OS, or
    // another extension. The active binding is user state, not an install-time
    // invariant, so the shipped-artifact contract must not require it.
    expect(capture?.name).toBe("capture-page")
  })

  test("its manifest on disk is the one Chrome loaded", async ({ serviceWorker }) => {
    // Guards against a spec that passes because it was run against a stale
    // `build/` while the source said something else entirely.
    const [onDisk, loaded] = await Promise.all([
      readShippedManifest(),
      serviceWorker.evaluate(() => chrome.runtime.getManifest()),
    ])
    expect(loaded.version).toBe(onDisk.version)
    expect(loaded.permissions).toEqual(onDisk.permissions)
    expect(loaded.optional_host_permissions).toEqual(onDisk.optional_host_permissions)
  })

  test("differs from the profile the loop specs load in exactly one way", async () => {
    // The loop specs cannot use this build: `chrome.permissions.request()`
    // raises browser chrome that Playwright cannot click and never settles.
    // They load a copy with the loopback pattern moved into `host_permissions`
    // instead — a deviation that is only acceptable while it stays this small,
    // so the diff is asserted rather than described.
    const shipped = await readShippedManifest()
    const granted = grantedManifest(shipped)

    const changed = [...new Set([...Object.keys(shipped), ...Object.keys(granted)])]
      .filter((key) => JSON.stringify(shipped[key]) !== JSON.stringify(granted[key]))
      .sort()
    expect(changed).toEqual(["host_permissions", "optional_host_permissions"])

    expect(granted.host_permissions).toEqual([LOOPBACK_PATTERN])
    // Gone, not emptied: the whole point is that Chrome grants it at install.
    expect(granted.optional_host_permissions).toBeUndefined()
    // And the permission set itself is untouched — a widened `permissions`
    // array would let the loop specs pass against an extension nobody could
    // ship.
    expect(granted.permissions).toEqual(shipped.permissions)
  })
})
