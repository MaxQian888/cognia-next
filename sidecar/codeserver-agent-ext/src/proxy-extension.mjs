import * as vscode from "vscode"

const BROKER_EXTENSION_ID = "cognia.cognia-managed-broker"

export async function activate(context) {
  const descriptor = context.extension.packageJSON?.cogniaManaged
  if (!descriptor || typeof descriptor.pluginId !== "string") {
    throw new Error("IDE_PROXY_DESCRIPTOR_INVALID: missing cogniaManaged metadata")
  }
  const brokerExtension = vscode.extensions.getExtension(BROKER_EXTENSION_ID)
  if (!brokerExtension) {
    throw new Error("IDE_BROKER_EXTENSION_MISSING")
  }
  const broker = brokerExtension.isActive
    ? brokerExtension.exports
    : await brokerExtension.activate()
  if (!broker || typeof broker.registerProxy !== "function") {
    throw new Error("IDE_BROKER_API_INCOMPATIBLE")
  }
  return broker.registerProxy(context, descriptor)
}

export function deactivate() {}
