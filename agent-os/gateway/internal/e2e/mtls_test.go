//go:build e2e

package e2e

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/kernelclient"
	"google.golang.org/grpc"

	kernelv1 "github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/gen/helix/kernel/v1"
)

type pki struct {
	caCert *x509.Certificate
	caKey  *ecdsa.PrivateKey
	caPEM  []byte
}

func newCA(t *testing.T, name string) *pki {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return &pki{cert, key, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

// issue writes a leaf certificate and key (key mode 0600) and returns their paths.
func (p *pki) issue(t *testing.T, dir, name string, server bool) (certPath, keyPath string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, BasicConstraintsValid: true,
	}
	if server {
		tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
		tmpl.IPAddresses = []net.IP{net.ParseIP("127.0.0.1")}
		tmpl.DNSNames = []string{"localhost"}
	} else {
		tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, p.caCert, &key.PublicKey, p.caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalPKCS8PrivateKey(key)
	certPath, keyPath = filepath.Join(dir, name+".pem"), filepath.Join(dir, name+".key")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return
}

// The Go client's mutual TLS against the Rust (tonic/rustls) server: a client
// from the trusted CA gets through; one with no certificate, one from another CA,
// and one that does not trust the kernel's CA do not.
func TestMutualTLSBetweenTheGoGatewayAndTheRustKernel(t *testing.T) {
	dir := t.TempDir()
	trusted, other := newCA(t, "helix-ca"), newCA(t, "rogue-ca")
	srvCert, srvKey := trusted.issue(t, dir, "kernel", true)
	cliCert, cliKey := trusted.issue(t, dir, "gateway", false)
	rogueCert, rogueKey := other.issue(t, dir, "rogue", false)
	caFile, rogueCAFile := filepath.Join(dir, "ca.pem"), filepath.Join(dir, "rogue-ca.pem")
	if err := os.WriteFile(caFile, trusted.caPEM, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rogueCAFile, other.caPEM, 0o644); err != nil {
		t.Fatal(err)
	}

	kbin := os.Getenv("HELIX_KERNEL_BIN")
	if kbin == "" {
		kbin = root(t, "kernel", "target", "debug", "helix-kernel")
	}
	if _, err := os.Stat(kbin); err != nil {
		t.Fatalf("the kernel binary is missing (%v); build it: (cd agent-os/kernel && cargo build --bin helix-kernel)", err)
	}
	keyFile := filepath.Join(dir, "grant.key")
	if out, err := exec.Command(kbin, "keygen", keyFile).CombinedOutput(); err != nil {
		t.Fatalf("keygen: %v\n%s", err, out)
	}
	port := freePort(t)
	k := exec.Command(kbin, "serve")
	k.Env = append(os.Environ(),
		"HELIX_KERNEL_SIGNING_KEY_FILE="+keyFile,
		"HELIX_KERNEL_TRUST_FILE="+root(t, "kernel", "tests", "fixtures", "sid-0.2", "trust.json"),
		"HELIX_KERNEL_DB="+filepath.Join(dir, "k.sqlite"),
		"HELIX_KERNEL_LISTEN="+fmt.Sprintf("127.0.0.1:%d", port),
		"HELIX_KERNEL_TLS_CERT="+srvCert, "HELIX_KERNEL_TLS_KEY="+srvKey, "HELIX_KERNEL_TLS_CLIENT_CA="+caFile,
	)
	if err := k.Start(); err != nil {
		t.Fatal(err)
	}
	p := &proc{k}
	t.Cleanup(p.stop)
	addr := fmt.Sprintf("127.0.0.1:%d", port)

	health := func(c kernelclient.TLS) error {
		kc, closeFn, err := kernelclient.Dial(addr, c)
		if err != nil {
			return err
		}
		defer closeFn()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, err = kc.Health(ctx, &kernelv1.HealthRequest{}, waitForReady())
		return err
	}

	deadline := time.Now().Add(20 * time.Second)
	var err error
	for {
		if err = health(kernelclient.TLS{CAFile: caFile, CertFile: cliCert, KeyFile: cliKey}); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("a client with a certificate from the trusted CA could not connect: %v", err)
		}
		time.Sleep(200 * time.Millisecond)
	}

	if err := health(kernelclient.TLS{CAFile: caFile, CertFile: rogueCert, KeyFile: rogueKey}); err == nil {
		t.Error("a client certificate from another CA must be refused")
	}
	if err := health(kernelclient.TLS{CAFile: rogueCAFile, CertFile: cliCert, KeyFile: cliKey}); err == nil {
		t.Error("a client that does not trust the kernel's CA must refuse the kernel")
	}
	// plaintext against a TLS-only kernel gets nothing either
	if kc, closeFn, derr := kernelclient.Dial(addr, kernelclient.TLS{}); derr == nil {
		defer closeFn()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, err := kc.Health(ctx, &kernelv1.HealthRequest{}); err == nil {
			t.Error("plaintext must not work against a mutual-TLS kernel")
		}
	}
}

func waitForReady() grpc.CallOption { return grpc.WaitForReady(false) }
