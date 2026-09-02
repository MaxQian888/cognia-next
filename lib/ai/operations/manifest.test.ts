import { PROVIDER_OPERATION_IDS } from "@cognia/provider-types"

import {
  PROVIDER_OPERATION_MANIFEST,
  getProviderOperationDescriptor,
  listProviderOperationDescriptors,
  listProviderOperationDescriptorsByGroup,
} from "./manifest"

describe("provider operation manifest", () => {
  it("loads every frozen id and nothing else", () => {
    const ids = listProviderOperationDescriptors().map((d) => d.id)
    expect(ids).toEqual([...PROVIDER_OPERATION_IDS])
    expect(PROVIDER_OPERATION_MANIFEST.schemaVersion).toBe(1)
  })

  it("freezes descriptors and answers lookups", () => {
    const descriptor = getProviderOperationDescriptor("language.generate")!
    expect(descriptor.group).toBe("language")
    expect(descriptor.piiGate).toBe("outbound-text")
    expect(Object.isFrozen(descriptor)).toBe(true)
    expect(getProviderOperationDescriptor("language.summon")).toBeUndefined()
  })

  it("groups descriptors", () => {
    const account = listProviderOperationDescriptorsByGroup("account").map((d) => d.id)
    expect(account).toContain("balance.read")
    expect(account).not.toContain("models.list")
  })

  it("pins the stateful operations to provider-pinned handles", () => {
    for (const id of ["files.get", "batches.get", "videos.get", "realtime.connect"] as const) {
      expect(getProviderOperationDescriptor(id)?.statefulHandle).toBe("provider-pinned")
    }
  })
})
