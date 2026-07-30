import {
  getProvisionedTurnSnapshot,
  publishProvisionedTurnServers,
  resetProvisionedTurnServersForTests,
} from "./provisioned-turn-state"

beforeEach(() => resetProvisionedTurnServersForTests())

it("publishes immutable snapshots with a monotonic sync watermark", () => {
  const servers = [{ urls: ["turn:first.example"], username: "u", credential: "c" }]
  publishProvisionedTurnServers(servers, 10)
  servers[0].urls[0] = "turn:mutated.example"

  const first = getProvisionedTurnSnapshot()
  expect(first).toEqual({
    servers: [{ urls: ["turn:first.example"], username: "u", credential: "c" }],
    updatedAt: 10,
  })

  first.servers[0].urls = "turn:consumer-mutated.example"
  publishProvisionedTurnServers([], 5)
  expect(getProvisionedTurnSnapshot()).toEqual({ servers: [], updatedAt: 11 })
})
