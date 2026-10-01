//! Standalone bootstrap core. Does not require Tauri, Node, or the app runtime.
pub mod config;
pub mod conversation;
pub mod model;
pub mod runner;
pub mod session;
pub mod state;
pub mod tools;

#[cfg(test)]
mod tests {
    #[test]
    fn public_contract_is_versioned() {
        assert_eq!(
            crate::runner::ResultRecord::error("invalid-config").version,
            1
        );
    }
}
