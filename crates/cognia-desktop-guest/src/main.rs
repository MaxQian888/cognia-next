//! Release-owned guest operations. No user-selected paths or commands.

#[cfg(target_os = "linux")]
mod boundary;
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
        [operation] if operation == "relay" => (relay::run(), "relay"),
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
        eprintln!("managed_desktop_guest_refused:{code}");
        std::process::exit(1);
    }
}
