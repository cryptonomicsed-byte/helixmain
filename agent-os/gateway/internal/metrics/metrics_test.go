package metrics

import (
	"bytes"
	"fmt"
	"strings"
	"sync"
	"testing"
)

func render(r *Registry) string {
	var b bytes.Buffer
	r.Write(&b)
	return b.String()
}

func TestCountersGaugesAndLabelsRenderInTheTextFormat(t *testing.T) {
	r := New()
	r.Counter("helix_requests_total", "Requests.", 1, "route", "POST /v1/x", "status", "200")
	r.Counter("helix_requests_total", "Requests.", 2, "route", "POST /v1/x", "status", "200")
	r.Counter("helix_requests_total", "Requests.", 1, "status", "403", "route", "POST /v1/x")
	r.Gauge("helix_up", "Up.", 1)
	r.Add("helix_in_flight", "In flight.", 3)
	r.Add("helix_in_flight", "In flight.", -1)
	out := render(r)
	for _, want := range []string{
		"# HELP helix_requests_total Requests.", "# TYPE helix_requests_total counter",
		`helix_requests_total{route="POST /v1/x",status="200"} 3`, `helix_requests_total{route="POST /v1/x",status="403"} 1`,
		"# TYPE helix_up gauge", "helix_up 1", "helix_in_flight 2",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if r.Value("helix_requests_total", "route", "POST /v1/x", "status", "200") != 3 {
		t.Error("Value")
	}
}

func TestHistogramsAreCumulative(t *testing.T) {
	r := New()
	for _, v := range []float64{0.001, 0.02, 0.02, 0.4, 20} {
		r.Observe("helix_latency_seconds", "Latency.", v, "route", "r")
	}
	out := render(r)
	for _, want := range []string{
		`helix_latency_seconds_bucket{route="r",le="0.005"} 1`, `helix_latency_seconds_bucket{route="r",le="0.025"} 3`,
		`helix_latency_seconds_bucket{route="r",le="0.5"} 4`, `helix_latency_seconds_bucket{route="r",le="10"} 4`,
		`helix_latency_seconds_bucket{route="r",le="+Inf"} 5`, `helix_latency_seconds_count{route="r"} 5`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestLabelValuesAreEscaped(t *testing.T) {
	r := New()
	r.Counter("c", "c", 1, "k", "a\"b\\c\nd")
	if !strings.Contains(render(r), `c{k="a\"b\\c\nd"} 1`) {
		t.Fatal(render(r))
	}
}

func TestHostileLabelsCannotCreateUnboundedSeries(t *testing.T) {
	r := New()
	for i := 0; i < 5000; i++ {
		r.Counter("c", "c", 1, "v", fmt.Sprint(i))
	}
	lines := strings.Count(render(r), "\nc{")
	if lines > maxSeriesPerMetric+2 {
		t.Fatalf("%d series", lines)
	}
	if r.Value("c", "overflow", "true") == 0 {
		t.Fatal("the overflow series should have absorbed the rest")
	}
}

func TestScrapeTimeGaugesAreComputedFresh(t *testing.T) {
	r := New()
	n := 0
	r.OnScrape(func(r *Registry) { n++; r.Gauge("depth", "d", float64(n*10)) })
	if !strings.Contains(render(r), "depth 10") || !strings.Contains(render(r), "depth 20") {
		t.Fatal("each scrape reads the current value")
	}
}

func TestNegativeCounterDeltasAreIgnoredAndItIsConcurrencySafe(t *testing.T) {
	r := New()
	r.Counter("c", "c", -5)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				r.Counter("c", "c", 1)
				r.Observe("h", "h", 0.1)
			}
		}()
	}
	wg.Wait()
	if r.Value("c") != 5000 {
		t.Fatalf("%v", r.Value("c"))
	}
}
