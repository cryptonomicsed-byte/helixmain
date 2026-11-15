// Package kernelclient dials the kernel. Off loopback it insists on mutual TLS:
// the kernel believes the RequestContext the gateway sends, so the channel that
// carries it must be authenticated both ways.
package kernelclient

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"os"

	kernelv1 "github.com/cryptonomicsed-byte/helixmain/agent-os/gateway/gen/helix/kernel/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

// TLS is the gateway's client identity and the CA that signed the kernel's certificate.
type TLS struct {
	CAFile, CertFile, KeyFile string
}

func (t TLS) empty() bool { return t.CAFile == "" && t.CertFile == "" && t.KeyFile == "" }

func isLoopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Dial returns a client and a function that closes it.
func Dial(addr string, t TLS) (kernelv1.KernelClient, func() error, error) {
	var creds credentials.TransportCredentials
	switch {
	case t.empty():
		if !isLoopback(addr) {
			return nil, nil, errors.New("refusing to talk to a non-loopback kernel without mutual TLS: set the kernel TLS CA, certificate and key")
		}
		creds = insecure.NewCredentials()
	case t.CAFile == "" || t.CertFile == "" || t.KeyFile == "":
		return nil, nil, errors.New("the kernel TLS CA, certificate and key must all be set together")
	default:
		pair, err := tls.LoadX509KeyPair(t.CertFile, t.KeyFile)
		if err != nil {
			return nil, nil, fmt.Errorf("client certificate: %w", err)
		}
		ca, err := os.ReadFile(t.CAFile)
		if err != nil {
			return nil, nil, fmt.Errorf("kernel CA: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(ca) {
			return nil, nil, errors.New("the kernel CA file contains no certificate")
		}
		creds = credentials.NewTLS(&tls.Config{Certificates: []tls.Certificate{pair}, RootCAs: pool, MinVersion: tls.VersionTLS12})
	}
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(creds))
	if err != nil {
		return nil, nil, err
	}
	return kernelv1.NewKernelClient(conn), conn.Close, nil
}
