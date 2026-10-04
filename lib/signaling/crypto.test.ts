/** @jest-environment jsdom */

import {
  StrictReplayWindow,
  buildRoomDescriptor,
  buildSubscribeProof,
  buildEnvelope,
  deriveDirectionKey,
  generateEcdhKeyPair,
  generateSigningKeyPair,
  verifyPeerSessionProof,
  verifySubscribeProof,
  verifyAndDecryptEnvelope,
} from "./crypto"

describe("signaling crypto", () => {
  it("derives a stable self-certifying room id from the role public keys", async () => {
    const descriptor = await buildRoomDescriptor({
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
      await buildRoomDescriptor({
        roomNonce: descriptor.roomNonce,
        desktopSigningKey: descriptor.desktopSigningKey,
        mobileSigningKey: descriptor.mobileSigningKey,
        notAfter: descriptor.notAfter,
      })
    ).toEqual(descriptor)
  })

  it("binds a signed subscription to the challenge, role, session, epoch, and ECDH key", async () => {
    const desktopIdentity = await generateSigningKeyPair()
    const mobileIdentity = await generateSigningKeyPair()
    const mobileEcdh = await generateEcdhKeyPair()
    const descriptor = await buildRoomDescriptor({
      roomNonce: "AAECAwQFBgcICQoLDA0ODw",
      desktopSigningKey: desktopIdentity.encodedPublicKey,
      mobileSigningKey: mobileIdentity.encodedPublicKey,
      notAfter: 1_800_000_000_000,
    })
    const proof = await buildSubscribeProof({
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
      verifySubscribeProof(descriptor, proof, {
        expectedChallenge: "server-challenge",
        nowMs: 1_700_000_000_000,
      })
    ).resolves.toBeUndefined()
    await expect(
      verifySubscribeProof(
        descriptor,
        { ...proof, role: "desktop" },
        {
          expectedChallenge: "server-challenge",
          nowMs: 1_700_000_000_000,
        }
      )
    ).rejects.toThrow(/signature/i)
    await expect(
      verifySubscribeProof(descriptor, proof, {
        expectedChallenge: "other-challenge",
        nowMs: 1_700_000_000_000,
      })
    ).rejects.toThrow(/challenge/i)
  })

  it("accepts a peer's long-lived proof but still refuses a future one or an expired room", async () => {
    const desktopIdentity = await generateSigningKeyPair()
    const mobileIdentity = await generateSigningKeyPair()
    const desktopEcdh = await generateEcdhKeyPair()
    const descriptor = await buildRoomDescriptor({
      roomNonce: "AAECAwQFBgcICQoLDA0ODw",
      desktopSigningKey: desktopIdentity.encodedPublicKey,
      mobileSigningKey: mobileIdentity.encodedPublicKey,
      notAfter: 1_800_000_000_000,
    })
    const subscribedAt = 1_700_000_000_000
    const proof = await buildSubscribeProof({
      roomId: descriptor.roomId,
      role: "desktop",
      sessionId: "desktop-session",
      epoch: "desktop-epoch",
      issuedAt: subscribedAt,
      challenge: "relay-challenge",
      ecdhPublicKey: desktopEcdh.encodedPublicKey,
      signingPrivateKey: desktopIdentity.privateKey,
    })
    const anHourLater = subscribedAt + 60 * 60 * 1000

    // The relay forwards the proof the Host subscribed with; an hour in the
    // room must not make it unjoinable.
    await expect(
      verifyPeerSessionProof(descriptor, proof, { nowMs: anHourLater })
    ).resolves.toBeUndefined()
    // The same age is still refused at admission, where freshness is checked.
    await expect(
      verifySubscribeProof(descriptor, proof, {
        expectedChallenge: "relay-challenge",
        nowMs: anHourLater,
      })
    ).rejects.toThrow(/expired/i)
    await expect(
      verifyPeerSessionProof(descriptor, proof, { nowMs: subscribedAt - 10 * 60 * 1000 })
    ).rejects.toThrow(/expired/i)
    await expect(
      verifyPeerSessionProof(descriptor, proof, { nowMs: 1_800_000_000_000 + 10 * 60 * 1000 })
    ).rejects.toThrow(/expired/i)
  })

  it("encrypts, signs, verifies, and decrypts an envelope across independent peers", async () => {
    const senderIdentity = await generateSigningKeyPair()
    const senderEcdh = await generateEcdhKeyPair()
    const receiverEcdh = await generateEcdhKeyPair()
    const senderKey = await deriveDirectionKey({
      privateKey: senderEcdh.privateKey,
      peerPublicKey: receiverEcdh.publicKey,
      roomId: "room",
      senderRole: "mobile",
      epoch: "epoch-1",
    })
    const receiverKey = await deriveDirectionKey({
      privateKey: receiverEcdh.privateKey,
      peerPublicKey: senderEcdh.publicKey,
      roomId: "room",
      senderRole: "mobile",
      epoch: "epoch-1",
    })

    const envelope = await buildEnvelope({
      roomId: "room",
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
      verifyAndDecryptEnvelope(envelope, {
        expectedRoomId: "room",
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
    const identity = await generateSigningKeyPair()
    const senderEcdh = await generateEcdhKeyPair()
    const receiverEcdh = await generateEcdhKeyPair()
    const key = await deriveDirectionKey({
      privateKey: senderEcdh.privateKey,
      peerPublicKey: receiverEcdh.publicKey,
      roomId: "room",
      senderRole: "mobile",
      epoch: "epoch-1",
    })
    const envelope = await buildEnvelope({
      roomId: "room",
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
      verifyAndDecryptEnvelope(
        { ...envelope, senderRole: "desktop" },
        {
          expectedRoomId: "room",
          expectedSenderRole: "mobile",
          signingPublicKey: identity.publicKey,
          encryptionKey: key,
        }
      )
    ).rejects.toThrow(/sender role/i)
    await expect(
      verifyAndDecryptEnvelope(
        {
          ...envelope,
          ciphertext: `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`,
        },
        {
          expectedRoomId: "room",
          expectedSenderRole: "mobile",
          signingPublicKey: identity.publicKey,
          encryptionKey: key,
        }
      )
    ).rejects.toThrow(/signature|ciphertext/i)
  })

  it("retires old epochs and enforces strictly increasing sequence numbers", () => {
    const replay = new StrictReplayWindow()
    expect(replay.observe("epoch-a", 1, 1000)).toBe(true)
    expect(replay.observe("epoch-a", 1, 1001)).toBe(false)
    expect(replay.observe("epoch-a", 2, 1002)).toBe(true)
    expect(replay.observe("epoch-b", 1, 1003)).toBe(true)
    expect(replay.observe("epoch-a", 3, 1004)).toBe(false)
  })
})
