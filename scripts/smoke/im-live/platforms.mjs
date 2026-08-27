// The platforms this harness drives, in the order results are reported.
//
// Its own module so `config.mjs`, the driver registry and the docs gate can
// share one list without importing each other's credential tables.
export const PLATFORMS = ["telegram", "slack", "discord", "lark", "matrix"]
