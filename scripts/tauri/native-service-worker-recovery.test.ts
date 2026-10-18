/** @jest-environment node */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import vm from "node:vm"

const source = readFileSync(
  join(process.cwd(), "src-tauri/src/native-service-worker-recovery.js"),
  "utf8"
)

async function run(
  options: {
    url?: string
    script?: string
    scope?: string
    controlled?: boolean
    present?: boolean
    failure?: boolean
    removed?: boolean
    removedElsewhere?: boolean
    devOrigin?: string
  } = {}
) {
  const url = new URL(options.url ?? "http://tauri.localhost/settings")
  const scriptURL = options.script ?? `${url.origin}/sw.js`
  const unregister = jest.fn().mockResolvedValue(options.removed ?? true)
  const reload = jest.fn()
  const warn = jest.fn()
  const registration =
    options.present === false
      ? undefined
      : {
          scope: options.scope ?? `${url.origin}/`,
          active: { scriptURL },
          unregister,
        }
  const getRegistration = options.failure
    ? jest.fn().mockRejectedValue(new Error("storage unavailable"))
    : jest.fn().mockResolvedValue(registration)
  if (options.removedElsewhere) {
    getRegistration.mockResolvedValueOnce(registration).mockResolvedValue(undefined)
  }
  await vm.runInNewContext(
    source.replace("__COGNIA_DEV_ORIGIN__", JSON.stringify(options.devOrigin ?? null)),
    {
      URL,
      location: { href: url.href, hostname: url.hostname, protocol: url.protocol, reload },
      navigator: {
        serviceWorker: {
          getRegistration,
          controller: options.controlled === false ? null : { scriptURL },
        },
      },
      console: { warn },
    }
  )
  return { unregister, reload, warn, getRegistration }
}

test("recovers a desktop page already controlled by the stale PWA worker", async () => {
  const result = await run()
  expect(result.unregister).toHaveBeenCalledTimes(1)
  expect(result.reload).toHaveBeenCalledTimes(1)
})

test.each(["/pet-overlay", "/pet-popup"])(
  "recovers a cached foreign document on the configured development origin %s",
  async (route) => {
    const result = await run({
      url: `http://localhost:3000${route}`,
      devOrigin: "http://localhost:3000",
    })
    expect(result.unregister).toHaveBeenCalledTimes(1)
    expect(result.reload).toHaveBeenCalledTimes(1)
  }
)

test("does not recover another service merely because it shares the dev hostname", async () => {
  const result = await run({ url: "http://localhost:3301/", devOrigin: "http://localhost:3000" })
  expect(result.getRegistration).not.toHaveBeenCalled()
})

test.each(["https://tauri.localhost/", "http://tauri.localhost/"])(
  "recovers the packaged origin %s",
  async (url) => {
    expect((await run({ url })).unregister).toHaveBeenCalledTimes(1)
  }
)

test.each(["https://cognia.cn/", "http://localhost:3000/", "tauri://localhost/"])(
  "does not change registrations outside the WebView2 asset origin %s",
  async (url) => {
    const result = await run({ url })
    expect(result.getRegistration).not.toHaveBeenCalled()
    expect(result.reload).not.toHaveBeenCalled()
  }
)

test("leaves unrelated workers and nested scopes alone", async () => {
  for (const options of [
    { script: "http://tauri.localhost/editor/sw.js" },
    { scope: "http://tauri.localhost/editor/" },
  ]) {
    expect((await run(options)).unregister).not.toHaveBeenCalled()
  }
})

test("reloads a controlled window after another window removed the registration", async () => {
  const result = await run({ present: false })
  expect(result.unregister).not.toHaveBeenCalled()
  expect(result.reload).toHaveBeenCalledTimes(1)
})

test("reloads when a concurrent unregister finishes between lookup and removal", async () => {
  const result = await run({ removed: false, removedElsewhere: true })
  expect(result.unregister).toHaveBeenCalledTimes(1)
  expect(result.getRegistration).toHaveBeenCalledTimes(2)
  expect(result.reload).toHaveBeenCalledTimes(1)
})

test("does not reload a clean page or create a loop when unregistering fails", async () => {
  for (const options of [
    { present: false, controlled: false },
    { controlled: false },
    { removed: false },
  ]) {
    expect((await run(options)).reload).not.toHaveBeenCalled()
  }
})

test("handles registration storage errors without rejecting into the page", async () => {
  const result = await run({ failure: true })
  expect(result.warn).toHaveBeenCalledTimes(1)
  expect(result.reload).not.toHaveBeenCalled()
})
