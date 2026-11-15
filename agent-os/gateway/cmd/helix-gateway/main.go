// helix-gateway: the REST front of the HELIX kernel.
//
//	helix-gateway serve                 run the gateway (default)
//	helix-gateway mint-token ...        make a token and the registry entry that vouches for it
//
// Configuration is by environment; see agent-os/gateway/README.md.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/api"
	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/auth"
	"github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/internal/kernelclient"
)

func env(name, def string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return def
}

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "helix-gateway: "+format+"\n", a...)
	os.Exit(2)
}

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "serve":
		serve()
	case "mint-token":
		mintToken(os.Args[2:])
	default:
		fail("unknown command %q (serve, mint-token)", cmd)
	}
}

func mintToken(args []string) {
	fs := flag.NewFlagSet("mint-token", flag.ExitOnError)
	id := fs.String("id", "", "a name for this token, e.g. tok_alice_laptop")
	org := fs.String("org", "", "organization_id")
	principal := fs.String("principal", "", "the principal, e.g. user:alice, svc:merchant-adapter or sid_front-desk")
	kind := fs.String("kind", "", "user, service or agent")
	roles := fs.String("roles", "", "comma-separated roles (reviewer, grant_admin, proposer, executor, registrar)")
	expires := fs.String("expires", "", "optional RFC 3339 expiry")
	_ = fs.Parse(args)
	token, sha, err := auth.NewToken()
	if err != nil {
		fail("%v", err)
	}
	var rs []string
	for _, r := range strings.Split(*roles, ",") {
		if r = strings.TrimSpace(r); r != "" {
			rs = append(rs, `"`+r+`"`)
		}
	}
	entry := fmt.Sprintf(`{"id":%q,"sha256":%q,"organization_id":%q,"principal":%q,"kind":%q,"roles":[%s]`, *id, sha, *org, *principal, *kind, strings.Join(rs, ","))
	if *expires != "" {
		entry += fmt.Sprintf(`,"expires_at":%q`, *expires)
	}
	entry += "}"
	// Validate exactly as the gateway will, before anyone pastes it into the registry.
	if _, err := auth.Parse([]byte(`{"tokens":[` + entry + `]}`)); err != nil {
		fail("%v", err)
	}
	fmt.Fprintf(os.Stderr, "TOKEN (shown once, store it in a secret manager; it is not saved anywhere):\n%s\n\nAdd this entry to the \"tokens\" list of the principal registry:\n", token)
	fmt.Println(entry)
}

func serve() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	principals := env("HELIX_GATEWAY_PRINCIPALS", "")
	if principals == "" {
		fail("HELIX_GATEWAY_PRINCIPALS is required (the principal registry; see `helix-gateway mint-token`)")
	}
	listen := env("HELIX_GATEWAY_LISTEN", "127.0.0.1:8080")
	certFile, keyFile := env("HELIX_GATEWAY_TLS_CERT", ""), env("HELIX_GATEWAY_TLS_KEY", "")
	if (certFile == "") != (keyFile == "") {
		fail("HELIX_GATEWAY_TLS_CERT and HELIX_GATEWAY_TLS_KEY must be set together")
	}
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		fail("HELIX_GATEWAY_LISTEN must be host:port")
	}
	if ip := net.ParseIP(host); certFile == "" && !(host == "localhost" || (ip != nil && ip.IsLoopback())) {
		fail("refusing to listen on %s without TLS: set HELIX_GATEWAY_TLS_CERT and _KEY (or terminate TLS in front and listen on loopback)", listen)
	}

	kc, closeKernel, err := kernelclient.Dial(env("HELIX_GATEWAY_KERNEL_ADDR", "127.0.0.1:50051"), kernelclient.TLS{
		CAFile: env("HELIX_GATEWAY_KERNEL_TLS_CA", ""), CertFile: env("HELIX_GATEWAY_KERNEL_TLS_CERT", ""), KeyFile: env("HELIX_GATEWAY_KERNEL_TLS_KEY", ""),
	})
	if err != nil {
		fail("%v", err)
	}
	defer closeKernel()

	holder := auth.Open(principals, time.Second)
	if _, err := holder.Current(); err != nil {
		log.Warn("the principal registry is not valid; nobody can authenticate until it is fixed", "error", err.Error())
	}
	srv := api.New(api.Config{Kernel: kc, Auth: holder, Log: log})
	httpServer := &http.Server{
		Addr: listen, Handler: srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 32 << 10,
		TLSConfig:      &tls.Config{MinVersion: tls.VersionTLS12},
	}

	// Metrics are on their OWN loopback listener: no tokens, nothing to log in to, never on the public port.
	metricsListen := env("HELIX_GATEWAY_METRICS_LISTEN", "127.0.0.1:9101")
	if mh, _, err := net.SplitHostPort(metricsListen); err != nil || !(mh == "localhost" || (net.ParseIP(mh) != nil && net.ParseIP(mh).IsLoopback())) {
		fail("HELIX_GATEWAY_METRICS_LISTEN must be a loopback host:port (scrape it through your own proxy or tunnel): %q", metricsListen)
	}
	go func() {
		mux := http.NewServeMux()
		mux.Handle("GET /metrics", srv.Metrics().Handler())
		ms := &http.Server{Addr: metricsListen, Handler: mux, ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 10 * time.Second}
		if err := ms.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("metrics listener", "error", err.Error())
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() {
		log.Info("helix-gateway listening", "addr", listen, "tls", certFile != "")
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
