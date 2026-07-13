package cache

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestGetOrLoadSingleflight(t *testing.T) {
	local, err := NewLocal(time.Minute, 8)
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()

	chain := NewChain(local, nil)
	var calls atomic.Int32

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, err := chain.GetOrLoad(context.Background(), "k", func(ctx context.Context) ([]byte, error) {
				calls.Add(1)
				time.Sleep(30 * time.Millisecond)
				return []byte("v"), nil
			}, true)
			if err != nil {
				t.Errorf("load: %v", err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("expected 1 load, got %d", calls.Load())
	}

	v, out, err := chain.GetOrLoad(context.Background(), "k", func(ctx context.Context) ([]byte, error) {
		t.Fatal("should not load")
		return nil, nil
	}, true)
	if err != nil || out != OutcomeHIT || string(v) != "v" {
		t.Fatalf("expected cached hit, got out=%v v=%s err=%v", out, v, err)
	}
}
