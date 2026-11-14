#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| mesg_server::fuzz::http_text(data));
