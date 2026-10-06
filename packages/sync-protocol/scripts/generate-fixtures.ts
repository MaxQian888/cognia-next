/**
 * Writes fixtures/v1.json: frozen Account Sync Protocol v1 vectors. They pin
 * the wire format: hashes, labels, codes and signed chains already stored on
 * a sync server must keep verifying after any refactor. `src/fixtures.test.ts`
 * checks the current code against them.
 *
 * Do NOT rerun this to make a failing fixtures test pass: a mismatch means the
 * protocol changed, which needs a new version (v2), not new v1 vectors.
 *
 *   pnpm exec tsx packages/sync-protocol/scripts/generate-fixtures.ts
 */

// static-export-exempt: manual Node fixture writer, outside package src exports and app imports.
import { writeFileSync } from "node:fs"
import path from "node:path" // static-export-exempt: manual Node fixture writer resolves its output path; not shipped to clients.
import { fileURLToPath } from "node:url" // static-export-exempt: manual Node fixture writer locates its script directory; not shipped to clients.

import { concatBytes, toBase64Url, utf8 } from "../src/bytes"
import { formatRecoveryKey } from "../src/crockford"
import { bodyDigest, createDeviceProof } from "../src/device-proof"
import { keyCommitment, sealDeviceName, wrapPreviousKey } from "../src/epoch"
import { spaceIdFor } from "../src/ids"
import { entryHash } from "../src/registry/encode"
import { listActiveDevices } from "../src/registry/validate-append"
import { sasCode, sasCommit, transcriptHash, type SasTranscript } from "../src/sas"
import { ChainBuilder, makeDevice, makeRecovery } from "../src/testing/chain"

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "v1.json")
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")
const counting = (length: number, start = 0) =>
  Uint8Array.from({ length }, (_, i) => (start + i) & 0xff)

async function main() {
  const spaceId = await spaceIdFor(
    "https://id.cognia.cn/api/auth",
    "usr_01JZ8Q6W3X0000000000000000"
  )

  const crockford = [
    counting(16),
    new Uint8Array(16),
    new Uint8Array(16).fill(0xff),
    counting(16, 0xa0),
  ].map((bytes) => ({ hex: hex(bytes), text: formatRecoveryKey(bytes) }))

  const spaceIds = await Promise.all(
    [
      ["https://id.cognia.cn/api/auth", "usr_01JZ8Q6W3X0000000000000000"],
      ["https://id-staging.cognia.cn/api/auth", "usr_01JZ8Q6W3X0000000000000000"],
      ["https://id.example.org/api/auth", "usr_01JZ8Q6W3X0000000000000001"],
    ].map(async ([issuer, subject]) => ({
      issuer,
      subject,
      spaceId: await spaceIdFor(issuer!, subject!),
    }))
  )

  const nonceR = counting(32, 1)
  const nonceA = counting(32, 101)
  const commit = await sasCommit(nonceR)
  const transcript: SasTranscript = {
    spaceId,
    genesisHash: toBase64Url(counting(32, 7)),
    requestId: "req_01JZ8Q6W3X0000000000000000",
    deviceId: "dev_01JZ8Q6W3X0000000000000001",
    platform: "mobile",
    signPub: toBase64Url(concatBytes(new Uint8Array([4]), counting(64, 9))),
    encPub: toBase64Url(concatBytes(new Uint8Array([4]), counting(64, 77))),
    commit,
    approverDeviceId: "dev_01JZ8Q6W3X0000000000000000",
  }
  const sas = {
    nonceR: hex(nonceR),
    nonceA: hex(nonceA),
    commit,
    transcript,
    transcriptHash: await transcriptHash(transcript),
    code: await sasCode(nonceR, nonceA, transcript),
  }

  const epochKey = counting(32, 200)
  const previousKey = counting(32, 50)
  const epoch = {
    spaceId,
    epoch: 4,
    key: hex(epochKey),
    keyCommit: await keyCommitment(epochKey, spaceId, 4),
    previousKey: hex(previousKey),
    prevWrap: await wrapPreviousKey(epochKey, previousKey, spaceId, 4),
    deviceId: "dev_01JZ8Q6W3X0000000000000001",
    name: "Pixel 9 · 工作",
    nameCt: await sealDeviceName(
      epochKey,
      spaceId,
      "dev_01JZ8Q6W3X0000000000000001",
      4,
      "Pixel 9 · 工作"
    ),
  }

  const proofDevice = await makeDevice("Proof")
  const body = utf8('{"hello":"sync"}')
  const iat = 1_760_000_000_000
  const deviceProof = {
    signPub: proofDevice.signPub,
    body: '{"hello":"sync"}',
    bodySha256: await bodyDigest(body),
    request: { spaceId, method: "POST", path: "/v1/registry?after=3", now: iat + 30_000 },
    header: await createDeviceProof(
      {
        v: 1,
        spaceId,
        deviceId: proofDevice.deviceId,
        method: "POST",
        path: "/v1/registry?after=3",
        bodySha256: await bodyDigest(body),
        iat,
      },
      proofDevice.sign.privateKey
    ),
  }

  // A chain through every entry type.
  const first = await makeDevice("MacBook", "desktop")
  const recovery = await makeRecovery()
  const chain = await ChainBuilder.genesis(spaceId, first, recovery)
  const second = await makeDevice("Chrome", "web")
  await chain.addByApproval(first, second, {
    requestId: transcript.requestId,
    transcriptHash: sas.transcriptHash,
  })
  const phone = await makeDevice("Pixel", "mobile")
  await chain.addByRecovery(recovery, phone)
  await chain.revoke(phone, second.deviceId)
  await chain.rotateRecovery(first, await makeRecovery())
  await chain.rotateEpoch(first)
  const entries = chain.entries
  const hashes = await Promise.all(entries.map((signed) => entryHash(signed.entry)))
  const pin = (seq: number) => ({ genesisHash: hashes[0]!, seq, hash: hashes[seq]!, epoch: 1 })

  const tampered = JSON.parse(JSON.stringify(entries))
  tampered[1].entry.device.platform = "desktop"

  const registry = {
    spaceId,
    epochKeys: Object.fromEntries([...chain.epochKeys].map(([e, key]) => [e, hex(key)])),
    entries,
    expected: {
      hashes,
      genesisHash: chain.state.genesisHash,
      head: chain.state.head,
      epoch: chain.state.epoch,
      recovery: chain.state.recovery,
      active: listActiveDevices(chain.state).map((device) => device.deviceId),
      revoked: [second.deviceId],
      names: {
        [first.deviceId]: "MacBook",
        [second.deviceId]: "Chrome",
        [phone.deviceId]: "Pixel",
      },
    },
    invalid: [
      {
        name: "truncated below the pin",
        elements: entries.slice(0, 4),
        pin: pin(5),
        code: "rollback",
      },
      { name: "empty after a pin", elements: [], pin: pin(2), code: "rollback" },
      {
        name: "differs at the pinned position",
        elements: entries,
        pin: { ...pin(3), hash: hashes[2]! },
        code: "fork",
      },
      {
        name: "another genesis",
        elements: entries,
        pin: { ...pin(0), genesisHash: hashes[1]! },
        code: "fork",
      },
      { name: "edited after signing", elements: tampered, code: "bad_signature" },
      {
        name: "entries swapped",
        elements: [entries[0], entries[2], entries[1], ...entries.slice(3)],
        code: "bad_link",
      },
      { name: "missing genesis", elements: entries.slice(1), code: "bad_genesis" },
      {
        name: "ends inside the recovery batch",
        elements: entries.slice(0, 3),
        code: "incomplete_batch",
      },
    ],
  }

  const fixtures = {
    "//": "Account Sync Protocol v1 vectors. Frozen: never regenerate to fix a test (see scripts/generate-fixtures.ts).",
    crockford,
    spaceIds,
    sas,
    epoch,
    deviceProof,
    registry,
  }
  writeFileSync(OUT, `${JSON.stringify(fixtures, null, 2)}\n`)
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`)
}

await main()
