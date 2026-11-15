package kernelclient

import (
	"strings"
	"testing"
)

func TestOffLoopbackWithoutTLSIsRefused(t *testing.T) {
	for _, addr := range []string{"10.0.0.7:50051", "kernel.internal:50051", "0.0.0.0:50051", "[::2]:50051", "nonsense"} {
		if _, _, err := Dial(addr, TLS{}); err == nil {
			t.Errorf("%s: the gateway must not send identity claims over a channel nobody authenticated", addr)
		}
	}
	for _, addr := range []string{"127.0.0.1:50051", "localhost:50051", "[::1]:50051"} {
		_, closeFn, err := Dial(addr, TLS{})
		if err != nil {
			t.Errorf("%s: %v", addr, err)
			continue
		}
		_ = closeFn()
	}
}

func TestPartialTLSConfigurationIsRefused(t *testing.T) {
	for _, c := range []TLS{{CAFile: "ca.pem"}, {CertFile: "c.pem", KeyFile: "k.pem"}, {CAFile: "ca.pem", CertFile: "c.pem"}} {
		_, _, err := Dial("127.0.0.1:50051", c)
		if err == nil || !strings.Contains(err.Error(), "together") {
			t.Errorf("%+v: %v", c, err)
		}
	}
}
