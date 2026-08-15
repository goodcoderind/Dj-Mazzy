import { describe, expect, it, vi } from "vitest";
import { ResettableSerialQueue } from "./resettableSerialQueue";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("ResettableSerialQueue", () => {
  it("rejects old running and queued work, then starts a fresh epoch immediately", async () => {
    const queue = new ResettableSerialQueue();
    const blocked = deferred<string>();
    const first = queue.enqueue(() => blocked.promise, "first");
    const secondTask = vi.fn(async () => "second");
    const second = queue.enqueue(secondTask, "second");
    await Promise.resolve();

    queue.reset("analysis reset");
    const thirdTask = vi.fn(async () => "third");
    const third = queue.enqueue(thirdTask, "third");

    await expect(first).rejects.toThrow("analysis reset");
    await expect(second).rejects.toThrow("analysis reset");
    await expect(third).resolves.toBe("third");
    expect(secondTask).not.toHaveBeenCalled();
    expect(thirdTask).toHaveBeenCalledOnce();
    blocked.resolve("late");
  });

  it("does not let an old same-key finally delete its successor", async () => {
    const queue = new ResettableSerialQueue();
    const blocked = deferred<string>();
    const old = queue.enqueue(() => blocked.promise, "same");
    queue.reset();
    const successor = deferred<string>();
    const current = queue.enqueue(() => successor.promise, "same");
    blocked.resolve("old");
    await expect(old).rejects.toThrow("reset");
    expect(queue.enqueue(() => Promise.resolve("duplicate"), "same")).toBe(current);
    successor.resolve("current");
    await expect(current).resolves.toBe("current");
  });
});
