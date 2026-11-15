// Compile the shared contract with a pure-Rust protobuf compiler, so building
// the kernel needs no `protoc` on the machine.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = "../contracts/proto";
    let file = "helix/kernel/v1/kernel.proto";
    println!("cargo:rerun-if-changed={root}/{file}");
    let descriptors = protox::compile([file], [root])?;
    tonic_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_fds(descriptors)?;
    Ok(())
}
