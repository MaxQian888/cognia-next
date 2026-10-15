/**
 * Headless registration for the host provider-key overlay (ADR-0224 A6).
 *
 * A brain runs scheduled tasks and Bots with nobody at it, and its settings
 * carry no provider keys (they are `desktop-only` and never sync). A paired
 * owner device seals keys on the host instead; this runtime loads them into
 * the overlay `createProviderSettingsSnapshot` reads, and reloads them on
 * `host://secrets-changed`. Registered ahead of the boot-initializer batch,
 * and the start waits for the first load, so the scheduler's first run
 * already sees them.
 */

import {
  defaultHostProviderKeyDeps,
  installHostProviderKeys,
} from "@/lib/host-secrets/provider-key-overlay"

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "host-provider-keys",
  criticality: "required",
  hosts: ["brain"],
  start: async (ctx) => {
    const deps = defaultHostProviderKeyDeps()
    if (!deps) {
      ctx.log("warn", "host provider keys: no host secret store in this process")
      return
    }
    const installed = installHostProviderKeys({ ...deps, log: ctx.log })
    await installed.ready
    return installed.stop
  },
})
