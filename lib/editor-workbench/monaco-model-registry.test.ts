import {
  bindMonacoModelRegistry,
  disposeModel,
  getModelRetainCount,
  getMonacoModelRegistryNamespace,
  getRetainedModelUris,
  releaseModel,
  releaseModels,
  resetMonacoModelRegistry,
  retainModel,
  type ModelRegistryMonaco,
  type RegistryTextModel,
} from "./monaco-model-registry"

interface FakeModel extends RegistryTextModel {
  disposeCalls: number
}

function createFakeMonaco() {
  const models = new Map<string, FakeModel>()
  const addModel = (uri: string): FakeModel => {
    const model: FakeModel = {
      disposeCalls: 0,
      isDisposed: () => model.disposeCalls > 0,
      dispose: () => {
        model.disposeCalls += 1
      },
    }
    models.set(uri, model)
    return model
  }
  const monaco: ModelRegistryMonaco = {
    Uri: { parse: (value: string) => value },
    editor: {
      getModel: ((uri: string) =>
        models.get(uri) ?? null) as ModelRegistryMonaco["editor"]["getModel"],
    },
  }
  return { monaco, models, addModel }
}

beforeEach(() => {
  resetMonacoModelRegistry()
})

describe("monaco model registry", () => {
  it("disposes the model only when the last holder releases it", () => {
    const { monaco, addModel } = createFakeMonaco()
    bindMonacoModelRegistry(monaco)
    const model = addModel("file:///repo/a.ts")

    retainModel("file:///repo/a.ts")
    retainModel("file:///repo/a.ts")
    expect(getModelRetainCount("file:///repo/a.ts")).toBe(2)

    releaseModel("file:///repo/a.ts")
    expect(model.disposeCalls).toBe(0)
    expect(getModelRetainCount("file:///repo/a.ts")).toBe(1)

    releaseModel("file:///repo/a.ts")
    expect(model.disposeCalls).toBe(1)
    expect(getModelRetainCount("file:///repo/a.ts")).toBe(0)
  })

  it("does not release on editor churn — only an explicit release counts", () => {
    // The regression this registry exists to prevent: a tab switch must not
    // touch the count, so the undo stack behind the URI survives it.
    const { monaco, addModel } = createFakeMonaco()
    bindMonacoModelRegistry(monaco)
    const model = addModel("file:///repo/a.ts")
    retainModel("file:///repo/a.ts")

    bindMonacoModelRegistry(monaco)
    bindMonacoModelRegistry(monaco)

    expect(model.disposeCalls).toBe(0)
    expect(getModelRetainCount("file:///repo/a.ts")).toBe(1)
  })

  it("ignores a release for an untracked uri so double-close is safe", () => {
    const { monaco, addModel } = createFakeMonaco()
    bindMonacoModelRegistry(monaco)
    const model = addModel("file:///repo/a.ts")

    retainModel("file:///repo/a.ts")
    releaseModel("file:///repo/a.ts")
    releaseModel("file:///repo/a.ts")

    expect(model.disposeCalls).toBe(1)
  })

  it("ignores an empty uri", () => {
    retainModel("")
    expect(getRetainedModelUris()).toEqual([])
  })

  it("releases many uris in one call", () => {
    const { monaco, addModel } = createFakeMonaco()
    bindMonacoModelRegistry(monaco)
    const a = addModel("file:///repo/a.ts")
    const b = addModel("file:///repo/b.ts")
    retainModel("file:///repo/a.ts")
    retainModel("file:///repo/b.ts")

    releaseModels(["file:///repo/a.ts", "file:///repo/b.ts"])

    expect(a.disposeCalls).toBe(1)
    expect(b.disposeCalls).toBe(1)
    expect(getRetainedModelUris()).toEqual([])
  })

  it("force-disposes regardless of refcount", () => {
    const { monaco, addModel } = createFakeMonaco()
    bindMonacoModelRegistry(monaco)
    const model = addModel("file:///repo/a.ts")
    retainModel("file:///repo/a.ts")
    retainModel("file:///repo/a.ts")

    disposeModel("file:///repo/a.ts")

    expect(model.disposeCalls).toBe(1)
    expect(getModelRetainCount("file:///repo/a.ts")).toBe(0)
  })

  it("defers disposal until a monaco namespace is bound", () => {
    const { monaco, addModel } = createFakeMonaco()
    retainModel("file:///repo/a.ts")
    releaseModel("file:///repo/a.ts")

    const model = addModel("file:///repo/a.ts")
    expect(model.disposeCalls).toBe(0)

    bindMonacoModelRegistry(monaco)
    expect(model.disposeCalls).toBe(1)
  })

  it("cancels a deferred disposal when the uri is retained again first", () => {
    const { monaco, addModel } = createFakeMonaco()
    retainModel("file:///repo/a.ts")
    releaseModel("file:///repo/a.ts")
    retainModel("file:///repo/a.ts")

    const model = addModel("file:///repo/a.ts")
    bindMonacoModelRegistry(monaco)

    expect(model.disposeCalls).toBe(0)
    expect(getModelRetainCount("file:///repo/a.ts")).toBe(1)
  })

  it("tolerates a missing or already-disposed model", () => {
    const { monaco, addModel } = createFakeMonaco()
    bindMonacoModelRegistry(monaco)

    retainModel("file:///repo/gone.ts")
    expect(() => releaseModel("file:///repo/gone.ts")).not.toThrow()

    const model = addModel("file:///repo/a.ts")
    model.dispose()
    retainModel("file:///repo/a.ts")
    releaseModel("file:///repo/a.ts")
    expect(model.disposeCalls).toBe(1)
  })

  it("exposes the bound namespace and clears it on reset", () => {
    const { monaco } = createFakeMonaco()
    expect(getMonacoModelRegistryNamespace()).toBeNull()
    bindMonacoModelRegistry(monaco)
    expect(getMonacoModelRegistryNamespace()).toBe(monaco)
    resetMonacoModelRegistry()
    expect(getMonacoModelRegistryNamespace()).toBeNull()
  })
})
