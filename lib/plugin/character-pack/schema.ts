/** Host compatibility barrel for the portable plugin SDK character-pack schema. */

export {
  CHARACTER_PACK_FILE_SCHEMA_VERSION,
  parseLocalPackFile,
  serializeLocalPackFile,
  SUPPORTED_SCHEMA_VERSIONS,
} from "@cognia/plugin-sdk/api/character-pack"

export type {
  CharacterPackFileSchemaVersion,
  CharacterPackParseResult as ParseResult,
  LocalCharacterPackFile,
  LocalCharacterPackSignature,
} from "@cognia/plugin-sdk/api/character-pack"
