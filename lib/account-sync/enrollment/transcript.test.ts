import { approvalTranscript } from "./transcript"

describe("approvalTranscript", () => {
  it("keeps exactly the fields the code binds", () => {
    const fields = {
      spaceId: "s",
      genesisHash: "g",
      requestId: "r",
      deviceId: "d",
      platform: "web" as const,
      signPub: "S",
      encPub: "E",
      commit: "C",
      approverDeviceId: "a",
    }
    expect(approvalTranscript({ ...fields, extra: 1 } as typeof fields)).toEqual(fields)
  })
})
