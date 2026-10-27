import { discordAvatarUrl } from "./avatar"

it("prefers a guild member portrait even without nested member.user", () => {
  expect(discordAvatarUrl({ id: "123", avatar: "abcd" }, { avatar: "a_beef" }, "456")).toBe(
    "https://cdn.discordapp.com/guilds/456/users/123/avatars/a_beef.png?size=128"
  )
  expect(discordAvatarUrl({ id: "123", avatar: "abcd" }, { avatar: null }, "456")).toContain(
    "/avatars/123/abcd.png"
  )
})

it("uses exact snowflake bits for modern defaults and the legacy discriminator otherwise", () => {
  const id = "999999999999999999"
  expect(discordAvatarUrl({ id, avatar: null, discriminator: "0" })).toBe(
    `https://cdn.discordapp.com/embed/avatars/${(BigInt(id) >> 22n) % 6n}.png`
  )
  expect(discordAvatarUrl({ id, avatar: null, discriminator: "1337" })).toBe(
    "https://cdn.discordapp.com/embed/avatars/2.png"
  )
})

it("retains unknown fields for profile lookup and rejects invalid identity/hash paths", () => {
  expect(discordAvatarUrl({ id: "123" })).toBeUndefined()
  expect(discordAvatarUrl({ id: "123", avatar: "abcd" }, undefined, "456")).toBeUndefined()
  expect(discordAvatarUrl({ id: "../123", avatar: "abcd" })).toBeUndefined()
  expect(discordAvatarUrl({ id: "123", avatar: "../../secret" })).toBeUndefined()
})
