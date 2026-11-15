# Cross-language contracts

`helix/kernel/v1/kernel.proto` is the contract between the kernel and
everything that asks it for a decision.

| Language | Built from the proto by | Where |
|---|---|---|
| Rust (server) | `protox` + `tonic-build` at compile time — no `protoc` needed | `agent-os/kernel` |
| Go (client) | generated code checked in under `gen/` (see `agent-os/gateway/Makefile`) | `agent-os/gateway` |

The policy service (`agent-os/policy`, Clojure) is called by the kernel over
HTTP with a small JSON body documented in its README; it is deliberately free
of a gRPC stack.

`conformance/` holds golden fixtures that every implementation must reproduce:
the canonical hash and signature of a grant, and the canonical hash of an
intent. A change that alters any of those bytes is a breaking change.
