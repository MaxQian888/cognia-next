import {
  COLLAB_REFRESH_MAX_BACKOFF_MS,
  collabRefreshDelay,
  requestCollabRefresh,
} from "./refresh-scheduler"

describe("collaboration refresh scheduling", () => {
  it("deduplicates concurrent refreshes for one account", async () => {
    let resolve!: (value: never) => void
    const refresh = jest.fn(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const first = requestCollabRefresh("account-dedupe", refresh as never)
    const second = requestCollabRefresh("account-dedupe", refresh as never)
    expect(refresh).toHaveBeenCalledTimes(1)
    resolve({ status: "skipped", reason: "not-configured" } as never)
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it("backs off exponentially and caps at fifteen minutes", () => {
    expect(collabRefreshDelay(0)).toBe(60_000)
    expect(collabRefreshDelay(2)).toBe(240_000)
    expect(collabRefreshDelay(20)).toBe(COLLAB_REFRESH_MAX_BACKOFF_MS)
  })
})
