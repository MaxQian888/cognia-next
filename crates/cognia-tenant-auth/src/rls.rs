//! The Postgres session-variable contract every tenant-scoped service shares.
//!
//! Row-level security policies in `services/diagnostic-server/migrations/`
//! are all written against `current_setting('app.tenant_id', true)`, and the
//! service sets it per transaction. That pairing is the entire isolation
//! mechanism, and it has one footgun sharp enough to deserve its own module.
//!
//! # `set_config`'s third argument is not a style choice
//!
//! `set_config(name, value, is_local)` with `is_local = true` scopes the value
//! to the **current transaction**. With `false` it scopes it to the *session*
//! — which, behind a connection pool, is whatever request happens to be handed
//! that connection next. A single `false` turns per-tenant RLS into "the last
//! tenant to touch this connection", and it fails open: every query still
//! returns rows, just the wrong tenant's. Nothing in Postgres warns about it.
//!
//! So the statement is a constant here rather than an inline string at each
//! call site, and a test asserts the `true`.
//!
//! # No database driver
//!
//! Deliberately just SQL text and names. `services/diagnostic-server` speaks
//! `sqlx`; `crates/cognia-ops-controller` speaks `tokio-postgres` through
//! `deadpool`. A shared module that picked one would be unusable by the other,
//! and the thing actually worth sharing is the *contract*, not the plumbing.

/// The setting RLS policies read to scope every row to one Org.
pub const TENANT_SETTING: &str = "app.tenant_id";

/// The setting ADR-0149 adds so a policy — and an audit trigger — can name the
/// person, not just the tenant. Unset on machine-to-machine paths, which is
/// why every policy reading it must tolerate an empty string.
pub const USER_SETTING: &str = "app.user_id";

/// Bind the tenant for the current transaction. One bind parameter: the id.
pub const SET_TENANT_SQL: &str = "SELECT set_config('app.tenant_id', $1, true)";

/// Bind the acting user for the current transaction. One bind parameter.
pub const SET_USER_SQL: &str = "SELECT set_config('app.user_id', $1, true)";

/// The expression a policy uses to read the tenant back.
///
/// `nullif(..., '')` is what makes an unset value `NULL` rather than a cast
/// error, so a connection that never bound a tenant matches no rows instead of
/// raising — deny by default, which is the correct failure direction.
pub const TENANT_PREDICATE: &str =
    "tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_binds_are_transaction_local() {
        // The whole reason this module exists. A `false` here leaks one
        // tenant's scope onto the next request that borrows the connection.
        for statement in [SET_TENANT_SQL, SET_USER_SQL] {
            assert!(
                statement.ends_with(", true)"),
                "{statement} must be transaction-local"
            );
            assert!(!statement.contains(", false)"));
        }
    }

    #[test]
    fn binds_take_the_value_as_a_parameter_rather_than_interpolating_it() {
        for statement in [SET_TENANT_SQL, SET_USER_SQL] {
            assert!(
                statement.contains("$1"),
                "{statement} must bind, not format"
            );
        }
    }

    #[test]
    fn the_predicate_treats_an_unset_tenant_as_no_rows() {
        assert!(TENANT_PREDICATE.contains("nullif("));
        assert!(TENANT_PREDICATE.contains("current_setting('app.tenant_id', true)"));
    }

    /// Parity guard against the live consumer. These constants describe what
    /// `services/diagnostic-server` already does; if it changes its statement
    /// or its policies, this crate is describing a contract nobody honours.
    #[test]
    fn matches_the_statement_and_policies_diagnostic_server_ships() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../services/diagnostic-server");

        let db = std::fs::read_to_string(root.join("src/db.rs"))
            .expect("diagnostic-server is the reference implementation of this contract");
        assert!(
            db.contains(SET_TENANT_SQL),
            "diagnostic-server no longer issues `{SET_TENANT_SQL}`"
        );

        let migration = std::fs::read_to_string(root.join("migrations/0001_diagnostics.sql"))
            .expect("the base migration defines the RLS policies");
        assert!(
            migration.contains(TENANT_PREDICATE),
            "the shipped RLS predicate no longer matches TENANT_PREDICATE"
        );
    }
}
