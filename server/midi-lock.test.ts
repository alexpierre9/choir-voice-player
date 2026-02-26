/**
 * Tests for the MIDI generation lock mechanism.
 *
 * The lock (midiGenerationLocks Map) ensures that only one MIDI regeneration
 * runs at a time per sheet — subsequent calls wait for the current one to finish
 * rather than running concurrently. These tests verify that contract without
 * hitting the DB or Python service.
 */

import { describe, it, expect, vi } from "vitest";

/**
 * A standalone reproduction of the enqueueMidiRegeneration lock logic,
 * extracted from routers.ts for isolated unit testing.
 */
function createMidiLockQueue() {
  const locks = new Map<string, Promise<void>>();

  function enqueue(sheetId: string, task: () => Promise<void>): Promise<void> {
    const previous = locks.get(sheetId) ?? Promise.resolve();
    const next = previous
      .catch(() => {}) // don't let a previous failure block the chain
      .then(task);

    locks.set(sheetId, next);

    // Suppress the rejection propagated through .finally() so it doesn't
    // surface as an unhandled rejection when the task itself throws.
    next.finally(() => {
      if (locks.get(sheetId) === next) {
        locks.delete(sheetId);
      }
    }).catch(() => {});

    return next;
  }

  return { enqueue, locks };
}

describe("MIDI generation lock queue", () => {
  it("executes a single task immediately", async () => {
    const { enqueue } = createMidiLockQueue();
    let ran = false;

    await enqueue("sheet-1", async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });

  it("runs tasks for the same sheet sequentially, not concurrently", async () => {
    const { enqueue } = createMidiLockQueue();
    const order: number[] = [];

    let resolve1!: () => void;
    const blocker = new Promise<void>((r) => { resolve1 = r; });

    const t1 = enqueue("sheet-1", async () => {
      await blocker;
      order.push(1);
    });

    const t2 = enqueue("sheet-1", async () => {
      order.push(2);
    });

    // Before resolving the first blocker, t2 should not have run
    expect(order).toEqual([]);

    resolve1();
    await Promise.all([t1, t2]);

    // Must be sequential: 1 then 2
    expect(order).toEqual([1, 2]);
  });

  it("runs tasks for different sheets in parallel", async () => {
    const { enqueue } = createMidiLockQueue();
    const started: string[] = [];

    let resolveA!: () => void;
    let resolveB!: () => void;
    const blockerA = new Promise<void>((r) => { resolveA = r; });
    const blockerB = new Promise<void>((r) => { resolveB = r; });

    const tA = enqueue("sheet-A", async () => {
      started.push("A");
      await blockerA;
    });

    const tB = enqueue("sheet-B", async () => {
      started.push("B");
      await blockerB;
    });

    // Give both tasks a chance to start
    await Promise.resolve();
    await Promise.resolve();

    // Both should have started before either blocker resolves
    expect(started).toContain("A");
    expect(started).toContain("B");

    resolveA();
    resolveB();
    await Promise.all([tA, tB]);
  });

  it("cleans up the lock map entry after completion", async () => {
    const { enqueue, locks } = createMidiLockQueue();

    await enqueue("sheet-cleanup", async () => {});

    // After the task settles the entry should be removed
    expect(locks.has("sheet-cleanup")).toBe(false);
  });

  it("does not let a failed task block subsequent tasks", async () => {
    const { enqueue } = createMidiLockQueue();
    let secondRan = false;

    // First task fails — attach .catch immediately to avoid unhandled rejection
    const t1 = enqueue("sheet-fail", async () => {
      throw new Error("processing error");
    }).catch(() => {});

    // Second task should still run despite the first failing
    const t2 = enqueue("sheet-fail", async () => {
      secondRan = true;
    });

    await t1;
    await t2;

    expect(secondRan).toBe(true);
  });

  it("only the latest enqueued task keeps the lock entry alive", async () => {
    const { enqueue, locks } = createMidiLockQueue();

    let r1!: () => void, r2!: () => void;
    const b1 = new Promise<void>((r) => { r1 = r; });
    const b2 = new Promise<void>((r) => { r2 = r; });

    const t1 = enqueue("sheet-order", async () => { await b1; });
    const t2 = enqueue("sheet-order", async () => { await b2; });

    r1();
    await t1;

    // t2 is still pending — entry should still exist
    expect(locks.has("sheet-order")).toBe(true);

    r2();
    await t2;

    // After both settle the entry should be removed
    expect(locks.has("sheet-order")).toBe(false);
  });
});
