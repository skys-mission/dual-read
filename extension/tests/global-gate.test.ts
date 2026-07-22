import { describe, expect, it } from 'vitest';
import { createFairGate } from '../lib/scheduler/global-gate';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('createFairGate', () => {
  it('limits concurrent runners', async () => {
    const gate = createFairGate(2);
    let concurrent = 0;
    let peak = 0;

    const job = () =>
      gate.run(async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await delay(30);
        concurrent--;
        return 1;
      });

    await Promise.all([job(), job(), job(), job()]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(gate.active).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it('releases waiters when an in-flight job is aborted via signal before start', async () => {
    const gate = createFairGate(1);
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    const first = gate.run(async () => {
      await delay(40);
      return 'a';
    }, ac1.signal);

    const second = gate.run(async () => 'b', ac2.signal);
    ac2.abort();

    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await expect(first).resolves.toBe('a');
    expect(gate.active).toBe(0);
  });

  it('rejects immediately when signal is already aborted', async () => {
    const gate = createFairGate(2);
    const ac = new AbortController();
    ac.abort();
    await expect(gate.run(async () => 1, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
