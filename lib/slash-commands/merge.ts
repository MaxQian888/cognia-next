// Merge the composer's slash-command sources into ONE picker list.
//
// A token can be declared by more than one source — `record-skill` is a
// builtin AND the `cognia-skill-recorder` plugin's command (deliberately: both
// land at the same `openRecorder`, see builtin.ts). The popover keys rows by
// `slash-${name}`, so surfacing both renders duplicate React keys and shows
// the same command twice.
//
// Precedence is last-wins, mirroring the composer's submit-time `commandMap`
// (built from the same concatenation, resolving a typed name to the LAST
// registration): the row shown is the command that would actually run.
// `hiddenFromPicker` entries are dropped BEFORE the merge so a hidden command
// can never shadow a visible one from an earlier source.

import type { SlashCommand } from "./builtin"

export function mergeSlashCommands(
  ...sources: ReadonlyArray<readonly SlashCommand[]>
): SlashCommand[] {
  const byName = new Map<string, SlashCommand>()
  for (const commands of sources) {
    for (const command of commands) {
      if (command.hiddenFromPicker) continue
      byName.set(command.name, command)
    }
  }
  return [...byName.values()]
}
