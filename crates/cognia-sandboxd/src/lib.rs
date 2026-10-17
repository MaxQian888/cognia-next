//! `cognia-sandboxd` — the supervisor brought into every sandbox (ADR-0183).
//!
//! The agent bundle image carries this binary next to the agent CLIs. A
//! container driver stages the bundle into the sandbox ([`install`]), asks the
//! user's image what it can host ([`probe`]), and replaces the image's
//! entrypoint with [`init`], which runs the agent as the right user with the
//! right environment ([`env`]).
//!
//! A remote provider (ADR-0221) adds two pieces: [`start_gate`] holds a
//! Kubernetes pod's supervisor back until the workspace is cloned, and
//! [`exec_env`] carries the environment and working directory an argv-only
//! exec cannot.
//!
//! Everything that reads the image works on a root directory argument rather
//! than `/`, so the tests run against fixture trees and the probe logic never
//! needs a container to be exercised.

pub mod egress;
pub mod elf;
pub mod env;
pub mod exec_env;
pub mod install;
pub mod layout;
pub mod manifest;
pub mod passwd;
pub mod probe;
pub mod rootfs;
pub mod service_bridge;

#[cfg(unix)]
pub mod init;

#[cfg(unix)]
pub mod serve;

#[cfg(unix)]
pub mod start_gate;

pub mod gateway_task;
