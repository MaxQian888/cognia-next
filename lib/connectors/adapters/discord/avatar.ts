/** Public Discord portraits; absent fields differ from an explicitly unset avatar. */
export function discordAvatarUrl(
  user: { id: string; avatar?: string | null; discriminator?: string },
  member?: { avatar?: string | null },
  guildId?: string
): string | undefined {
  if (!/^[1-9]\d{0,19}$/.test(user.id)) return undefined
  const hash = (value: unknown): value is string =>
    typeof value === "string" && /^(?:a_)?[a-f0-9]+$/i.test(value)
  const base = "https://cdn.discordapp.com"
  if (guildId && /^[1-9]\d{0,19}$/.test(guildId) && hash(member?.avatar))
    return `${base}/guilds/${guildId}/users/${user.id}/avatars/${member.avatar}.png?size=128`
  // Partial gateway/history members must be resolved before a global image is
  // accepted; explicit null confirms there is no guild-specific override.
  if (guildId && member?.avatar === undefined) return undefined
  if (hash(user.avatar)) return `${base}/avatars/${user.id}/${user.avatar}.png?size=128`
  if (user.avatar !== null) return undefined
  const index =
    user.discriminator && user.discriminator !== "0" && /^\d{1,4}$/.test(user.discriminator)
      ? Number(user.discriminator) % 5
      : Number((BigInt(user.id) >> 22n) % 6n)
  return `${base}/embed/avatars/${index}.png`
}
