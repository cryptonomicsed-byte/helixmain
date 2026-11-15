// Command mintfixtures writes the signed test documents the orchestrator's
// end-to-end tests need, with the PUBLIC TEST issuer key of the shared sid
// conformance fixtures (never a production key):
//
//	agent-cert.json       a sid/0.2 certificate for an agent with the given permissions
//	pricing-manifest.json a helix-plugin/1 manifest for plugins/dist/pricing.wasm
//
//	go run ./tools/mintfixtures -sid sid_barista -perms plugin.acme.pricing.checkout,merchant.order -out DIR
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/testsid"
)

func main() {
	kernelFixtures := flag.String("kernel-fixtures", "../kernel/tests/fixtures/sid-0.2", "the kernel's sid-0.2 test fixtures (for the test issuer key)")
	pluginDist := flag.String("plugins", "../plugins/dist", "directory with the compiled plugin components")
	sid := flag.String("sid", "sid_barista", "the agent's sid id")
	perms := flag.String("perms", "plugin.acme.pricing.quote,plugin.acme.pricing.checkout,merchant.order", "comma-separated permissions")
	out := flag.String("out", ".", "output directory")
	flag.Parse()

	secret, err := testsid.IssuerSecret(*kernelFixtures)
	check(err)
	cert, err := testsid.Cert(*sid, strings.Split(*perms, ","), "live", secret)
	check(err)
	write(filepath.Join(*out, "agent-cert.json"), cert)

	component, err := os.ReadFile(filepath.Join(*pluginDist, "pricing.wasm"))
	check(err)
	sum := sha256.Sum256(component)
	manifest, err := testsid.SignDoc(map[string]any{
		"format": "helix-plugin/1", "id": "acme.pricing", "version": "1.0.0",
		"component": map[string]any{"sha256": hex.EncodeToString(sum[:]), "size": len(component)},
		"tools": []any{
			map[string]any{"name": "quote", "description": "Price a basket"},
			map[string]any{"name": "checkout", "description": "Price a basket and propose the order"},
		},
		"permissions": []any{"storage"},
		"issuer":      map[string]any{"id": "issuer:helix-test-root", "kid": "root-1"},
		"issued_at":   "2026-11-10T00:00:00Z", "expires_at": "2027-11-10T00:00:00Z",
	}, secret)
	check(err)
	write(filepath.Join(*out, "pricing-manifest.json"), manifest)
}

func write(path string, v any) {
	b, err := json.MarshalIndent(v, "", " ")
	check(err)
	check(os.WriteFile(path, append(b, '\n'), 0o644))
	fmt.Println("wrote", path)
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "mintfixtures:", err)
		os.Exit(1)
	}
}
