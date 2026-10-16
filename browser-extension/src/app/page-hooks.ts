// Injected into a tab's MAIN world by the agent executor (ADR-0228 §6). The
// real module rather than WXT's `#imports`, like the background entry.
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script"

import { installPageHooks } from "@ext/src/lib/agent/page-hooks"

export default defineUnlistedScript(() => {
  installPageHooks(window as unknown as Parameters<typeof installPageHooks>[0])
})
