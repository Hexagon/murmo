//! The murmo server binary. Configuration: see the library documentation (`src/lib.rs`).
//!
//! ```text
//! murmo-server                 run the server
//! murmo-server backup <dir>    copy the database and the host key into <dir> (also while the server runs)
//! murmo-server --version       print the version and commit
//! ```

#![forbid(unsafe_code)]

const USAGE: &str = "usage: murmo-server [backup <dir> | --version | --help]
  (no arguments)  run the server, configured by MURMO_* variables (docs/HOSTING.md)
  backup <dir>    copy the database and the host key into <dir>, a new directory or an empty one; safe while the
                  server runs, with the same MURMO_DB and MURMO_HOST_KEY_FILE
  --version       print the version and the commit it was built from";

#[tokio::main]
async fn main() {
    if let Err(e) = start().await {
        eprintln!("murmo-server: {e}");
        std::process::exit(1);
    }
}

async fn start() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] => murmo_server::run().await,
        ["--version" | "-V"] => {
            println!("{}", murmo_server::admin::version());
            Ok(())
        }
        ["--help" | "-h"] => {
            println!("{USAGE}");
            Ok(())
        }
        ["backup", dir] => murmo_server::backup(dir),
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(2)
        }
    }
}
