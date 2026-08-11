import { registerNodeExecutor } from "../registry"

// ── action.approval.request ───────────────────────────────────────────────
// Human-in-the-loop gate (ADR 0061 P2): blocks on the wake bus until a
// desktop notification action or a paired device resolves it, then routes
// via `approved` / `rejected` decision handles. Logic in ./actions/approval.
// Not retryable — a retry would re-ask an already-answered question.
registerNodeExecutor({
  kind: "action.approval.request",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("../actions/approval")).runApprovalRequest(ctx),
})

// ── action.mobile.* (ADR 0061 P3) ─────────────────────────────────────────
// Hub-side proxies: pick a capable paired device and dispatch through the
// remote-step broker. Not retryable — most open interactive native UI on
// the phone; a retry would re-prompt the human.
registerNodeExecutor({
  kind: "action.mobile.camera",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("../actions/mobile")).runMobileCamera(ctx),
})

registerNodeExecutor({
  kind: "action.mobile.scanBarcode",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("../actions/mobile")).runMobileScanBarcode(ctx),
})

registerNodeExecutor({
  kind: "action.mobile.location",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("../actions/mobile")).runMobileLocation(ctx),
})

registerNodeExecutor({
  kind: "action.mobile.share",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("../actions/mobile")).runMobileShare(ctx),
})

registerNodeExecutor({
  kind: "action.mobile.notify",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("../actions/mobile")).runMobileNotify(ctx),
})
