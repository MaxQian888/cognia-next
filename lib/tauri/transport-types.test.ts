import { WebStubTransport } from "./transport-web"
import { transportCommandTimeoutMs, type Transport } from "./transport-types"

it("extends code-server startup without changing other command deadlines", () => {
  expect(transportCommandTimeoutMs("codeserver_ensure")).toBe(300_000)
  expect(transportCommandTimeoutMs("codeserver_status")).toBe(30_000)
  expect(transportCommandTimeoutMs("codeserver_stop")).toBe(30_000)
  expect(transportCommandTimeoutMs("claude_send")).toBe(30_000)
})

it.each([
  ["video_get_info", 90_000],
  ["plugin_media_get_video_frame", 180_000],
  ["video_analyze", 660_000],
  ["video_trim", 1_260_000],
  ["plugin_media_concatenate_videos", 3_300_000],
  ["plugin_media_export_video", 3_300_000],
  ["plugin_media_add_transition", 90_000],
  ["plugin_media_read_chunk", 30_000],
  ["plugin_media_close_transfer", 30_000],
  ["video_cleanup_analysis", 30_000],
])("allows %s to complete within its native processing budget", (command, deadline) => {
  expect(transportCommandTimeoutMs(command)).toBe(deadline)
})

it("keeps concrete transports on the asynchronous, idempotent public contract", async () => {
  const transport: Transport = new WebStubTransport()
  const call = transport.call("contract_probe", {}, { idempotencyKey: "probe-1" })

  expect(call).toBeInstanceOf(Promise)
  await expect(call).rejects.toThrow("contract_probe")

  const unsubscribe = transport.subscribe("contract:event", () => {})
  expect(() => {
    unsubscribe()
    unsubscribe()
  }).not.toThrow()
})
