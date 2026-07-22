package cache

import (
	"context"
	"sync"
	"time"
)

// DefaultLoadTimeout bounds coalesced upstream loads when no timeout is configured.
const DefaultLoadTimeout = 60 * time.Second

type flight struct {
	ready       chan struct{}
	val         []byte
	err         error
	leadOutcome Outcome
}

// Chain combines a fast local cache and a shared Valkey cache with a
// cancellation-safe coalescer.
type Chain struct {
	layersMu    sync.RWMutex
	local       *Local
	valkey      *Valkey
	loadTimeout time.Duration

	mu      sync.Mutex
	flights map[string]*flight
}

// NewChain builds a cache chain. Any layer may be nil if disabled.
func NewChain(local *Local, valkey *Valkey) *Chain {
	return &Chain{
		local:       local,
		valkey:      valkey,
		loadTimeout: DefaultLoadTimeout,
		flights:     make(map[string]*flight),
	}
}

// SetLoadTimeout sets the independent timeout for coalesced upstream loads.
func (c *Chain) SetLoadTimeout(d time.Duration) {
	if c == nil {
		return
	}
	if d <= 0 {
		d = DefaultLoadTimeout
	}
	c.mu.Lock()
	c.loadTimeout = d
	c.mu.Unlock()
}

func (c *Chain) timeout() time.Duration {
	if c == nil {
		return DefaultLoadTimeout
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.loadTimeout <= 0 {
		return DefaultLoadTimeout
	}
	return c.loadTimeout
}

// Enabled reports whether any cache layer is active.
func (c *Chain) Enabled() bool {
	if c == nil {
		return false
	}
	c.layersMu.RLock()
	defer c.layersMu.RUnlock()
	return c.local != nil || c.valkey != nil
}

func (c *Chain) layers() (*Local, *Valkey) {
	if c == nil {
		return nil, nil
	}
	c.layersMu.RLock()
	defer c.layersMu.RUnlock()
	return c.local, c.valkey
}

// Get tries local cache first, then Valkey. It warms the local cache on a Valkey hit.
func (c *Chain) Get(ctx context.Context, key string) ([]byte, bool) {
	if c == nil {
		return nil, false
	}
	local, valkey := c.layers()
	if local != nil {
		if v, ok := local.Get(key); ok {
			return v, true
		}
	}
	if valkey != nil {
		if v, ok := valkey.Get(ctx, key); ok {
			if local != nil {
				local.Set(key, v)
			}
			return v, true
		}
	}
	return nil, false
}

// Set writes the value to all enabled cache layers.
func (c *Chain) Set(ctx context.Context, key string, value []byte) {
	if c == nil {
		return
	}
	local, valkey := c.layers()
	if local != nil {
		local.Set(key, value)
	}
	if valkey != nil {
		valkey.Set(ctx, key, value)
	}
}

// ResetLocal drops all L1 entries (used after config generation bumps).
func (c *Chain) ResetLocal() {
	local, _ := c.layers()
	if local == nil {
		return
	}
	_ = local.Reset()
}

// GetOrLoad returns a cached value or runs load once per key.
//
// Coalescing rules:
//   - load runs under an independent timeout context (not the caller's cancelable ctx)
//   - waiter cancellation does not abort the in-flight load
//   - waiters that shared a flight receive OutcomeCOALESCED (not HIT)
//   - when no cache layer is enabled, OutcomeBYPASS is returned
func (c *Chain) GetOrLoad(
	ctx context.Context,
	key string,
	load func(context.Context) ([]byte, error),
	store bool,
) (value []byte, outcome Outcome, err error) {
	if c == nil || !c.Enabled() {
		parent := context.Background()
		if ctx != nil {
			parent = ctx
		}
		loadCtx, cancel := context.WithTimeout(parent, c.timeout())
		defer cancel()
		body, loadErr := load(loadCtx)
		return body, OutcomeBYPASS, loadErr
	}

	if v, ok := c.Get(ctx, key); ok {
		return v, OutcomeHIT, nil
	}

	c.mu.Lock()
	if f, ok := c.flights[key]; ok {
		c.mu.Unlock()
		return waitFlight(ctx, f)
	}
	f := &flight{ready: make(chan struct{})}
	c.flights[key] = f
	c.mu.Unlock()

	defer func() {
		c.mu.Lock()
		delete(c.flights, key)
		c.mu.Unlock()
		close(f.ready)
	}()

	// Double-check after winning the flight.
	if cached, ok := c.Get(ctx, key); ok {
		f.val = cached
		f.leadOutcome = OutcomeHIT
		if ctx.Err() != nil {
			return nil, OutcomeHIT, ctx.Err()
		}
		return cached, OutcomeHIT, nil
	}

	loadCtx, cancel := context.WithTimeout(context.Background(), c.timeout())
	defer cancel()
	body, loadErr := load(loadCtx)
	f.val = body
	f.err = loadErr
	f.leadOutcome = OutcomeMISS
	if loadErr == nil && store && body != nil {
		// Persist for waiters even if the leader request was cancelled.
		c.Set(context.Background(), key, body)
	}

	if ctx.Err() != nil {
		// Leader cancelled: waiters still receive the published result.
		return nil, OutcomeMISS, ctx.Err()
	}
	return body, OutcomeMISS, loadErr
}

func waitFlight(ctx context.Context, f *flight) ([]byte, Outcome, error) {
	select {
	case <-f.ready:
		if f.err != nil {
			return nil, OutcomeCOALESCED, f.err
		}
		if f.leadOutcome == OutcomeHIT {
			return f.val, OutcomeHIT, nil
		}
		return f.val, OutcomeCOALESCED, nil
	case <-ctx.Done():
		return nil, OutcomeCOALESCED, ctx.Err()
	}
}

// LocalLen reports the number of items currently held in local cache.
func (c *Chain) LocalLen() int {
	local, _ := c.layers()
	if local == nil {
		return 0
	}
	return local.Len()
}

// Valkey returns the Valkey layer, primarily for health checks.
func (c *Chain) Valkey() *Valkey {
	_, valkey := c.layers()
	return valkey
}

// LocalEnabled reports whether local cache is active.
func (c *Chain) LocalEnabled() bool {
	local, _ := c.layers()
	return local != nil
}

// ValkeyEnabled reports whether Valkey cache is active.
func (c *Chain) ValkeyEnabled() bool {
	_, valkey := c.layers()
	return valkey != nil
}

// ReplaceValkey atomically swaps the shared cache connection and returns the
// previous connection for the caller to close.
func (c *Chain) ReplaceValkey(valkey *Valkey) *Valkey {
	if c == nil {
		return nil
	}
	c.layersMu.Lock()
	old := c.valkey
	c.valkey = valkey
	c.layersMu.Unlock()
	return old
}
