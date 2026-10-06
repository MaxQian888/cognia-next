import { ompManifest, OMP_CAPABILITIES, OMP_RPC_EXECUTION_SEMANTICS } from "./manifest"
it("declares independent identity and conservative process cancellation", () => {
  expect(ompManifest.ecosystem.id).toBe("oh-my-pi")
  expect(ompManifest.protocols[0].protocol).toBe("omp-rpc")
  expect(OMP_RPC_EXECUTION_SEMANTICS.cancel).toEqual({
    scope: "process",
    reconnectsAfterCancel: true,
  })
  expect(ompManifest.runtimes?.[0]).toMatchObject({
    systemCommand: "omp",
    ownership: "system",
    sandbox: { required: true },
  })
})
it("does not claim verified host integration or plugin compatibility", () => {
  expect(ompManifest.ecosystem.pluginEcosystem).toBeNull()
  for (const cell of Object.values(OMP_CAPABILITIES.protocols!["omp-rpc"].capabilities))
    expect(cell?.evidence).not.toBe("cognia-verified")
})
