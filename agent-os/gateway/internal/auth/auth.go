// Package auth maps a bearer token to the one thing the rest of the gateway is
// allowed to believe about a caller: which organisation, which principal, of
// which kind, with which roles. Nothing the client sends in a body or a header
// can change that answer.
//
// Tokens are 32 random bytes (`hxg_` + base64url). Only their SHA-256 is stored,
// in a registry file the operator owns, so the file by itself cannot be used to
// log in. The registry is re-read when it changes. If it becomes invalid the
// gateway authenticates NOBODY until it is fixed: it does not keep honouring
// tokens an operator may just have tried to revoke.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type Kind string

const (
	KindUser    Kind = "user"
	KindService Kind = "service"
	KindAgent   Kind = "agent"
)

type Role string

const (
	// RoleReviewer may answer a human review (and sees held decisions of its tenant).
	RoleReviewer Role = "reviewer"
	// RoleGrantAdmin may revoke grants.
	RoleGrantAdmin Role = "grant_admin"
	// RoleProposer (service) may propose actions on behalf of any agent of its tenant.
	RoleProposer Role = "proposer"
	// RoleExecutor (service) may begin executions and record their results.
	RoleExecutor Role = "executor"
	// RoleRegistrar (service) may register agent identities.
	RoleRegistrar Role = "registrar"
	// RolePluginAdmin (service) may install, upgrade and remove plugins.
	RolePluginAdmin Role = "plugin_admin"
)

var rolesForKind = map[Kind]map[Role]bool{
	KindUser:    {RoleReviewer: true, RoleGrantAdmin: true},
	KindService: {RoleProposer: true, RoleExecutor: true, RoleRegistrar: true, RoleGrantAdmin: true, RolePluginAdmin: true},
	KindAgent:   {},
}

// Principal is an authenticated caller.
type Principal struct {
	TokenID string
	Org     string
	ID      string
	Kind    Kind
	Roles   map[Role]bool
}

func (p *Principal) Has(r Role) bool { return p.Roles[r] }

// TokenEntry and AgentEntry are the registry file's records.
type TokenEntry struct {
	ID        string   `json:"id"`
	SHA256    string   `json:"sha256"`
	Org       string   `json:"organization_id"`
	Principal string   `json:"principal"`
	Kind      string   `json:"kind"`
	Roles     []string `json:"roles"`
	ExpiresAt string   `json:"expires_at"`
}

type AgentEntry struct {
	Org    string   `json:"organization_id"`
	SID    string   `json:"sid"`
	Owners []string `json:"owners"`
}

type file struct {
	Tokens []TokenEntry `json:"tokens"`
	Agents []AgentEntry `json:"agents"`
}

type token struct {
	p       *Principal
	expires time.Time // zero = never
}

// Registry is an immutable, validated view of the registry file.
type Registry struct {
	tokens map[string]token // sha256 hex -> token
	owners map[string]map[string]bool
}

var (
	idRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:@\-]{0,127}$`)
	hexRe  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	sidRe  = regexp.MustCompile(`^sid_[a-z0-9][a-z0-9\-]{0,63}$`)
	tokRe  = regexp.MustCompile(`^hxg_[A-Za-z0-9_\-]{43}$`)
	errBad = errors.New("invalid registry")
)

// Parse validates a registry document. One bad entry rejects the whole file.
func Parse(raw []byte) (*Registry, error) {
	var f file
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("%w: %v", errBad, err)
	}
	if dec.More() {
		return nil, fmt.Errorf("%w: trailing content", errBad)
	}
	var problems []string
	bad := func(format string, a ...any) { problems = append(problems, fmt.Sprintf(format, a...)) }

	r := &Registry{tokens: map[string]token{}, owners: map[string]map[string]bool{}}
	ids := map[string]bool{}
	for i, t := range f.Tokens {
		at := fmt.Sprintf("token #%d", i+1)
		if t.ID != "" {
			at += " (" + t.ID + ")"
		}
		kind := Kind(t.Kind)
		allowed, kindOK := rolesForKind[kind]
		switch {
		case !idRe.MatchString(t.ID):
			bad("%s: id must match %s", at, idRe)
		case ids[t.ID]:
			bad("%s: duplicate id", at)
		}
		ids[t.ID] = true
		if !hexRe.MatchString(t.SHA256) {
			bad("%s: sha256 must be 64 lowercase hex characters", at)
		}
		if _, dup := r.tokens[t.SHA256]; dup {
			bad("%s: the same token appears twice", at)
		}
		if !idRe.MatchString(t.Org) {
			bad("%s: organization_id is required", at)
		}
		if !idRe.MatchString(t.Principal) {
			bad("%s: principal is required", at)
		}
		if !kindOK {
			bad("%s: kind must be user, service or agent", at)
		}
		if kind == KindAgent && !sidRe.MatchString(t.Principal) {
			bad("%s: an agent principal must be a SID id (sid_...)", at)
		}
		roles := map[Role]bool{}
		for _, role := range t.Roles {
			if !allowed[Role(role)] {
				bad("%s: a %s cannot hold the role %q", at, t.Kind, role)
			}
			roles[Role(role)] = true
		}
		var exp time.Time
		if t.ExpiresAt != "" {
			var err error
			if exp, err = time.Parse(time.RFC3339, t.ExpiresAt); err != nil {
				bad("%s: expires_at must be RFC 3339", at)
			}
		}
		r.tokens[t.SHA256] = token{p: &Principal{TokenID: t.ID, Org: t.Org, ID: t.Principal, Kind: kind, Roles: roles}, expires: exp}
	}
	for i, a := range f.Agents {
		at := fmt.Sprintf("agent #%d", i+1)
		if !idRe.MatchString(a.Org) || !sidRe.MatchString(a.SID) {
			bad("%s: organization_id and a SID id (sid_...) are required", at)
			continue
		}
		key := a.Org + "\x00" + a.SID
		if r.owners[key] != nil {
			bad("%s: %s is listed twice for %s", at, a.SID, a.Org)
		}
		set := map[string]bool{}
		for _, o := range a.Owners {
			if !idRe.MatchString(o) {
				bad("%s: owner %q is not a valid principal", at, o)
			}
			set[o] = true
		}
		r.owners[key] = set
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return nil, fmt.Errorf("%w: %s", errBad, strings.Join(problems, "; "))
	}
	return r, nil
}

// Authenticate returns the principal for a bearer token, or nil.
func (r *Registry) Authenticate(bearer string, now time.Time) *Principal {
	if !tokRe.MatchString(bearer) {
		return nil
	}
	t, ok := r.tokens[HashToken(bearer)]
	if !ok || (!t.expires.IsZero() && !now.Before(t.expires)) {
		return nil
	}
	return t.p
}

// IsOwner reports whether principal owns agent sid in org: the users an agent
// acts for, who alone may confirm its purchases.
func (r *Registry) IsOwner(org, sid, principal string) bool {
	return r.owners[org+"\x00"+sid][principal]
}

// HashToken is the stored form of a token.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NewToken makes a new random token and returns it with its stored hash. The
// token itself is shown once and never stored.
func NewToken() (token, sha string, err error) {
	var b [32]byte
	if _, err = rand.Read(b[:]); err != nil {
		return "", "", err
	}
	token = "hxg_" + base64.RawURLEncoding.EncodeToString(b[:])
	return token, HashToken(token), nil
}

// Holder follows the registry file.
type Holder struct {
	path     string
	interval time.Duration
	now      func() time.Time

	mu      sync.Mutex
	reg     *Registry
	err     error
	mtime   time.Time
	size    int64
	checked time.Time
}

// Open loads the file. It never fails: an unreadable or invalid file is a
// state (no one authenticates), reported by Current.
func Open(path string, interval time.Duration) *Holder {
	h := &Holder{path: path, interval: interval, now: time.Now}
	h.load()
	return h
}

func (h *Holder) load() {
	h.checked = h.now()
	st, err := os.Stat(h.path)
	if err != nil {
		h.reg, h.err = nil, fmt.Errorf("cannot read the principal registry: %w", err)
		return
	}
	h.mtime, h.size = st.ModTime(), st.Size()
	raw, err := os.ReadFile(h.path)
	if err != nil {
		h.reg, h.err = nil, fmt.Errorf("cannot read the principal registry: %w", err)
		return
	}
	h.reg, h.err = Parse(raw)
}

// Current returns the live registry, or nil and why there is none. The file is
// looked at most once per interval.
func (h *Holder) Current() (*Registry, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.now().Sub(h.checked) >= h.interval {
		st, err := os.Stat(h.path)
		if err != nil || !st.ModTime().Equal(h.mtime) || st.Size() != h.size {
			h.load()
		} else {
			h.checked = h.now()
		}
	}
	return h.reg, h.err
}
