/** Keep optional geometry work bounded even when a feed has many owners.
 * CSS reads have their own hard limit; remaining owners continue next frame. */
export const LAYOUT_CHUNK_SIZE = 2;

export function takeLayoutWork<T>(items: Iterable<T>): T[] {
  const batch: T[] = [];
  for (const item of items) {
    batch.push(item);
    if (batch.length === LAYOUT_CHUNK_SIZE) break;
  }
  return batch;
}
