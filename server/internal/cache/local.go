package cache

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/allegro/bigcache/v3"
)

// Local is an in-memory cache backed by BigCache.
type Local struct {
	cache  *bigcache.BigCache
	logger *slog.Logger
}

const (
	maxLocalShards        = 16
	targetShardCapacityMB = 9 // accommodates the 8 MiB upstream response limit plus entry metadata
)

func localShardCount(maxMB int) int {
	shards := maxLocalShards
	for shards > 1 && maxMB/shards < targetShardCapacityMB {
		shards /= 2
	}
	return shards
}

// NewLocal creates a BigCache-backed local cache.
func NewLocal(ttl time.Duration, maxMB int, loggers ...*slog.Logger) (*Local, error) {
	var logger *slog.Logger
	if len(loggers) > 0 {
		logger = loggers[0]
	}
	cfg := bigcache.Config{
		Shards:             localShardCount(maxMB),
		LifeWindow:         ttl,
		CleanWindow:        ttl / 2,
		MaxEntriesInWindow: 1000 * 10 * 60,
		MaxEntrySize:       512 * 1024,
		HardMaxCacheSize:   maxMB,
		Verbose:            false,
	}
	cache, err := bigcache.New(context.Background(), cfg)
	if err != nil {
		return nil, fmt.Errorf("create bigcache: %w", err)
	}
	return &Local{cache: cache, logger: logger}, nil
}

// Get returns a cached value and whether it was found.
func (c *Local) Get(key string) ([]byte, bool) {
	val, err := c.cache.Get(key)
	if err != nil {
		return nil, false
	}
	return val, true
}

// Set stores a value in the cache.
func (c *Local) Set(key string, value []byte) {
	if err := c.cache.Set(key, value); err != nil && c.logger != nil {
		c.logger.Warn("local cache set failed",
			"error", err,
			"value_bytes", len(value),
		)
	}
}

// Reset removes all entries from the local cache.
func (c *Local) Reset() error {
	if c == nil || c.cache == nil {
		return nil
	}
	return c.cache.Reset()
}

// Len returns the current number of items in the cache.
func (c *Local) Len() int {
	return c.cache.Len()
}

// Close releases BigCache resources.
func (c *Local) Close() error {
	return c.cache.Close()
}
