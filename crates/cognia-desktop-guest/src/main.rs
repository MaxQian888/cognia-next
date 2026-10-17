//! Release-owned guest operations. No user-selected paths or commands.

#[cfg(target_os = "linux")]
mod acceptance;
#[cfg(target_os = "linux")]
mod boundary;
#[cfg(target_os = "linux")]
mod control;
#[cfg(target_os = "linux")]
mod probe;
#[cfg(target_os = "linux")]
mod promotion;
#[cfg(target_os = "linux")]
mod protocol;
#[cfg(target_os = "linux")]
mod qualify;
#[cfg(target_os = "linux")]
mod relay;
#[cfg(target_os = "linux")]
mod supervisor;

fn main() {
    #[cfg(target_os = "linux")]
    let (result, code) = match std::env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [operation] if operation == "supervise" => {
            let result = supervisor::run();
            (result, supervisor::failure_stage())
        }
        [operation] if operation == "observe" => (boundary::print_live_report(), "observation"),
        [operation] if operation == "qualify-start" => (qualify::start(), "qualification_start"),
        [operation] if operation == "qualify-result" => (qualify::result(), "qualification_result"),
        [operation] if operation == "qualify-worker" => (qualify::worker(), "qualification_worker"),
        [operation]
            if [
                "qualification-workload",
                "qualification-terminal",
                "qualification-importer",
                "qualification-negative-wait",
            ]
            .contains(&operation.as_str()) =>
        {
            (probe::child(operation), "qualification_payload")
        }
        [operation] if operation == "relay" => (relay::run(), "relay"),
        [operation] if operation == "handoff" => (control::forward(), "handoff"),
        [operation] if operation == "handoff-worker" => (control::worker(), "handoff_worker"),
        [operation] if operation == "acceptance-helper" => {
            (acceptance::helper_main(), "acceptance")
        }
        _ => (
            Err(std::io::Error::other("invalid guest operation")),
            "operation",
        ),
    };
    #[cfg(not(target_os = "linux"))]
    let (result, code): (std::io::Result<()>, &str) = (
        Err(std::io::Error::other("Linux guest required")),
        "platform",
    );
    if result.is_err() {
        // Neither provider diagnostics nor process environments belong in logs.
        eprintln!("{}", refusal_line(code));
        std::process::exit(1);
    }
}

/// The only stderr line a refused operation writes. The Host's envd client
/// reads the stage after the prefix, so the shape is a wire contract.
fn refusal_line(stage: &str) -> String {
    format!("managed_desktop_guest_refused:{stage}")
}

#[cfg(test)]
mod tests {
    use super::refusal_line;

    #[test]
    fn refusal_line_carries_only_the_stage_token() {
        assert_eq!(
            refusal_line("qualification_result"),
            "managed_desktop_guest_refused:qualification_result"
        );
        assert_eq!(refusal_line("platform"), "managed_desktop_guest_refused:platform");
        assert!(!refusal_line("operation").contains('\n'));
    }
}
