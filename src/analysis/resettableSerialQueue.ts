type QueueEpoch = {
  id: number;
  tail: Promise<void>;
  pending: Map<symbol, (error: Error) => void>;
};

type DedupeEntry<T> = {
  epochId: number;
  token: symbol;
  promise: Promise<T>;
};

export class ResettableSerialQueue {
  private epochCounter = 0;
  private epoch: QueueEpoch = this.createEpoch();
  private readonly dedupe = new Map<string, DedupeEntry<unknown>>();

  private createEpoch(): QueueEpoch {
    return {
      id: ++this.epochCounter,
      tail: Promise.resolve(),
      pending: new Map()
    };
  }

  enqueue<T>(task: () => Promise<T>, key?: string | null): Promise<T> {
    const dedupeKey = key || null;
    const existing = dedupeKey ? this.dedupe.get(dedupeKey) as DedupeEntry<T> | undefined : undefined;
    if (existing && existing.epochId === this.epoch.id) return existing.promise;

    const epoch = this.epoch;
    const token = Symbol("serial-queue-task");
    let rejectOuter!: (error: Error) => void;
    const promise = new Promise<T>((resolve, reject) => {
      rejectOuter = reject;
      epoch.pending.set(token, reject);
      epoch.tail = epoch.tail
        .catch(() => undefined)
        .then(async () => {
          if (this.epoch !== epoch || !epoch.pending.has(token)) return;
          try {
            const value = await task();
            if (this.epoch === epoch && epoch.pending.has(token)) resolve(value);
          } catch (error) {
            if (this.epoch === epoch && epoch.pending.has(token)) reject(
              error instanceof Error ? error : new Error("serial queue task failed")
            );
          } finally {
            epoch.pending.delete(token);
          }
        });
    });

    if (dedupeKey) {
      const entry: DedupeEntry<T> = { epochId: epoch.id, token, promise };
      this.dedupe.set(dedupeKey, entry as DedupeEntry<unknown>);
      void promise.finally(() => {
        const current = this.dedupe.get(dedupeKey);
        if (current?.token === token && current.epochId === epoch.id) this.dedupe.delete(dedupeKey);
      }).catch(() => undefined);
    }

    // Keep the rejector initialized before a synchronous reset can observe it.
    epoch.pending.set(token, rejectOuter);
    return promise;
  }

  reset(message = "serial queue reset") {
    const previous = this.epoch;
    this.epoch = this.createEpoch();
    const error = new Error(message);
    for (const reject of previous.pending.values()) reject(error);
    previous.pending.clear();
    for (const [key, entry] of this.dedupe) {
      if (entry.epochId === previous.id) this.dedupe.delete(key);
    }
  }
}
