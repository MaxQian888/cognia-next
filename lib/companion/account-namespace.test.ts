import { readFileSync } from "node:fs"
import { join } from "node:path"

import { DEFAULT_ACCOUNT_NAMESPACE } from "./account-namespace"

describe("DEFAULT_ACCOUNT_NAMESPACE", () => {
  it("is the sentinel the wire format uses", () => {
    // Pinned as a literal because it travels over the companion event rail and
    // is persisted in credential-book rows; changing it silently orphans every
    // unclaimed pairing on disk.
    expect(DEFAULT_ACCOUNT_NAMESPACE).toBe("__local__")
  })

  it("matches the Rust sentinel that stamps the events", () => {
    // `host_identity::event_namespace_for_tenant` falls back to this string
    // when no account has been bound yet, and `event-bridge` adopts it into the
    // unlocked account. If the two spellings drift, every pre-unlock pairing is
    // rejected as an account mismatch — which is exactly the class of bug this
    // sentinel was introduced to fix.
    const store = readFileSync(
      join(__dirname, "../../src-tauri/src/companion_api/security_store.rs"),
      "utf8"
    )
    expect(store).toContain(
      `pub const LOCAL_NAMESPACE_UNBOUND: &str = "${DEFAULT_ACCOUNT_NAMESPACE}";`
    )
  })
})
