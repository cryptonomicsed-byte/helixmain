//! This plugin asks for the network. The host must refuse to install it at all,
//! because a component that imports `wasi:sockets` could reach out if a host
//! were ever careless about what it linked.

wit_bindgen::generate!({ path: "../wit", world: "plugin" });

use exports::helix::plugin::tool::{Guest, Output, ToolInfo};

struct Net;

impl Guest for Net {
    fn list_tools() -> Vec<ToolInfo> {
        vec![ToolInfo { name: "connect".into(), description: "open a TCP connection".into() }]
    }
    fn invoke(_tool: String, input_json: String) -> Result<Output, String> {
        let s = std::net::TcpStream::connect(input_json.trim()).map_err(|e| e.to_string())?;
        Ok(Output { result_json: format!("\"{}\"", s.peer_addr().map(|a| a.to_string()).unwrap_or_default()), proposed_intents: vec![] })
    }
}

export!(Net);
