package qr

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"sort"
	"strings"
	"testing"
)

type vector struct {
	Name        string          `json:"name"`
	Kind        string          `json:"kind"`
	Subject     json.RawMessage `json:"subject"`
	Ref         json.RawMessage `json:"ref"`
	Res         json.RawMessage `json:"res"`
	Trust       json.RawMessage `json:"trust"`
	Now         *string         `json:"now"`
	FetchedFrom *string         `json:"fetched_from"`
	Requires    []string        `json:"requires"`
	Expect      struct {
		OK        bool   `json:"ok"`
		Trusted   bool   `json:"trusted"`
		Error     string `json:"error"`
		Untrusted string `json:"untrusted"`
	} `json:"expect"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	want, _ := os.ReadFile("testdata/SOURCE_SHA256")
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != strings.TrimSpace(string(want)) {
		t.Fatal("testdata/vectors.json is not the vendored copy: re-vendor it from the sid repo (conformance/qr) and update SOURCE_SHA256")
	}
	var doc struct {
		Vectors []vector `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Vectors
}

func trustOf(t *testing.T, raw json.RawMessage) *Trust {
	t.Helper()
	if string(raw) == "null" || len(raw) == 0 {
		return nil
	}
	tr, err := ParseTrust(raw)
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

func contains(list []string, sub string) bool {
	for _, s := range list {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func now(v vector) string {
	if v.Now == nil {
		return ""
	}
	return *v.Now
}

func check(t *testing.T, v vector, got *Verdict) {
	t.Helper()
	if got.OK != v.Expect.OK || got.Trusted != v.Expect.Trusted {
		t.Errorf("%s: ok=%v trusted=%v, want ok=%v trusted=%v (errors %q, untrusted %q)", v.Name, got.OK, got.Trusted, v.Expect.OK, v.Expect.Trusted, got.Errors, got.Untrusted)
	}
	if v.Expect.Error != "" && !contains(got.Errors, v.Expect.Error) {
		t.Errorf("%s: no error contains %q: %q", v.Name, v.Expect.Error, got.Errors)
	}
	if v.Expect.Untrusted != "" && !contains(got.Untrusted, v.Expect.Untrusted) {
		t.Errorf("%s: no untrusted reason contains %q: %q", v.Name, v.Expect.Untrusted, got.Untrusted)
	}
}

// What Go does not do, by design, so a vector cannot be silently skipped.
func skipped(v vector) bool {
	for _, r := range v.Requires {
		if r == "sid" || r == "bip340" {
			return true
		}
	}
	return false
}

func TestEveryApplicableSharedVectorAgrees(t *testing.T) {
	vectors := loadVectors(t)
	ran, skippedNames := 0, []string{}
	for _, v := range vectors {
		if skipped(v) {
			skippedNames = append(skippedNames, v.Name)
			continue
		}
		ran++
		trust := trustOf(t, v.Trust)
		switch v.Kind {
		case "reference":
			var subject string
			if err := json.Unmarshal(v.Subject, &subject); err != nil {
				// a bare document (no URL) carries no domain binding to check; the resolver always has a URL
				skippedNames = append(skippedNames, v.Name)
				ran--
				continue
			}
			_, got := VerifyReference(subject, trust, now(v))
			check(t, v, got)
		case "resolution-envelope":
			var refSubject = map[string]any{}
			if err := json.Unmarshal(v.Ref, &refSubject); err != nil {
				t.Fatal(err)
			}
			ref := referenceFromDoc(t, v.Ref)
			resAny, err := DecodeJSON(v.Res)
			if err != nil {
				t.Fatal(err)
			}
			from := ""
			if v.FetchedFrom != nil {
				from = *v.FetchedFrom
			}
			check(t, v, CheckEnvelope(resAny.(map[string]any), ref, trust, now(v), from))
		default:
			t.Errorf("%s: unknown vector kind %q", v.Name, v.Kind)
		}
	}
	sort.Strings(skippedNames)
	t.Logf("ran %d vectors; not applicable to this verifier: %v", ran, skippedNames)
	if ran < 80 {
		t.Fatalf("only %d vectors ran", ran)
	}
	// The skip list is part of the contract: it can only be vectors this verifier cannot or should not judge.
	for _, n := range skippedNames {
		if !(strings.HasPrefix(n, "contact-") || strings.HasPrefix(n, "pin-") || n == "reference-schnorr-issuer" || n == "reference-document-without-url") {
			t.Errorf("%s was skipped but should have run", n)
		}
	}
}

// referenceFromDoc builds the Reference a resolver would hold: a document that
// has already been verified (the vectors' refs are valid by construction).
func referenceFromDoc(t *testing.T, raw json.RawMessage) *Reference {
	t.Helper()
	d, err := DecodeJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	doc := d.(map[string]any)
	h, _ := docHash(doc)
	if given, _ := doc["hash"].(string); given != h {
		t.Fatal("the vector's reference does not hash to its own hash")
	}
	return &Reference{Doc: doc, Hash: h, Resolver: doc["resolver"].(string), SID: doc["sid"].(string)}
}

func TestABip340IssuerIsNeverTrustedByThisVerifier(t *testing.T) {
	for _, v := range loadVectors(t) {
		if v.Name != "reference-schnorr-issuer" {
			continue
		}
		var subject string
		_ = json.Unmarshal(v.Subject, &subject)
		_, got := VerifyReference(subject, trustOf(t, v.Trust), now(v))
		if got.Trusted || !got.OK || !contains(got.Untrusted, "bip340") {
			t.Fatalf("must be OK-but-untrusted, never trusted: %+v", got)
		}
		return
	}
	t.Fatal("the vector is missing")
}

func TestHostilePayloadsNeverPanic(t *testing.T) {
	trust := trustOf(t, loadVectors(t)[0].Trust)
	for _, s := range []string{"", "https://", "https://contact.example/q/", "https://contact.example/q/" + strings.Repeat("A", 5000),
		"https://contact.example/q/e30", "https://contact.example/q/bnVsbA", "https://contact.example/q/W10", "\x00\x01", "https://contact.example/q/_-_-",
		"https://contact.example/q/eyJmb3JtYXQiOiJoZWxpeC1xci8xIn0"} {
		_, v := VerifyReference(s, trust, "2026-11-20T12:00:00Z")
		if v.OK || len(v.Errors) == 0 {
			t.Errorf("%q must not verify", s)
		}
	}
}

func TestPublicHost(t *testing.T) {
	for host, want := range map[string]bool{
		"contact.example": true, "a.b.c.example": true, "x.co": true, "xn--bcher-kva.example": true,
		"localhost": false, "intranet": false, "10.0.0.1": false, "1.2.3.4": false, "kernel.internal": false, "printer.local": false,
		"Contact.Example": false, "contact_example.com": false, "-a.example": false, "a-.example": false, "": false, "a..example": false,
	} {
		if PublicHost(host) != want {
			t.Errorf("PublicHost(%q) = %v, want %v", host, !want, want)
		}
	}
}
