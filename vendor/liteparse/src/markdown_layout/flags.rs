//! Debug-logging flags, read once from the environment.
//!
//! Each flag mirrors a `LITEPARSE_*` env var and is `true` when the variable is
//! set. `env::var` allocates on every call, so these cache the lookup in a
//! `LazyLock` rather than re-reading on per-line hot paths.

use std::sync::LazyLock;

macro_rules! env_set_flag {
    ($(#[$m:meta])* $name:ident, $var:literal) => {
        $(#[$m])*
        pub(super) static $name: LazyLock<bool> =
            LazyLock::new(|| std::env::var($var).is_ok());
    };
}

env_set_flag!(DEBUG_MD, "LITEPARSE_DEBUG_MD");
env_set_flag!(DEBUG_TABLE, "LITEPARSE_DEBUG_TABLE");
env_set_flag!(DEBUG_RULED, "LITEPARSE_DEBUG_RULED");
env_set_flag!(DEBUG_CROSS_REGION, "LITEPARSE_DEBUG_CROSS_REGION");
env_set_flag!(DEBUG_GUTTER, "LITEPARSE_DEBUG_GUTTER");
