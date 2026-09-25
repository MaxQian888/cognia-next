import { getPipelineDb, getReviewHost, setPipelineDbFromDexie, setReviewHost } from "./runtime"
import { createFakeDexie } from "./fake-dexie.test-helpers"

afterEach(() => {
  setPipelineDbFromDexie(null)
  setReviewHost(null)
})

describe("review runtime", () => {
  it("publishes a DB from a dexie handle and clears it on null", async () => {
    expect(getPipelineDb()).toBeNull()
    const fake = createFakeDexie({
      topics: [{ id: "t1", title: "T", source: "s", status: "candidate", createdAt: 1 }],
    })
    setPipelineDbFromDexie(fake.dexie)
    await expect(getPipelineDb()?.listTopics()).resolves.toHaveLength(1)
    setPipelineDbFromDexie(null)
    expect(getPipelineDb()).toBeNull()
  })

  it("treats undefined dexie as no DB", () => {
    setPipelineDbFromDexie(undefined)
    expect(getPipelineDb()).toBeNull()
  })

  it("publishes and clears the host calls the modal makes", () => {
    const host = {
      session: { startSeededSession: jest.fn(), switchSession: jest.fn() },
      clipboard: { writeText: jest.fn() },
      ui: { navigate: jest.fn(() => true), showToast: jest.fn() },
    }
    setReviewHost(host)
    expect(getReviewHost()).toBe(host)
    setReviewHost(null)
    expect(getReviewHost()).toBeNull()
  })
})
