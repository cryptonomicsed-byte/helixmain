package auth

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func mustToken(t *testing.T) (string, string) {
	t.Helper()
	tok, sha, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	return tok, sha
}

func doc(entries ...string) []byte {
	return []byte(`{"tokens":[` + strings.Join(entries, ",") + `]}`)
}

func entry(id, sha, org, principal, kind, roles, expires string) string {
	e := `{"id":"` + id + `","sha256":"` + sha + `","organization_id":"` + org + `","principal":"` + principal + `","kind":"` + kind + `","roles":[` + roles + `]`
	if expires != "" {
		e += `,"expires_at":"` + expires + `"`
	}
	return e + "}"
}

func TestATokenFindsItsPrincipalAndNothingElseDoes(t *testing.T) {
	tok, sha := mustToken(t)
	r, err := Parse(doc(entry("t1", sha, "org_a", "user:alice", "user", `"reviewer"`, "")))
	if err != nil {
		t.Fatal(err)
	}
	p := r.Authenticate(tok, time.Now())
	if p == nil || p.Org != "org_a" || p.ID != "user:alice" || p.Kind != KindUser || !p.Has(RoleReviewer) || p.Has(RoleGrantAdmin) {
		t.Fatalf("%+v", p)
	}
	for _, bad := range []string{"", "hxg_", tok + "x", tok[:len(tok)-1], strings.ToUpper(tok), "Bearer " + tok, sha, "hxg_" + strings.Repeat("A", 43)} {
		if r.Authenticate(bad, time.Now()) != nil {
			t.Errorf("%q must not authenticate", bad)
		}
	}
}

func TestTokensExpire(t *testing.T) {
	tok, sha := mustToken(t)
	r, err := Parse(doc(entry("t1", sha, "org_a", "user:alice", "user", "", "2026-12-01T00:00:00Z")))
	if err != nil {
		t.Fatal(err)
	}
	if r.Authenticate(tok, time.Date(2026, 11, 30, 23, 59, 59, 0, time.UTC)) == nil {
		t.Error("valid until the instant it expires")
	}
	if r.Authenticate(tok, time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)) != nil {
		t.Error("expired at expires_at")
	}
}

func TestOneBadEntryRejectsTheFile(t *testing.T) {
	_, sha := mustToken(t)
	_, sha2 := mustToken(t)
	good := entry("t1", sha, "org_a", "user:alice", "user", "", "")
	cases := map[string][]byte{
		"empty file":                   []byte(""),
		"not json":                     []byte("tokens: []"),
		"unknown field":                []byte(`{"tokens":[],"admin":true}`),
		"trailing content":             append(doc(good), []byte(` {}`)...),
		"short hash":                   doc(entry("t2", "abc", "org_a", "user:bob", "user", "", "")),
		"upper-case hash":              doc(entry("t2", strings.ToUpper(sha2), "org_a", "user:bob", "user", "", "")),
		"unknown kind":                 doc(entry("t2", sha2, "org_a", "root", "root", "", "")),
		"no organisation":              doc(entry("t2", sha2, "", "user:bob", "user", "", "")),
		"duplicate id":                 doc(good, entry("t1", sha2, "org_a", "user:bob", "user", "", "")),
		"same token twice":             doc(good, entry("t2", sha, "org_a", "user:bob", "user", "", "")),
		"a user cannot be an executor": doc(entry("t2", sha2, "org_a", "user:bob", "user", `"executor"`, "")),
		"an agent has no roles":        doc(entry("t2", sha2, "org_a", "sid_x", "agent", `"proposer"`, "")),
		"an agent must be a sid":       doc(entry("t2", sha2, "org_a", "someone", "agent", "", "")),
		"unknown role":                 doc(entry("t2", sha2, "org_a", "svc:x", "service", `"root"`, "")),
		"bad expiry":                   doc(entry("t2", sha2, "org_a", "user:bob", "user", "", "tomorrow")),
		"bad owner":                    []byte(`{"agents":[{"organization_id":"org_a","sid":"sid_x","owners":["a b"]}]}`),
		"agent without sid":            []byte(`{"agents":[{"organization_id":"org_a","sid":"x","owners":[]}]}`),
	}
	for name, raw := range cases {
		if _, err := Parse(raw); err == nil {
			t.Errorf("%s: should be rejected", name)
		}
	}
	if _, err := Parse(doc(good)); err != nil {
		t.Fatalf("the good document must load: %v", err)
	}
}

func TestOwners(t *testing.T) {
	r, err := Parse([]byte(`{"agents":[{"organization_id":"org_a","sid":"sid_front-desk","owners":["user:alice"]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if !r.IsOwner("org_a", "sid_front-desk", "user:alice") {
		t.Error("alice owns it")
	}
	for _, c := range [][3]string{{"org_a", "sid_front-desk", "user:bob"}, {"org_b", "sid_front-desk", "user:alice"}, {"org_a", "sid_other", "user:alice"}} {
		if r.IsOwner(c[0], c[1], c[2]) {
			t.Errorf("%v must not be an owner", c)
		}
	}
}

func TestTheHolderFollowsTheFileAndFailsClosed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "principals.json")
	tok, sha := mustToken(t)
	write := func(b []byte) {
		t.Helper()
		if err := os.WriteFile(path, b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(doc(entry("t1", sha, "org_a", "user:alice", "user", "", "")))
	h := Open(path, 0)

	reg, err := h.Current()
	if err != nil || reg.Authenticate(tok, time.Now()) == nil {
		t.Fatalf("loaded: %v", err)
	}

	// An operator revokes the token by emptying the list: effective at once.
	write(doc())
	reg, err = h.Current()
	if err != nil || reg.Authenticate(tok, time.Now()) != nil {
		t.Fatal("a removed token must stop working")
	}

	// A broken edit authenticates NOBODY, not even tokens that were fine before.
	write(doc(entry("t1", sha, "org_a", "user:alice", "user", "", "")))
	if reg, _ = h.Current(); reg == nil {
		t.Fatal("restored")
	}
	write([]byte(`{"tokens":[{"id":`))
	reg, err = h.Current()
	if reg != nil || err == nil {
		t.Fatal("an invalid registry must authenticate nobody")
	}

	// And the file going away is the same.
	write(doc(entry("t1", sha, "org_a", "user:alice", "user", "", "")))
	if reg, _ = h.Current(); reg == nil {
		t.Fatal("restored")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if reg, err = h.Current(); reg != nil || err == nil {
		t.Fatal("a missing registry must authenticate nobody")
	}
}

func TestNewTokensAreRandomAndWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		tok, sha := mustToken(t)
		if !tokRe.MatchString(tok) || HashToken(tok) != sha || seen[tok] {
			t.Fatalf("bad token %q", tok)
		}
		seen[tok] = true
	}
}
