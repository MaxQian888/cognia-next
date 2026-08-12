use std::io::{self, Read};

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let mut input = String::new();
    if let Err(error) = io::stdin().read_to_string(&mut input) {
        eprintln!("read stdin: {error}");
        std::process::exit(1);
    }
    if let Err(error) = cognia_task_workspace::run_worker_cli(&args, &input, &mut io::stdout()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
