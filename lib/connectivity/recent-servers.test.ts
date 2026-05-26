/**
 * @jest-environment jsdom
 */

import {
  loadRecentServers,
  recordRecentServer,
  removeRecentServer,
  recentServersToDiscovered,
  type RecentServer,
} from "./recent-servers"

const KEY = "cognia.mobile.recentServers"

beforeEach(() => {
  window.localStorage.clear()
})

describe("recent-servers", () => {
  it("returns [] when nothing is stored", () => {
    expect(loadRecentServers()).toEqual([])
  })

  it("records a server and reads it back", () => {
    recordRecentServer({ baseUrl: "https://192.168.1.5:7890", fingerprint: "FP", label: "phone" })
    const list = loadRecentServers()
    expect(list).toHaveLength(1)
    expect(list[0].baseUrl).toBe("https://192.168.1.5:7890")
    expect(list[0].fingerprint).toBe("FP")
    expect(typeof list[0].lastSeenAt).toBe("number")
  })

  it("normalises trailing slashes and dedupes by baseUrl", () => {
    recordRecentServer({ baseUrl: "https://desk:7890", lastSeenAt: 1 })
    recordRecentServer({ baseUrl: "https://desk:7890/", lastSeenAt: 2 })
    const list = loadRecentServers()
    expect(list).toHaveLength(1)
    expect(list[0].lastSeenAt).toBe(2)
  })

  it("keeps newest first and caps at 5", () => {
    for (let i = 0; i < 7; i++) {
      recordRecentServer({ baseUrl: `https://10.0.0.${i}:7890`, lastSeenAt: i })
    }
    const list = loadRecentServers()
    expect(list).toHaveLength(5)
    expect(list[0].baseUrl).toBe("https://10.0.0.6:7890")
  })

  it("moves an existing entry to the front on re-record", () => {
    recordRecentServer({ baseUrl: "https://a:7890", lastSeenAt: 1 })
    recordRecentServer({ baseUrl: "https://b:7890", lastSeenAt: 2 })
    recordRecentServer({ baseUrl: "https://a:7890", lastSeenAt: 3 })
    expect(loadRecentServers()[0].baseUrl).toBe("https://a:7890")
  })

  it("removes a server by baseUrl", () => {
    recordRecentServer({ baseUrl: "https://a:7890" })
    recordRecentServer({ baseUrl: "https://b:7890" })
    removeRecentServer("https://a:7890/")
    const list = loadRecentServers()
    expect(list.map((s) => s.baseUrl)).toEqual(["https://b:7890"])
  })

  it("ignores malformed stored JSON", () => {
    window.localStorage.setItem(KEY, "{not json")
    expect(loadRecentServers()).toEqual([])
  })

  it("filters out non-conforming entries", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([{ nope: true }, { baseUrl: "x", lastSeenAt: 1 }])
    )
    expect(loadRecentServers()).toHaveLength(1)
  })

  it("projects recents into DiscoveredServer history entries", () => {
    const recents: RecentServer[] = [
      {
        baseUrl: "https://192.168.1.9:7890",
        fingerprint: "FP",
        serverVersion: "1.0",
        lastSeenAt: 5,
      },
      { baseUrl: "not a url", lastSeenAt: 6 },
    ]
    const discovered = recentServersToDiscovered(recents)
    expect(discovered).toHaveLength(1)
    expect(discovered[0]).toMatchObject({
      id: "192.168.1.9:7890",
      ip: "192.168.1.9",
      port: 7890,
      source: "history",
      fingerprint: "FP",
      serverVersion: "1.0",
    })
  })
})
