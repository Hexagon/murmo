#!/bin/sh
# The release archives (docs/HOSTING.md, "Without containers"), into dist/:
#
#   murmo-<version>-x86_64-linux-musl.tar.gz    the server (static), client/, deploy/, licences, README, HOSTING.md
#   murmo-<version>-aarch64-linux-musl.tar.gz   the same for arm64
#   murmo-client-<version>.tar.gz               the client alone, made reproducibly: anyone can make it again
#   SHA256SUMS                                  of all three
#
# Needs cargo-zigbuild and zig (pip install ziglang) for the static builds. With --client-only, only the client
# archive and its sum: that needs nothing but tar, gzip and sha256sum, and gives the same bytes for the same commit.
set -eu
cd "$(dirname "$0")/.."
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n 1)
out=dist
rm -rf "$out"
mkdir -p "$out"

# Fixed names, order, owner and times, and no gzip time stamp: the archive depends only on the files' contents.
pack() { # <archive> <dir to enter> <paths…>
  archive=$1
  dir=$2
  shift 2
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu \
    --mode='u+rwX,go+rX,go-w' -C "$dir" -cf - "$@" | gzip -n -9 > "$archive"
}

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

# The client, in a directory of its own name.
mkdir -p "$stage/client-$version"
cp -R client "$stage/client-$version/client"
pack "$out/murmo-client-$version.tar.gz" "$stage/client-$version" client

if [ "${1:-}" != "--client-only" ]; then
  for arch in x86_64 aarch64; do
    target=$arch-unknown-linux-musl
    cargo zigbuild --release --locked -p murmo-server --target "$target"
    name=murmo-$version-$arch-linux-musl
    d=$stage/$name/$name
    mkdir -p "$d/deploy"
    cp "target/$target/release/murmo-server" "$d/"
    cp -R client "$d/client"
    cp deploy/murmo.service deploy/murmo.env.example "$d/deploy/"
    cp deploy/compose.yaml deploy/compose.own-proxy.yaml deploy/Caddyfile deploy/.env.example "$d/deploy/"
    cp LICENSE-MIT LICENSE-APACHE README.md docs/HOSTING.md "$d/"
    pack "$out/$name.tar.gz" "$stage/$name" "$name"
  done
fi

(cd "$out" && sha256sum -- *.tar.gz > SHA256SUMS)
cat "$out/SHA256SUMS"
