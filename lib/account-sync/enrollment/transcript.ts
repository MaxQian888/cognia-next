/**
 * The approval transcript (protocol §5.2, step 7). Each side builds it from
 * its OWN values: the new device from what it sent, the approver from what it
 * saw before it posted its nonce. Neither re-reads a field from the server.
 */

import type { DevicePlatform, SasTranscript } from "@cognia/sync-protocol"

export interface TranscriptFields {
  spaceId: string
  genesisHash: string
  requestId: string
  deviceId: string
  platform: DevicePlatform
  signPub: string
  encPub: string
  commit: string
  approverDeviceId: string
}

export function approvalTranscript(fields: TranscriptFields): SasTranscript {
  return {
    spaceId: fields.spaceId,
    genesisHash: fields.genesisHash,
    requestId: fields.requestId,
    deviceId: fields.deviceId,
    platform: fields.platform,
    signPub: fields.signPub,
    encPub: fields.encPub,
    commit: fields.commit,
    approverDeviceId: fields.approverDeviceId,
  }
}
