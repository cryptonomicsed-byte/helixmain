package resolver

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// ErrNotFound is returned by Store.Get for a reference with no resolution.
var ErrNotFound = errors.New("no resolution stored")

var hashRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Store keeps the latest signed resolution for each reference, keyed by the
// reference's hash. The bytes are stored exactly as the publisher signed them.
type Store interface {
	Get(refHash string) ([]byte, error)
	Put(refHash string, raw []byte) error
}

// FileStore is a directory of <hash>.json files, written atomically.
type FileStore struct{ Dir string }

func (s FileStore) path(refHash string) (string, error) {
	if !hashRe.MatchString(refHash) { // never build a path from anything but 64 hex characters
		return "", fmt.Errorf("not a reference hash")
	}
	return filepath.Join(s.Dir, refHash+".json"), nil
}

func (s FileStore) Get(refHash string) ([]byte, error) {
	p, err := s.path(refHash)
	if err != nil {
		return nil, ErrNotFound
	}
	raw, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return raw, err
}

func (s FileStore) Put(refHash string, raw []byte) error {
	p, err := s.path(refHash)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.Dir, ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}
