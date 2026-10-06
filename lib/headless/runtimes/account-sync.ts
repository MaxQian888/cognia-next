/**
 * Account sync on the brain (ADR-0215 phase 3a): once the host is enrolled
 * from its terminal (`cognia-agent account-sync …`), run the data engine on
 * the brain's own database. Inert unless the serve process passed
 * `ctx.accountSync` (account sync on, `cli/src/serve/serve-command.ts`).
 */

import { startHeadlessAccountSync } from "@/lib/account-sync/data/headless-host"
import { ownAccountDatabase } from "@/lib/account-sync/data/own-database"

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "account-sync",
  hosts: ["brain"],
  start: (ctx) => {
    const host = ctx.accountSync
    if (!host) return
    const sync = startHeadlessAccountSync({
      host,
      db: () => ownAccountDatabase(ctx.localAccountId),
      log: (level, message) => ctx.log(level, message),
    })
    return () => sync.stop()
  },
})
