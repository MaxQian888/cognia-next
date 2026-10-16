//! Native-only ADR-0228 operator tool; never launched automatically.
//! A binary, not a Cargo example: examples activate test-inmemory secrets.
#[tokio::main]
async fn main() {
    if let Err(error) =
        cognia_companion_rpc::managed_desktop_operator::run(std::env::args().skip(1).collect())
            .await
    {
        eprintln!("{}", error.code);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn production_entry_requires_explicit_operator_arguments() {
        assert!(cognia_companion_rpc::managed_desktop_operator::parse_args(&[]).is_err());
    }
}
