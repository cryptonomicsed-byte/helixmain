// Package canonical is the HELIX canonical JSON, byte-identical with the Python
// reference (`json.dumps(obj, sort_keys=True, separators=(",", ":"),
// ensure_ascii=True)` after pruning), the TypeScript sid/card implementations
// and the Rust kernel. The golden vectors in agent-os/contracts/conformance
// are the contract; canonical_test.go replays every one.
//
// Rules: empty arrays and objects are dropped when they are object VALUES
// (bottom-up); keys are sorted; separators are compact; everything outside
// printable ASCII, DEL included, is \u-escaped (surrogate pairs above the BMP).
// Stricter than the others in one way: a non-integral number is an error, since
// the languages disagree on how to print floats and nothing signed contains one.
package canonical

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// ErrFloat is returned for a number that is not an integer.
var ErrFloat = errors.New("non-integral number in a signed document")

// JSON returns the canonical form of v, which must be built from the types
// encoding/json produces (map[string]any, []any, string, bool, nil,
// json.Number, float64) or Go integers.
func JSON(v any) (string, error) {
	var b strings.Builder
	if err := write(prune(v), &b); err != nil {
		return "", err
	}
	return b.String(), nil
}

// SHA256Hex is the lowercase hex SHA-256 of text.
func SHA256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// HashWithout is the SHA-256 of the canonical JSON of doc without the named
// top-level keys and without any key that starts with "_".
func HashWithout(doc map[string]any, excluded ...string) (string, error) {
	skip := map[string]bool{}
	for _, k := range excluded {
		skip[k] = true
	}
	body := map[string]any{}
	for k, v := range doc {
		if !skip[k] && !strings.HasPrefix(k, "_") {
			body[k] = v
		}
	}
	c, err := JSON(body)
	if err != nil {
		return "", err
	}
	return SHA256Hex(c), nil
}

func isEmpty(v any) bool {
	switch t := v.(type) {
	case []any:
		return len(t) == 0
	case map[string]any:
		return len(t) == 0
	}
	return false
}

func prune(v any) any {
	switch t := v.(type) {
	case []any:
		out := make([]any, len(t))
		for i, item := range t {
			out[i] = prune(item)
		}
		return out
	case []string:
		out := make([]any, len(t))
		for i, item := range t {
			out[i] = item
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			p := prune(val)
			if !isEmpty(p) {
				out[k] = p
			}
		}
		return out
	}
	return v
}

func writeString(s string, b *strings.Builder) {
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(b, `\u%04x`, r)
		case r < 0x80:
			b.WriteRune(r)
		default:
			r1, r2 := utf16.EncodeRune(r)
			if r1 == 0xfffd && r2 == 0xfffd { // in the BMP
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				fmt.Fprintf(b, `\u%04x\u%04x`, r1, r2)
			}
		}
	}
	b.WriteByte('"')
}

func writeInt(f float64, b *strings.Builder) error {
	if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || math.Abs(f) > 9.0e15 {
		return ErrFloat
	}
	b.WriteString(strconv.FormatInt(int64(f), 10))
	return nil
}

func write(v any, b *strings.Builder) error {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		writeString(t, b)
	case json.Number:
		if i, err := strconv.ParseInt(string(t), 10, 64); err == nil {
			b.WriteString(strconv.FormatInt(i, 10))
		} else if u, err := strconv.ParseUint(string(t), 10, 64); err == nil {
			b.WriteString(strconv.FormatUint(u, 10))
		} else {
			f, err := strconv.ParseFloat(string(t), 64)
			if err != nil {
				return ErrFloat
			}
			return writeInt(f, b)
		}
	case float64:
		return writeInt(t, b)
	case int:
		b.WriteString(strconv.FormatInt(int64(t), 10))
	case int64:
		b.WriteString(strconv.FormatInt(t, 10))
	case []any:
		b.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := write(item, b); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeString(k, b)
			b.WriteByte(':')
			if err := write(t[k], b); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("canonical: unsupported type %T", v)
	}
	return nil
}
