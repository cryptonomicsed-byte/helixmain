package ratelimit

import (
	"sync"
	"time"
)

// Limiter is a token bucket per key. It exists to stop one caller (a runaway
// agent loop, a stuck retry) from monopolising the kernel, not to be a quota
// system.
type Limiter struct {
	rate, burst float64
	now         func() time.Time

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

func New(ratePerSecond float64, burst int) *Limiter {
	return &Limiter{rate: ratePerSecond, burst: float64(burst), now: time.Now, buckets: map[string]*bucket{}}
}

// SetClock replaces the time source (tests).
func (l *Limiter) SetClock(now func() time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.now = now
}

// Allow takes one token for key. When there is none it returns how long to wait.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) > 10000 { // forget callers that have been quiet long enough to be full again
			for k, v := range l.buckets {
				if now.Sub(v.last).Seconds()*l.rate >= l.burst {
					delete(l.buckets, k)
				}
			}
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	return false, time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
}
