//! Process-group helpers shared with the sidecar supervisor.
pub use cognia_exec_sandbox::proc_group::*;

#[cfg(test)]
mod tests {
    #[test]
    fn absent_process_is_safe_to_stop() {
        super::kill_process_group(None);
    }
}
