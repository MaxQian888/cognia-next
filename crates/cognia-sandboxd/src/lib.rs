//! `cognia-sandboxd` — the supervisor brought into every sandbox (ADR-0183).
//!
//! The agent bundle image carries this binary next to the agent CLIs. A
//! container driver stages the bundle into the sandbox ([`install`]), asks the
//! user's image what it can host ([`probe`]), and replaces the image's
//! entrypoint with [`init`], which runs the agent as the right user with the
//! right environment ([`env`]).
//!
//! Everything that reads the image works on a root directory argument rather
//! than `/`, so the tests run against fixture trees and the probe logic never
//! needs a container to be exercised.

pub mod elf;
pub mod env;
pub mod install;
pub mod layout;
pub mod manifest;
pub mod passwd;
pub mod probe;
pub mod rootfs;

#[cfg(unix)]
pub mod init;

#[cfg(unix)]
pub mod serve;
