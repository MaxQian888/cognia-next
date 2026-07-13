//! External Agent Module
//!
//! Provides Tauri commands for managing external agent processes.
//! Supports spawning, communication, and lifecycle management of
//! external agents via stdio transport.

pub mod command_resolver;
pub mod commands;
pub mod container_backend;
pub mod exec_backend;
pub mod kube_backend;
pub mod presets;
pub mod proc_group;
pub mod process;
pub mod terminal;
