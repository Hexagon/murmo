# syntax=docker/dockerfile:1
#
# Murmo server and client in one image (docs/HOSTING.md, "Quick start"). The server runs as a non-root user without a
# shell; its database and host key are in the volume /data. Put a TLS proxy in front (deploy/compose.yaml does that
# with Caddy) and set MURMO_ORIGIN to the public https address.
#
#   docker build --build-arg MURMO_COMMIT=$(git rev-parse HEAD) -t murmo .
#
# The build runs on the builder's own platform and cross-compiles for the target, so an arm64 image takes about as
# long as an amd64 one.

FROM --platform=$BUILDPLATFORM rust:1.95-bookworm AS build
ARG TARGETARCH
ARG BUILDARCH
# The commit shown in the app ("Säkerhet och integritet"); .git is not in the build context.
ARG MURMO_COMMIT=""
RUN <<SH
set -eu
case "$TARGETARCH" in
  amd64) t=x86_64-unknown-linux-gnu; gcc=x86_64-linux-gnu-gcc; pkgs="gcc-x86-64-linux-gnu libc6-dev-amd64-cross" ;;
  arm64) t=aarch64-unknown-linux-gnu; gcc=aarch64-linux-gnu-gcc; pkgs="gcc-aarch64-linux-gnu libc6-dev-arm64-cross" ;;
  *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;;
esac
if [ "$TARGETARCH" != "$BUILDARCH" ]; then
  apt-get update
  apt-get install -y --no-install-recommends $pkgs
  rm -rf /var/lib/apt/lists/*
  rustup target add "$t"
else
  gcc=gcc
fi
echo "$t" > /target
echo "$gcc" > /cc
SH
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY server server
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    <<SH
set -eu
t=$(cat /target); gcc=$(cat /cc)
T=$(echo "$t" | tr 'a-z-' 'A-Z_'); u=$(echo "$t" | tr '-' '_')
export "CARGO_TARGET_${T}_LINKER=$gcc" "CC_${u}=$gcc"
MURMO_COMMIT="$MURMO_COMMIT" cargo build --release --locked -p murmo-server --target "$t"
cp "target/$t/release/murmo-server" /murmo-server
SH
# The data directory, owned by the user the server runs as (a new volume takes it over).
RUN mkdir -p /data && chown 65532:65532 /data

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /murmo-server /usr/local/bin/murmo-server
COPY client /app/client
COPY --from=build --chown=65532:65532 /data /data
WORKDIR /app
ENV MURMO_BIND=0.0.0.0:8080 \
    MURMO_CLIENT_DIR=/app/client \
    MURMO_DB=/data/murmo.sqlite \
    MURMO_HOST_KEY_FILE=/data/murmo-host.key
VOLUME /data
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/murmo-server"]
