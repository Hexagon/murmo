//! Records the commit the server is built from (`MURMO_COMMIT`, else `GITHUB_SHA`, else `git rev-parse HEAD`), shown
//! to users as the version. Empty when none is known (a source tarball without `.git`).

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=MURMO_COMMIT");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    for p in ["../.git/HEAD", "../.git/refs/heads", "../.git/packed-refs"] {
        if std::path::Path::new(p).exists() {
            println!("cargo:rerun-if-changed={p}");
        }
    }
    let commit = std::env::var("MURMO_COMMIT")
        .ok()
        .or_else(|| std::env::var("GITHUB_SHA").ok())
        .or_else(|| {
            let out = Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()?;
            out.status
                .success()
                .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
        })
        .unwrap_or_default();
    let commit: String = commit
        .trim()
        .chars()
        .filter(char::is_ascii_hexdigit)
        .take(40)
        .collect();
    println!("cargo:rustc-env=MURMO_COMMIT={commit}");
}
