import { extractMediaPackZip, importMediaPack, MediaPackImportError } from "./import"
import JSZip from "jszip"

const webm = () => new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1])], { type: "video/webm" })
const webp = () => new Blob(["RIFF", new Uint8Array(4), "WEBPVP8 "], { type: "image/webp" })
const config = (value: unknown, path = "assets/config.jsonc") => ({
  path,
  blob: new Blob([JSON.stringify(value)]),
})

it("imports DSH JSONC animation/state pools without retaining plugin or credential fields", async () => {
  const pack = await importMediaPack([
    {
      path: "assets/config.jsonc",
      blob: new Blob([
        '{// comment\n"pets":[{"name":"大肥鱼"}],"apiKey":"secret","animations":{"idle":["站立"],"drag":["悬空"],"events":{"workStatus":["思考","工作","整理","等待","完成","错误"]}},}',
      ]),
    },
    ...["站立", "悬空", "思考", "工作", "整理", "等待", "完成", "错误"].map((name) => ({
      path: `assets/webm/${name}.webm`,
      blob: webm(),
    })),
    { path: "plugin.js", blob: new Blob(["throw new Error('must not execute')"]) },
  ])
  expect(pack.manifest.displayName).toBe("大肥鱼")
  expect(pack.manifest.states.thinking).toEqual(["思考"])
  expect(pack.manifest.states.waiting).toEqual(["等待"])
  expect(pack.manifest.states.held).toEqual(["悬空"])
  expect(pack.entries).toHaveLength(8)
  expect(JSON.stringify(pack.manifest)).not.toContain("secret")
})

it("imports the frame manifest's order, timing, loop and state mapping", async () => {
  const pack = await importMediaPack([
    config(
      {
        formatVersion: 1,
        characterId: "whaletail-maid",
        maxFrameWidth: 412,
        maxFrameHeight: 344,
        clips: {
          idle: { frames: ["idle/02.webp", "idle/01.webp"], frameMs: 42, loop: true },
          success: { frames: ["ok/01.webp"], frameMs: 60, loop: false },
        },
        stateMap: { IDLE: "idle", SUCCESS: "success" },
      },
      "assets/pet-manifest.json"
    ),
    ...["idle/01.webp", "idle/02.webp", "ok/01.webp"].map((path) => ({
      path: `assets/pet/${path}`,
      blob: webp(),
    })),
  ])
  expect(pack.manifest.clips.idle).toEqual({
    kind: "frames",
    frames: ["assets/pet/idle/02.webp", "assets/pet/idle/01.webp"],
    frameMs: 42,
    loop: true,
  })
  expect(pack.manifest.states.happy).toEqual(["success"])
})

it.each(["../secret.webp", "/absolute.webp", "https://evil/frame.webp", "C:\\secret.webp"])(
  "rejects unsafe frame reference %s",
  async (frame) => {
    await expect(
      importMediaPack([
        config(
          {
            formatVersion: 1,
            characterId: "whale",
            maxFrameWidth: 1,
            maxFrameHeight: 1,
            clips: { idle: { frames: [frame], frameMs: 42, loop: true } },
          },
          "pet-manifest.json"
        ),
      ])
    ).rejects.toBeInstanceOf(MediaPackImportError)
  }
)

it("rejects missing configured media and duplicate paths", async () => {
  const settings = config({ animations: { idle: ["idle"] } })
  await expect(importMediaPack([settings])).rejects.toMatchObject({ code: "missingFiles" })
  const file = { path: "assets/webm/idle.webm", blob: webm() }
  await expect(importMediaPack([settings, file, file])).rejects.toMatchObject({ code: "invalid" })
})

it("rejects corrupt media instead of installing a ready-but-broken pack", async () => {
  await expect(
    importMediaPack([
      config({ animations: { idle: ["idle"] } }),
      { path: "assets/webm/idle.webm", blob: new Blob(["bad"]) },
    ])
  ).rejects.toMatchObject({ code: "invalid" })
})

it("preserves noMirror for text-bearing ambient clips", async () => {
  const pack = await importMediaPack([
    config({ animations: { idle: ["idle"], categories: [{ noMirror: true, actions: ["text"] }] } }),
    ...["idle", "text"].map((name) => ({ path: `assets/webm/${name}.webm`, blob: webm() })),
  ])
  expect(pack.manifest.clips.text.noMirror).toBe(true)
  expect(pack.manifest.ambient).toEqual(["text"])
})

it("extracts media without plugin code and rejects ZIP traversal before installation", async () => {
  const zip = new JSZip()
    .file("assets/config.jsonc", "{}")
    .file("assets/webm/idle.webm", new Uint8Array([1]))
    .file("plugin.js", "never execute")
  expect(
    (
      await extractMediaPackZip(
        new Blob([new Uint8Array(await zip.generateAsync({ type: "uint8array" }))])
      )
    ).map((entry) => entry.path)
  ).toEqual(["assets/config.jsonc", "assets/webm/idle.webm"])
  const bad = new JSZip().file("../secret.png", new Uint8Array([1]))
  await expect(
    extractMediaPackZip(new Blob([new Uint8Array(await bad.generateAsync({ type: "uint8array" }))]))
  ).rejects.toMatchObject({ code: "invalid" })
})

it("rejects an ambiguous pack instead of choosing the wrong character", async () => {
  await expect(
    importMediaPack([config({}, "a/config.jsonc"), config({}, "b/config.jsonc")])
  ).rejects.toMatchObject({ code: "ambiguous" })
})
