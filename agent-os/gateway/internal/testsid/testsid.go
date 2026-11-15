// Package testsid mints properly signed sid/0.2 certificates with the public
// TEST issuer key from the shared conformance fixtures, so the gateway's
// end-to-end tests can register an agent with a real kernel. It is for tests
// only; no production issuer key ever lives in this repository.
package testsid

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/canonical"
)

const born = "2026-11-12T09:00:00Z"

// IssuerSecret reads the "issuer-root" secret from the kernel's test fixtures.
func IssuerSecret(kernelFixtureDir string) (string, error) {
	raw, err := os.ReadFile(kernelFixtureDir + "/test-keys.json")
	if err != nil {
		return "", err
	}
	var doc struct {
		Keys map[string]struct {
			Secret string `json:"secret"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", err
	}
	k, ok := doc.Keys["issuer-root"]
	if !ok || k.Secret == "" {
		return "", fmt.Errorf("no issuer-root key in %s", kernelFixtureDir)
	}
	return k.Secret, nil
}

// Cert returns a version-1 certificate for sid with the given permissions and
// status, signed by the test issuer.
func Cert(sid string, permissions []string, status, issuerSecretHex string) (map[string]any, error) {
	perms := make([]any, len(permissions))
	for i, p := range permissions {
		perms[i] = p
	}
	doc := map[string]any{
		"format": "sid/0.2", "id": sid, "version": 1, "status": status,
		"born_at": born, "updated": born,
		"issuer":       map[string]any{"id": "issuer:helix-test-root", "kid": "root-1"},
		"identity":     map[string]any{"name": "Test agent", "type": "agent"},
		"capabilities": map[string]any{"permissions": perms},
		"lifecycle": map[string]any{
			"state":   status,
			"history": []any{map[string]any{"state": "cast", "at": born}, map[string]any{"state": status, "at": born}},
		},
		"previous_version": nil,
		"previous_hash":    "none",
	}
	acting := map[string]any{}
	for _, k := range []string{"identity", "bindings", "capabilities", "memory", "lifecycle", "status"} {
		if v, ok := doc[k]; ok {
			acting[k] = v
		}
	}
	c, err := canonical.JSON(acting)
	if err != nil {
		return nil, err
	}
	doc["acting_hash"] = canonical.SHA256Hex(c)
	hash, err := canonical.HashWithout(doc, "hash", "proof")
	if err != nil {
		return nil, err
	}
	doc["hash"] = hash
	seed, err := hex.DecodeString(issuerSecretHex)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("issuer secret must be 32 bytes of hex")
	}
	sig := ed25519.Sign(ed25519.NewKeyFromSeed(seed), []byte("sid/0.2\nissue\n"+hash))
	doc["proof"] = map[string]any{"alg": "ed25519", "signature": hex.EncodeToString(sig)}
	return doc, nil
}
