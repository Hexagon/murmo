#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| murmo_server::fuzz::bridge_envelope(data));
