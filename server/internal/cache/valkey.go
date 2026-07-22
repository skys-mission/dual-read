package cache

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Valkey wraps a Valkey/Redis client for shared caching.
type Valkey struct {
	client    *redis.Client
	keyPrefix string
	ttl       time.Duration
	logger    *slog.Logger

	statusMu  sync.RWMutex
	available bool
	lastError string
	onStatus  func(bool)

	monitorMu     sync.Mutex
	monitorCancel context.CancelFunc
	monitorDone   chan struct{}
}

// NewValkey creates a Valkey-backed cache.
func NewValkey(addr, password string, db int, keyPrefix string, ttl time.Duration, logger *slog.Logger) *Valkey {
	client := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: password,
		DB:       db,
	})
	return &Valkey{
		client:    client,
		keyPrefix: keyPrefix,
		ttl:       ttl,
		logger:    logger,
	}
}

// Ping verifies the Valkey connection.
func (v *Valkey) Ping(ctx context.Context) error {
	err := v.client.Ping(ctx).Err()
	v.setStatus(err)
	return err
}

// Close closes the Valkey client.
func (v *Valkey) Close() error {
	v.monitorMu.Lock()
	cancel := v.monitorCancel
	done := v.monitorDone
	v.monitorCancel = nil
	v.monitorDone = nil
	v.monitorMu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
	return v.client.Close()
}

// StartMonitor periodically retries unavailable Valkey connections. Cache
// requests remain non-blocking while the connection is down.
func (v *Valkey) StartMonitor(interval time.Duration) {
	if v == nil {
		return
	}
	if interval <= 0 {
		interval = 5 * time.Second
	}
	v.monitorMu.Lock()
	if v.monitorCancel != nil {
		v.monitorMu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	v.monitorCancel = cancel
	v.monitorDone = done
	v.monitorMu.Unlock()

	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				pingCtx, pingCancel := context.WithTimeout(ctx, 2*time.Second)
				_ = v.Ping(pingCtx)
				pingCancel()
			}
		}
	}()
}

// Available reports the latest known connection state.
func (v *Valkey) Available() bool {
	if v == nil {
		return false
	}
	v.statusMu.RLock()
	defer v.statusMu.RUnlock()
	return v.available
}

// LastError returns the latest safe connection error for diagnostics.
func (v *Valkey) LastError() string {
	if v == nil {
		return ""
	}
	v.statusMu.RLock()
	defer v.statusMu.RUnlock()
	return v.lastError
}

// SetStatusCallback registers an availability observer and immediately
// publishes the current state.
func (v *Valkey) SetStatusCallback(callback func(bool)) {
	if v == nil {
		return
	}
	v.statusMu.Lock()
	v.onStatus = callback
	available := v.available
	v.statusMu.Unlock()
	if callback != nil {
		callback(available)
	}
}

func (v *Valkey) setStatus(err error) {
	if v == nil {
		return
	}
	v.statusMu.Lock()
	wasAvailable := v.available
	previousError := v.lastError
	v.available = err == nil
	if err == nil {
		v.lastError = ""
	} else {
		v.lastError = err.Error()
	}
	onStatus := v.onStatus
	available := v.available
	v.statusMu.Unlock()
	if onStatus != nil {
		onStatus(available)
	}

	if v.logger == nil {
		return
	}
	if err == nil && !wasAvailable && previousError != "" {
		v.logger.Info("valkey connection recovered")
	}
	if err != nil && (wasAvailable || (previousError != "" && previousError != err.Error())) {
		v.logger.Warn("valkey unavailable", "error", err)
	}
}

func (v *Valkey) key(k string) string {
	return fmt.Sprintf("%s%s", v.keyPrefix, k)
}

// Get returns a cached value and whether it was found.
func (v *Valkey) Get(ctx context.Context, key string) ([]byte, bool) {
	if !v.Available() {
		return nil, false
	}
	val, err := v.client.Get(ctx, v.key(key)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false
	}
	if err != nil {
		v.setStatus(err)
		return nil, false
	}
	v.setStatus(nil)
	return val, true
}

// Set stores a value with the configured TTL.
func (v *Valkey) Set(ctx context.Context, key string, value []byte) {
	if !v.Available() {
		return
	}
	if err := v.client.Set(ctx, v.key(key), value, v.ttl).Err(); err != nil {
		v.setStatus(err)
	} else {
		v.setStatus(nil)
	}
}
