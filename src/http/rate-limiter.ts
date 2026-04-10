/**
 * Per-request jitter delay for write operations.
 */

export const WRITE_DELAY = { min: 1500, max: 4000 };

/** Random jitter delay between writes. */
export async function writeDelay(): Promise<void> {
  const ms = WRITE_DELAY.min + Math.random() * (WRITE_DELAY.max - WRITE_DELAY.min);
  return new Promise((r) => setTimeout(r, ms));
}
