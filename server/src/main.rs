//! The murmo server binary. Configuration: see the library documentation (`src/lib.rs`).

#![forbid(unsafe_code)]

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    murmo_server::run().await
}
