/**
 * Pet settings types — re-export shim (ADR-0068 E5). The definitions moved
 * to `@cognia/agent-config-types/pet-settings`: PetSettings is referenced by
 * the AppSettings hub while UtilityModelConfig (defined in the hub) is
 * referenced here, so the pair must live in the same compilation unit to
 * keep the package free of app back-references. The rest of the pet type
 * tree stays in `types/pet/`.
 */

export * from "@cognia/agent-config-types/pet-settings"
