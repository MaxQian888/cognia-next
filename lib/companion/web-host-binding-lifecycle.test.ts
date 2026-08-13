/** @jest-environment jsdom */
import {
  notifyWebHostBindingsFailed,
  notifyWebHostBindingsReady,
  registerWebHostBindingOwner,
  restartWebHostBindings,
} from "./web-host-binding-lifecycle"

it("coalesces restart requests until the provider reports bindings ready", async () => {
  const changed = jest.fn()
  const unregister = registerWebHostBindingOwner()
  window.addEventListener("cognia:companion-config-changed", changed)
  try {
    const first = restartWebHostBindings()
    const second = restartWebHostBindings()
    expect(second).toBe(first)
    expect(changed).toHaveBeenCalledTimes(1)
    notifyWebHostBindingsReady()
    await expect(first).resolves.toBeUndefined()
  } finally {
    unregister()
    window.removeEventListener("cognia:companion-config-changed", changed)
  }
})

it("rejects the pending target transition when binding fails", async () => {
  const unregister = registerWebHostBindingOwner()
  const restarting = restartWebHostBindings()
  notifyWebHostBindingsFailed(new Error("manifest incompatible"))
  await expect(restarting).rejects.toThrow("manifest incompatible")
  unregister()
})

it("fails immediately when no Web provider owns Host bindings", async () => {
  await expect(restartWebHostBindings()).rejects.toThrow("not mounted")
})
