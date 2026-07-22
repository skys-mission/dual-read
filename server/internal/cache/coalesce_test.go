package cache

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestGetOrLoadCoalescedOutcome(t *testing.T) {
	local, err := NewLocal(time.Minute, 8)
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	chain := NewChain(local, nil)

	var calls atomic.Int32
	var wg sync.WaitGroup
	outcomes := make([]Outcome, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, out, err := chain.GetOrLoad(context.Background(), "k", func(ctx context.Context) ([]byte, error) {
				calls.Add(1)
				time.Sleep(40 * time.Millisecond)
				return []byte("v"), nil
			}, true)
			if err != nil {
				t.Errorf("load: %v", err)
				return
			}
			outcomes[i] = out
		}(i)
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("expected 1 load, got %d", calls.Load())
	}
	var miss, coalesced int
	for _, o := range outcomes {
		switch o {
		case OutcomeMISS:
			miss++
		case OutcomeCOALESCED:
			coalesced++
		case OutcomeHIT:
			// possible if some arrived after store
		default:
			t.Fatalf("unexpected outcome %q", o)
		}
	}
	if miss < 1 {
		t.Fatalf("expected at least one MISS leader, got outcomes=%v", outcomes)
	}
	if coalesced < 1 {
		t.Fatalf("expected COALESCED waiters, got outcomes=%v", outcomes)
	}

	_, out, err := chain.GetOrLoad(context.Background(), "k", func(ctx context.Context) ([]byte, error) {
		t.Fatal("should not load")
		return nil, nil
	}, true)
	if err != nil || out != OutcomeHIT {
		t.Fatalf("expected HIT, got %s err=%v", out, err)
	}
}

func TestLeaderCancelDoesNotAbortWaiters(t *testing.T) {
	local, err := NewLocal(time.Minute, 8)
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	chain := NewChain(local, nil)
	chain.SetLoadTimeout(2 * time.Second)

	started := make(chan struct{})
	var calls atomic.Int32
	leaderCtx, cancelLeader := context.WithCancel(context.Background())

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		_, _, err := chain.GetOrLoad(leaderCtx, "cancel-key", func(ctx context.Context) ([]byte, error) {
			calls.Add(1)
			close(started)
			time.Sleep(80 * time.Millisecond)
			return []byte("ok"), nil
		}, true)
		if err == nil {
			t.Error("leader expected cancel error")
		}
	}()

	<-started
	cancelLeader()

	go func() {
		defer wg.Done()
		v, out, err := chain.GetOrLoad(context.Background(), "cancel-key", func(ctx context.Context) ([]byte, error) {
			t.Error("waiter must not start a second load")
			return nil, nil
		}, true)
		if err != nil {
			t.Errorf("waiter err: %v", err)
			return
		}
		if string(v) != "ok" {
			t.Errorf("waiter value=%q", v)
		}
		if out != OutcomeCOALESCED && out != OutcomeHIT {
			t.Errorf("waiter outcome=%s", out)
		}
	}()

	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("expected single upstream load, got %d", calls.Load())
	}
}

func TestBypassWhenDisabled(t *testing.T) {
	chain := NewChain(nil, nil)
	_, out, err := chain.GetOrLoad(context.Background(), "k", func(ctx context.Context) ([]byte, error) {
		return []byte("x"), nil
	}, true)
	if err != nil || out != OutcomeBYPASS {
		t.Fatalf("expected BYPASS, got %s err=%v", out, err)
	}
}
