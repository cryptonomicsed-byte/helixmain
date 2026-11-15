// Command protogen compiles agent-os/contracts/proto without protoc and runs the
// standard protoc-gen-go and protoc-gen-go-grpc plugins on the result, so the Go
// stubs are generated from the one contract the Rust kernel also builds from
// (the kernel uses protox + tonic-build, also without protoc).
//
//	go run ./tools/protogen -proto ../contracts/proto -out gen helix/kernel/v1/kernel.proto
//
// The plugins are found on PATH (gen.sh installs pinned versions).
package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/bufbuild/protocompile"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/pluginpb"
)

func main() {
	protoDir := flag.String("proto", "", "root directory the .proto imports resolve against")
	out := flag.String("out", "gen", "output directory")
	flag.Parse()
	files := flag.Args()
	if *protoDir == "" || len(files) == 0 {
		fatal("usage: protogen -proto DIR -out DIR file.proto...")
	}

	compiler := protocompile.Compiler{
		Resolver:       protocompile.WithStandardImports(&protocompile.SourceResolver{ImportPaths: []string{*protoDir}}),
		SourceInfoMode: protocompile.SourceInfoStandard,
	}
	compiled, err := compiler.Compile(context.Background(), files...)
	if err != nil {
		fatal("compile: %v", err)
	}

	// Everything the requested files import must be in the request, dependencies first.
	var ordered []*descriptorpb.FileDescriptorProto
	seen := map[string]bool{}
	var add func(fd protoreflect.FileDescriptor)
	add = func(fd protoreflect.FileDescriptor) {
		if seen[fd.Path()] {
			return
		}
		seen[fd.Path()] = true
		imps := fd.Imports()
		for i := 0; i < imps.Len(); i++ {
			add(imps.Get(i).FileDescriptor)
		}
		ordered = append(ordered, protodesc.ToFileDescriptorProto(fd))
	}
	for _, f := range compiled {
		add(f)
	}

	for _, plugin := range []struct{ bin, param string }{
		{"protoc-gen-go", "paths=source_relative"},
		{"protoc-gen-go-grpc", "paths=source_relative,require_unimplemented_servers=true"},
	} {
		req := &pluginpb.CodeGeneratorRequest{
			FileToGenerate: files,
			Parameter:      proto.String(plugin.param),
			ProtoFile:      ordered,
		}
		in, err := proto.Marshal(req)
		if err != nil {
			fatal("marshal: %v", err)
		}
		cmd := exec.Command(plugin.bin)
		cmd.Stdin = bytes.NewReader(in)
		var stdout bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			fatal("%s: %v", plugin.bin, err)
		}
		var resp pluginpb.CodeGeneratorResponse
		if err := proto.Unmarshal(stdout.Bytes(), &resp); err != nil {
			fatal("%s: bad response: %v", plugin.bin, err)
		}
		if resp.Error != nil {
			fatal("%s: %s", plugin.bin, resp.GetError())
		}
		for _, f := range resp.File {
			dst := filepath.Join(*out, f.GetName())
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				fatal("%v", err)
			}
			if err := os.WriteFile(dst, []byte(f.GetContent()), 0o644); err != nil {
				fatal("%v", err)
			}
			fmt.Println("wrote", dst)
		}
	}
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}
