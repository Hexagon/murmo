//! Requests this server makes to hosts a client or another server named (federation peers, rootcard homes when any
//! home is allowed): never to internal addresses (DESIGN.md §14.2, THREAT_MODEL.md T23, T40).
//!
//! Two checks. A host name must look public before anything is sent ([`public_host`]): a dotted name whose last label
//! is alphabetic, so `127.1`, `10.1`, `0x7f.0.0.1` and `localhost.` (which resolvers read as addresses or as
//! `localhost`) are refused. And the name is resolved here, at connection time, by [`PublicResolver`], which drops
//! every loopback, private, link-local and otherwise non-public address ([`public_ip`]); the connection goes to the
//! addresses it checked, so a name that resolves to a public address for the check and to an internal one later (DNS
//! rebinding) gets nowhere.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::time::Duration;
use ureq::config::Config;
use ureq::http::Uri;
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};

/// As many addresses as ureq keeps from a resolver.
const MAX_ADDRS: usize = 16;

/// A host name that may be public: dotted, its last label alphabetic (a top-level domain), no trailing dot, not a
/// name that is local by convention. Never an IP literal in any spelling.
pub fn public_host(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    if name.is_empty()
        || name.len() > 253
        || !name.contains('.')
        || name.starts_with('.')
        || name.ends_with('.')
    {
        return false;
    }
    let labels: Vec<&str> = name.split('.').collect();
    let ok_label = |l: &&str| {
        !l.is_empty()
            && l.len() <= 63
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    if !labels.iter().all(ok_label) {
        return false;
    }
    let tld = labels[labels.len() - 1];
    let alphabetic = tld.len() >= 2 && tld.bytes().all(|b| b.is_ascii_alphabetic());
    if !alphabetic && !tld.starts_with("xn--") {
        return false;
    }
    ![
        "localhost",
        "local",
        "internal",
        "lan",
        "home",
        "corp",
        "intranet",
        "private",
        "test",
        "invalid",
    ]
    .contains(&tld)
        && !name.ends_with(".home.arpa")
}

/// Whether an address is reachable on the public internet: not loopback, private, link-local, shared (CGNAT),
/// unspecified, multicast, broadcast, documentation or reserved; IPv6 forms that embed an IPv4 address are judged by it.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => public_v6(v6),
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0 // "this network"
        || (a == 100 && (64..128).contains(&b)) // shared address space (CGNAT)
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || a >= 240) // reserved
}

fn public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return public_v4(v4);
    }
    let s = ip.segments();
    // NAT64 (64:ff9b::/96) and IPv4-compatible (::/96) addresses lead to the IPv4 address inside.
    if (s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0; 4]) || s[0..6] == [0; 6] {
        let o = ip.octets();
        let v4 = Ipv4Addr::new(o[12], o[13], o[14], o[15]);
        return !ip.is_unspecified() && !ip.is_loopback() && public_v4(v4);
    }
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (s[0] & 0xfe00) == 0xfc00 // unique local
        || (s[0] & 0xffc0) == 0xfe80 // link-local
        || (s[0] & 0xffc0) == 0xfec0 // site-local (deprecated)
        || (s[0] == 0x2001 && s[1] == 0x0db8)) // documentation
}

/// Resolves host names and keeps only public addresses; ureq then connects to exactly those. A forward proxy the
/// operator configured (`HTTPS_PROXY`) is resolved as is: it is the operator's, and the target is not resolved here then.
#[derive(Debug, Default)]
pub struct PublicResolver;

impl Resolver for PublicResolver {
    fn resolve(
        &self,
        uri: &Uri,
        config: &Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let host = uri
            .host()
            .unwrap_or_default()
            .trim_start_matches('[')
            .trim_end_matches(']');
        let port = uri
            .port_u16()
            .unwrap_or(if uri.scheme_str() == Some("http") {
                80
            } else {
                443
            });
        let is_proxy = config
            .proxy()
            .is_some_and(|p| p.host().eq_ignore_ascii_case(host) && p.port() == port);
        if !is_proxy && !public_host(host) {
            return Err(ureq::Error::HostNotFound);
        }
        let found = resolve(host, port, *timeout.after)?;
        let mut out = self.empty();
        for addr in found
            .into_iter()
            .filter(|a| is_proxy || public_ip(a.ip()))
            .take(MAX_ADDRS)
        {
            out.push(addr);
        }
        if out.is_empty() {
            Err(ureq::Error::HostNotFound)
        } else {
            Ok(out)
        }
    }
}

/// Resolve `host:port`, giving up after `timeout` (the lookup runs on its own thread then).
fn resolve(host: &str, port: u16, timeout: Duration) -> Result<Vec<SocketAddr>, ureq::Error> {
    let addr = (host.to_string(), port);
    if timeout >= Duration::from_secs(3600) {
        return Ok(addr.to_socket_addrs()?.collect());
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || tx.send(addr.to_socket_addrs().map(Iterator::collect)).ok());
    match rx.recv_timeout(timeout) {
        Ok(r) => Ok(r?),
        Err(_) => Err(ureq::Error::HostNotFound),
    }
}

/// An agent for requests to other hosts: 10 s in all, no redirects, statuses as answers. `public_only`: connect only
/// to public addresses of public host names (hosts that are not on an operator's allowlist).
pub fn agent(public_only: bool) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .max_redirects(0)
        .http_status_as_error(false)
        .build();
    if public_only {
        ureq::Agent::with_parts(config, DefaultConnector::new(), PublicResolver)
    } else {
        config.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_names_that_are_addresses_or_local_are_refused() {
        for ok in [
            "murmo.example.org",
            "rootcard.org",
            "a-b.example.com",
            "xn--bcher-kva.example",
            "Murmo.Example",
        ] {
            assert!(public_host(ok), "{ok}");
        }
        for bad in [
            "127.1",
            "10.1",
            "0x7f.0.0.1",
            "0177.0.0.1",
            "127.0.0.1",
            "2130706433",
            "localhost",
            "localhost.",
            "murmo.example.",
            "printer.local",
            "db.internal",
            "x.localhost",
            "router.home.arpa",
            "[::1]",
            "::1",
            "",
            ".example.com",
            "a..example",
            "-a.example",
            "a_b.example",
            "1.2.3.4.e",
            "example.123",
        ] {
            assert!(!public_host(bad), "{bad}");
        }
    }

    #[test]
    fn internal_addresses_are_refused() {
        for bad in [
            "127.0.0.1",
            "127.255.255.254",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "0.1.2.3",
            "100.64.0.1",
            "255.255.255.255",
            "224.0.0.1",
            "240.0.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::127.0.0.1",
            "64:ff9b::a9fe:a9fe",
            "2001:db8::1",
        ] {
            assert!(!public_ip(bad.parse().expect("address")), "{bad}");
        }
        for ok in [
            "93.184.216.34",
            "1.1.1.1",
            "2606:4700:4700::1111",
            "::ffff:93.184.216.34",
            "64:ff9b::808:808",
        ] {
            assert!(public_ip(ok.parse().expect("address")), "{ok}");
        }
    }

    #[test]
    fn the_resolver_refuses_names_of_internal_addresses() {
        // `localhost` and friends never reach a lookup; a public-looking name that resolves internally finds nothing.
        let config = ureq::Agent::config_builder().proxy(None).build(); // straight, also where a proxy is set
        let agent = ureq::Agent::with_parts(config, DefaultConnector::new(), PublicResolver);
        for url in [
            "http://127.1:9/",
            "http://localhost.:9/",
            "http://0x7f.0.0.1:9/",
            "http://[::1]:9/",
        ] {
            let e = agent.get(url).call().expect_err(url);
            assert!(matches!(e, ureq::Error::HostNotFound), "{url}: {e:?}");
        }
    }
}
