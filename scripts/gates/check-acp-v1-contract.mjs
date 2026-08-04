#!/usr/bin/env node

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import { ACP_V1_CONTRACT, validateAcpV1Coverage } from "./lib/acp-v1-contract.mjs"

const metaPath = new URL("../../protocol/acp/v1/meta.json", import.meta.url)
const acpClientSource = readFileSync(
  new URL("../../lib/ai/agent/external/acp-client.ts", import.meta.url),
  "utf8"
)
const jsonRpcPeerSource = readFileSync(
  new URL("../../lib/ai/agent/external/json-rpc-peer.ts", import.meta.url),
  "utf8"
)
const serverHandlerSource = readFileSync(
  new URL("../../src-tauri/src/companion_api/acp/handler.rs", import.meta.url),
  "utf8"
)
const packageManifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
)
const metaBytes = readFileSync(metaPath)
const metaSha256 = createHash("sha256").update(metaBytes).digest("hex")

if (packageManifest.dependencies?.[ACP_V1_CONTRACT.sdk.package] !== ACP_V1_CONTRACT.sdk.version) {
  throw new Error(
    `ACP SDK version drift: expected ${ACP_V1_CONTRACT.sdk.version}, received ${packageManifest.dependencies?.[ACP_V1_CONTRACT.sdk.package] ?? "missing"}`
  )
}

if (metaSha256 !== ACP_V1_CONTRACT.schema.metaSha256) {
  throw new Error(
    `ACP v1 meta checksum drift: expected ${ACP_V1_CONTRACT.schema.metaSha256}, received ${metaSha256}`
  )
}

function implemented(expected, ...sources) {
  return expected.filter((value) => sources.some((source) => source.includes(`"${value}"`)))
}

const coverage = {
  clientToAgent: implemented(
    ACP_V1_CONTRACT.stable.clientToAgent,
    acpClientSource,
    serverHandlerSource
  ),
  agentToClient: implemented(ACP_V1_CONTRACT.stable.agentToClient, acpClientSource),
  protocol: implemented(ACP_V1_CONTRACT.stable.protocol, jsonRpcPeerSource, serverHandlerSource),
  updates: implemented(ACP_V1_CONTRACT.stable.updates, acpClientSource),
}
const result = validateAcpV1Coverage(coverage)

if (!result.complete) {
  throw new Error(`ACP v1 contract drift: ${JSON.stringify(result.missing)}`)
}

if (ACP_V1_CONTRACT.reserved.v2.advertised) {
  throw new Error("ACP v2 must not be advertised while the protocol is Draft")
}

console.log(
  `ACP v1 contract OK (schema ${ACP_V1_CONTRACT.schema.version}, SDK ${ACP_V1_CONTRACT.sdk.version})`
)
