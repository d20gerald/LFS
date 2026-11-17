/** A tiny keyed async mutex so two button clicks on one lobby never interleave. */
const chains = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  chains.set(key, next);
  try {
    return await next;
  } finally {
    if (chains.get(key) === next) chains.delete(key);
  }
}
