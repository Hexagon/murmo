#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| murmo_server::fuzz::json_body(data));
