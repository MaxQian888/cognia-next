/**
 * Headless registration for the SFTP transfer queue's pump (ADR-0162).
 *
 * The queue is durable, so without a pump on the brain a transfer an agent
 * queues there is not lost, it simply never moves. That is the failure this
 * runtime exists to prevent: a row sitting at `queued` forever, on a host with
 * nobody watching a panel to notice.
 *
 * `requiresApproval` is false here, as it is on the desktop, and the reason is
 * the one written on the option itself: the interactive approval exists so a
 * REMOTE device asks a human at the host. The brain is that host, not a device
 * asking one, and there is no human at it to ask, so requiring an approval
 * would park every row with nobody able to release it. This does not widen
 * anything: a paired device's transfer is authorised on the way in, by
 * `authorize_capability("ssh.files")` and `authorize_approval` on the two
 * opens, before dispatch ever reaches the service. That gate is on the RPC
 * path and is untouched by what the brain does with its OWN queue.
 */

import { startSftpTransferPump } from "@/lib/sftp/transfer-queue"

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "sftp-transfer-pump",
  hosts: ["brain"],
  start: () => startSftpTransferPump({ requiresApproval: false }),
})
