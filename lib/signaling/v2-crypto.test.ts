/** @jest-environment jsdom */

import {
  StrictReplayWindowV2,
  buildRoomDescriptorV2,
  buildSubscribeProofV2,
  buildV2Envelope,
  deriveV2DirectionKey,
  generateV2EcdhKeyPair,
  generateV2SigningKeyPair,
  verifySubscribeProofV2,
  verifyAndDecryptV2Envelope,
} from "./v2-crypto"

describe("signaling v2 crypto", () => {
  it("derives a stable self-certifying room id from the role public keys", async () => {
    const descriptor = await buildRoomDescriptorV2({
      roomNonce: "AAECAwQFBgcICQoLDA0ODw",
      desktopSigningKey:
        "BG_wO5SSQc4drdQ1GeaWDgqFtBppoFwygQOqK84VlMoWPE91OlW_AdxT9sCwx-7ni0DG_30lqW4igrmJzvccFEo",
      mobileSigningKey:
        "BFUPRxAD89-Xw99QaseX9nIfsaH7e49vg9IkSYplyI4kE2CT1wEuUJpzcVy9CwCjzA_0tcAbP_oZarH7MnA2uOY",
      notAfter: 1_800_000_000_000,
    })

    expect(descriptor.v).toBe(2)
    expect(descriptor.roomId).toBe("Yqb8u27ftwZjP7sGIEESUSotgIEBjEBkPNAj5hLk_ic")
    expect(
      await buildRoomDescriptorV2({
        roomNonce: descriptor.roomNonce,
        desktopSigningKey: descriptor.desktopSigningKey,
        mobileSigningKey: descriptor.mobileSigningKey,
        notAfter: descriptor.notAfter,
      })
    ).toEqual(descriptor)
  })

  it("binds a signed subscription to the challenge, role, session, epoch, and ECDH key", async () => {
    const desktopIdentity = await generateV2SigningKeyPair()
    const mobileIdentity = await generateV2SigningKeyPair()
    const mobileEcdh = await generateV2EcdhKeyPair()
    const descriptor = await buildRoomDescriptorV2({
      roomNonce: "AAECAwQFBgcICQoLDA0ODw",
      desktopSigningKey: desktopIdentity.encodedPublicKey,
      mobileSigningKey: mobileIdentity.encodedPublicKey,
      notAfter: 1_800_000_000_000,
    })
    const proof = await buildSubscribeProofV2({
      roomId: descriptor.roomId,
      role: "mobile",
      sessionId: "mobile-session",
      epoch: "mobile-epoch",
      issuedAt: 1_700_000_000_000,
      challenge: "server-challenge",
      ecdhPublicKey: mobileEcdh.encodedPublicKey,
      signingPrivateKey: mobileIdentity.privateKey,
    })

    await expect(
      verifySubscribeProofV2(descriptor, proof, {
        expectedChallenge: "server-challenge",
        nowMs: 1_700_000_000_000,
      })
    ).resolves.toBeUndefined()
    await expect(
      verifySubscribeProofV2(
        descriptor,
        { ...proof, role: "desktop" },
        {
          expectedChallenge: "server-challenge",
          nowMs: 1_700_000_000_000,
        }
      )
    ).rejects.toThrow(/signature/i)
    await expect(
      verifySubscribeProofV2(descriptor, proof, {
        expectedChallenge: "other-challenge",
        nowMs: 1_700_000_000_000,
      })
    ).rejects.toThrow(/challenge/i)
  })

  it("encrypts, signs, verifies, and decrypts an envelope across independent peers", async () => {
    const senderIdentity = await generateV2SigningKeyPair()
    const senderEcdh = await generateV2EcdhKeyPair()
    const receiverEcdh = await generateV2EcdhKeyPair()
    const senderKey = await deriveV2DirectionKey({
      privateKey: senderEcdh.privateKey,
      peerPublicKey: receiverEcdh.publicKey,
      roomId: "room-v2",
      senderRole: "mobile",
      epoch: "epoch-1",
    })
    const receiverKey = await deriveV2DirectionKey({
      privateKey: receiverEcdh.privateKey,
      peerPublicKey: senderEcdh.publicKey,
      roomId: "room-v2",
      senderRole: "mobile",
      epoch: "epoch-1",
    })

    const envelope = await buildV2Envelope({
      roomId: "room-v2",
      senderRole: "mobile",
      sessionId: "session-1",
      epoch: "epoch-1",
      seq: 1,
      issuedAt: 1_700_000_000_000,
      kind: "rtc:offer",
      body: { sdp: "v=0\r\nsecret-candidate" },
      signingPrivateKey: senderIdentity.privateKey,
      encryptionKey: senderKey,
    })

    expect(JSON.stringify(envelope)).not.toContain("secret-candidate")
    await expect(
      verifyAndDecryptV2Envelope(envelope, {
        expectedRoomId: "room-v2",
        expectedSenderRole: "mobile",
        signingPublicKey: senderIdentity.publicKey,
        encryptionKey: receiverKey,
        nowMs: 1_700_000_000_000,
      })
    ).resolves.toEqual({
      kind: "rtc:offer",
      body: { sdp: "v=0\r\nsecret-candidate" },
    })
  })

  it("rejects ciphertext or sender-role tampering", async () => {
    const identity = await generateV2SigningKeyPair()
    const senderEcdh = await generateV2EcdhKeyPair()
    const receiverEcdh = await generateV2EcdhKeyPair()
    const key = await deriveV2DirectionKey({
      privateKey: senderEcdh.privateKey,
      peerPublicKey: receiverEcdh.publicKey,
      roomId: "room-v2",
      senderRole: "mobile",
      epoch: "epoch-1",
    })
    const envelope = await buildV2Envelope({
      roomId: "room-v2",
      senderRole: "mobile",
      sessionId: "session-1",
      epoch: "epoch-1",
      seq: 1,
      issuedAt: Date.now(),
      kind: "rtc:ice",
      body: { candidate: "private" },
      signingPrivateKey: identity.privateKey,
      encryptionKey: key,
    })

    await expect(
      verifyAndDecryptV2Envelope(
        { ...envelope, senderRole: "desktop" },
        {
          expectedRoomId: "room-v2",
          expectedSenderRole: "mobile",
          signingPublicKey: identity.publicKey,
          encryptionKey: key,
        }
      )
    ).rejects.toThrow(/sender role/i)
    await expect(
      verifyAndDecryptV2Envelope(
        {
          ...envelope,
          ciphertext: `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`,
        },
        {
          expectedRoomId: "room-v2",
          expectedSenderRole: "mobile",
          signingPublicKey: identity.publicKey,
          encryptionKey: key,
        }
      )
    ).rejects.toThrow(/signature|ciphertext/i)
  })

  it("retires old epochs and enforces strictly increasing sequence numbers", () => {
    const replay = new StrictReplayWindowV2()
    expect(replay.observe("epoch-a", 1, 1000)).toBe(true)
    expect(replay.observe("epoch-a", 1, 1001)).toBe(false)
    expect(replay.observe("epoch-a", 2, 1002)).toBe(true)
    expect(replay.observe("epoch-b", 1, 1003)).toBe(true)
    expect(replay.observe("epoch-a", 3, 1004)).toBe(false)
  })
})
