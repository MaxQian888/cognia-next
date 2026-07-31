/** Remote-host managed IDE broker consumer. */

import { transport } from "@/lib/tauri"
import { CompanionTransport } from "@/lib/tauri/transport-companion"

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "managed-ide-broker",
  hosts: ["brain"],
  start: async () => {
    const {
      attachManagedIdeBrokerTransport,
      createManagedIdeBrokerDependencies,
      ManagedIdeBrokerRuntime,
    } = await import("@/lib/plugin/ide/broker-runtime")
    if (!(transport instanceof CompanionTransport)) {
      throw new Error("managed-ide-broker requires the headless companion transport")
    }
    const companionTransport = transport as CompanionTransport
    const defaults = createManagedIdeBrokerDependencies()
    const runtime = new ManagedIdeBrokerRuntime({
      ...defaults,
      expectedHostId: process.env.COGNIA_HOST_ID ?? "headless",
      createContent: (root, generation, pluginId, providerId, permission, bytes) =>
        companionTransport.uploadManagedIdeContent(
          {
            root,
            generation,
            pluginId,
            providerId,
            permission,
            mediaType: "application/octet-stream",
          },
          bytes
        ),
      redeemContent: (root, generation, pluginId, providerId, permission, handleId) =>
        companionTransport.redeemManagedIdeContent(
          {
            root,
            generation,
            pluginId,
            providerId,
            permission,
          },
          handleId
        ),
    })
    return attachManagedIdeBrokerTransport(companionTransport, runtime)
  },
})
