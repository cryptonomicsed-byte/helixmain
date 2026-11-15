// Package metrics is a small Prometheus-text-format registry with no
// dependencies: counters, gauges and histograms with labels, safe for
// concurrent use, plus gauges computed at scrape time.
//
// Label values come from code, never from a request: callers pass the route
// pattern, the status class and the outcome name, so a hostile client cannot
// create series (the registry also caps the number of series per metric).
package metrics

import (
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
)

const maxSeriesPerMetric = 500

type Registry struct {
	mu      sync.Mutex
	metrics map[string]*family
	order   []string
	scrape  []func(*Registry)
}

type family struct {
	name, help, kind string
	buckets          []float64
	series           map[string]*series
}

type series struct {
	labels string
	value  float64  // counters and gauges
	counts []uint64 // histograms: cumulative at write time
	sum    float64
	count  uint64
}

func New() *Registry { return &Registry{metrics: map[string]*family{}} }

func (r *Registry) fam(name, help, kind string, buckets []float64) *family {
	f, ok := r.metrics[name]
	if !ok {
		f = &family{name: name, help: help, kind: kind, buckets: buckets, series: map[string]*series{}}
		r.metrics[name] = f
		r.order = append(r.order, name)
	}
	return f
}

// labelString renders alternating key, value pairs in a stable order.
func labelString(kv []string) string {
	if len(kv) == 0 {
		return ""
	}
	type pair struct{ k, v string }
	ps := make([]pair, 0, len(kv)/2)
	for i := 0; i+1 < len(kv); i += 2 {
		ps = append(ps, pair{kv[i], kv[i+1]})
	}
	sort.Slice(ps, func(i, j int) bool { return ps[i].k < ps[j].k })
	var b strings.Builder
	b.WriteByte('{')
	for i, p := range ps {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `%s="%s"`, p.k, escape(p.v))
	}
	b.WriteByte('}')
	return b.String()
}

func escape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return strings.ReplaceAll(s, `"`, `\"`)
}

func (f *family) get(labels string) *series {
	s, ok := f.series[labels]
	if !ok {
		if len(f.series) >= maxSeriesPerMetric {
			labels = `{overflow="true"}`
			if s, ok = f.series[labels]; ok {
				return s
			}
		}
		s = &series{labels: labels}
		if f.kind == "histogram" {
			s.counts = make([]uint64, len(f.buckets))
		}
		f.series[labels] = s
	}
	return s
}

// Counter adds delta (>= 0) to a counter series.
func (r *Registry) Counter(name, help string, delta float64, kv ...string) {
	if delta < 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fam(name, help, "counter", nil).get(labelString(kv)).value += delta
}

// Gauge sets a gauge series.
func (r *Registry) Gauge(name, help string, v float64, kv ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fam(name, help, "gauge", nil).get(labelString(kv)).value = v
}

// Add adds delta (which may be negative) to a gauge series.
func (r *Registry) Add(name, help string, delta float64, kv ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fam(name, help, "gauge", nil).get(labelString(kv)).value += delta
}

// DefaultBuckets are request latencies in seconds.
var DefaultBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

// Observe records one value in a histogram series.
func (r *Registry) Observe(name, help string, v float64, kv ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	f := r.fam(name, help, "histogram", DefaultBuckets)
	s := f.get(labelString(kv))
	s.sum += v
	s.count++
	for i, b := range f.buckets {
		if v <= b {
			s.counts[i]++
		}
	}
}

// OnScrape registers a function run at the start of every scrape, for gauges
// that are read from elsewhere (the kernel's health, queue depths).
func (r *Registry) OnScrape(f func(*Registry)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.scrape = append(r.scrape, f)
}

// Value returns a counter or gauge series' current value (for tests).
func (r *Registry) Value(name string, kv ...string) float64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	f, ok := r.metrics[name]
	if !ok {
		return 0
	}
	if s, ok := f.series[labelString(kv)]; ok {
		return s.value
	}
	return 0
}

// Write renders the Prometheus text exposition format.
func (r *Registry) Write(w io.Writer) {
	r.mu.Lock()
	fns := append([]func(*Registry){}, r.scrape...)
	r.mu.Unlock()
	for _, f := range fns {
		f(r)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, name := range r.order {
		f := r.metrics[name]
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", f.name, strings.ReplaceAll(f.help, "\n", " "), f.name, f.kind)
		keys := make([]string, 0, len(f.series))
		for k := range f.series {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			s := f.series[k]
			switch f.kind {
			case "histogram":
				for i, b := range f.buckets {
					fmt.Fprintf(w, "%s_bucket%s %d\n", f.name, withLE(s.labels, formatFloat(b)), s.counts[i])
				}
				fmt.Fprintf(w, "%s_bucket%s %d\n", f.name, withLE(s.labels, "+Inf"), s.count)
				fmt.Fprintf(w, "%s_sum%s %s\n%s_count%s %d\n", f.name, s.labels, formatFloat(s.sum), f.name, s.labels, s.count)
			default:
				fmt.Fprintf(w, "%s%s %s\n", f.name, s.labels, formatFloat(s.value))
			}
		}
	}
}

func withLE(labels, le string) string {
	if labels == "" {
		return fmt.Sprintf(`{le="%s"}`, le)
	}
	return labels[:len(labels)-1] + fmt.Sprintf(`,le="%s"}`, le)
}

func formatFloat(v float64) string {
	if math.IsInf(v, 1) {
		return "+Inf"
	}
	if v == math.Trunc(v) && math.Abs(v) < 1e15 {
		return fmt.Sprintf("%d", int64(v))
	}
	return fmt.Sprintf("%g", v)
}

// Handler serves the registry. GET only.
func (r *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodGet {
			http.Error(w, "use GET", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		r.Write(w)
	})
}
