// helix-resolver: the public QR contact resolver (helix-qr/1).
//
// It holds no signing key and is untrusted for content: it serves resolutions the
// issuer signed, after verifying them, and clients verify everything again.
//
//	HELIX_RESOLVER_ORIGIN              required, this resolver's public origin, e.g. https://contact.example
//	HELIX_RESOLVER_TRUST_FILE          required, sid/0.2 trust anchors (the issuers whose signatures count)
//	HELIX_RESOLVER_STORE_DIR           required, where resolutions are kept
//	HELIX_RESOLVER_PUBLISH_TOKEN_SHA256 SHA-256 (hex) of the bearer token allowed to publish; unset disables publishing
//	HELIX_RESOLVER_LISTEN              default 127.0.0.1:8081 (off loopback it refuses to start without TLS)
//	HELIX_RESOLVER_TLS_CERT / _KEY     serve HTTPS directly; or terminate TLS in front and stay on loopback
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/qr"
	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/resolver"
)

func env(name, def string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return def
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "helix-resolver: "+format+"\n", a...)
	os.Exit(2)
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	origin := env("HELIX_RESOLVER_ORIGIN", "")
	trustFile := env("HELIX_RESOLVER_TRUST_FILE", "")
	storeDir := env("HELIX_RESOLVER_STORE_DIR", "")
	if origin == "" || trustFile == "" || storeDir == "" {
		fail("HELIX_RESOLVER_ORIGIN, HELIX_RESOLVER_TRUST_FILE and HELIX_RESOLVER_STORE_DIR are required")
	}
	raw, err := os.ReadFile(trustFile)
	if err != nil {
		fail("cannot read %s: %v", trustFile, err)
	}
	trust, err := qr.ParseTrust(raw)
	if err != nil {
		fail("%s: %v", trustFile, err)
	}
	srv, err := resolver.New(resolver.Config{
		Origin: origin, Trust: trust, Store: resolver.FileStore{Dir: storeDir},
		PublishTokenSHA256: env("HELIX_RESOLVER_PUBLISH_TOKEN_SHA256", ""), Log: log,
	})
	if err != nil {
		fail("%v", err)
	}

	listen := env("HELIX_RESOLVER_LISTEN", "127.0.0.1:8081")
	certFile, keyFile := env("HELIX_RESOLVER_TLS_CERT", ""), env("HELIX_RESOLVER_TLS_KEY", "")
	if (certFile == "") != (keyFile == "") {
		fail("HELIX_RESOLVER_TLS_CERT and HELIX_RESOLVER_TLS_KEY must be set together")
	}
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		fail("HELIX_RESOLVER_LISTEN must be host:port")
	}
	if ip := net.ParseIP(host); certFile == "" && !(host == "localhost" || (ip != nil && ip.IsLoopback())) {
		fail("refusing to listen on %s without TLS", listen)
	}
	if env("HELIX_RESOLVER_PUBLISH_TOKEN_SHA256", "") == "" {
		log.Warn("publishing is disabled: HELIX_RESOLVER_PUBLISH_TOKEN_SHA256 is not set")
	}

	httpServer := &http.Server{
		Addr: listen, Handler: srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 16 << 10, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12},
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() {
		log.Info("helix-resolver listening", "addr", listen, "origin", origin, "tls", certFile != "")
		if certFile != "" {
			done <- httpServer.ListenAndServeTLS(certFile, keyFile)
		} else {
			done <- httpServer.ListenAndServe()
		}
	}()
	select {
	case err := <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			fail("%v", err)
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}
}
