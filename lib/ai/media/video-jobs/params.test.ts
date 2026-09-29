import { checkVideoJobParams } from "./params"

describe("checkVideoJobParams", () => {
  it("accepts options the provider forwards", () => {
    expect(
      checkVideoJobParams(
        "google",
        "veo-3.1-generate-preview",
        { aspectRatio: "16:9", resolution: "1280x720", durationSec: 8, seed: 3 },
        false
      )
    ).toEqual({ ok: true })
  })

  it("refuses an option the provider's adapter would drop", () => {
    expect(checkVideoJobParams("qwen", "wan2.7-t2v", { aspectRatio: "16:9" }, false)).toMatchObject(
      { ok: false, field: "aspectRatio" }
    )
    expect(checkVideoJobParams("xai", "grok-imagine-video", { seed: 1 }, false)).toMatchObject({
      ok: false,
      field: "seed",
    })
    expect(
      checkVideoJobParams("fal", "luma-ray-2", { resolution: "1280x720" }, false)
    ).toMatchObject({ ok: false, field: "resolution" })
  })

  it("accepts fps only where the adapter forwards it", () => {
    expect(checkVideoJobParams("replicate", "minimax/video-01", { fps: 24 }, false)).toEqual({
      ok: true,
    })
    expect(checkVideoJobParams("google", "veo-3.0-generate-001", { fps: 24 }, false)).toMatchObject(
      { ok: false, field: "fps" }
    )
  })

  it("refuses malformed values", () => {
    expect(
      checkVideoJobParams("google", "veo-3.0-generate-001", { durationSec: 0 }, false)
    ).toMatchObject({
      field: "durationSec",
    })
    expect(
      checkVideoJobParams("google", "veo-3.0-generate-001", { seed: 1.5 }, false)
    ).toMatchObject({
      field: "seed",
    })
    expect(
      checkVideoJobParams("google", "veo-3.0-generate-001", { resolution: "HD" as never }, false)
    ).toMatchObject({ field: "resolution" })
  })

  it("enforces the model's start-frame mode", () => {
    expect(checkVideoJobParams("qwen", "wan2.6-i2v", {}, false)).toMatchObject({
      field: "startFrame",
    })
    expect(checkVideoJobParams("qwen", "wan2.7-t2v", {}, true)).toMatchObject({
      field: "startFrame",
    })
    expect(checkVideoJobParams("qwen", "wan2.6-i2v", {}, true)).toEqual({ ok: true })
  })
})
