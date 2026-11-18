import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { withProgress, progressSteps, progressBeat, beatWhilePending, progressActive, PENDING_BEAT_MS, BEAT_MIN_MS } from "../src/progress.ts";

type Sent = { progressToken: string | number; progress: number; total?: number; message?: string };

function recorder() {
  const sent: Sent[] = [];
  return { sent, extra: { _meta: { progressToken: "tok" }, sendNotification: async (n: { method: string; params: Record<string, unknown> }) => void sent.push(n.params as Sent) } };
}

test("no progressToken: nothing is sent and progress is not active", async () => {
  const sent: unknown[] = [];
  await withProgress({ sendNotification: async (n: unknown) => void sent.push(n) }, async () => {
    assert.equal(progressActive(), false);
    const p = progressSteps(3);
    p.step("a");
    progressBeat("b");
    p.end();
  });
  // Outside any call scope too.
  progressSteps(2).step();
  progressBeat();
  assert.deepEqual(sent, []);
});

test("units count up to the total; beats stay below the next unit; the value always increases", async () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    const { sent, extra } = recorder();
    await withProgress(extra, async () => {
      assert.equal(progressActive(), true);
      progressBeat("first request");
      const p = progressSteps(2);
      mock.timers.tick(BEAT_MIN_MS);
      progressBeat("working");
      mock.timers.tick(BEAT_MIN_MS);
      p.step("item 1");
      progressBeat("too soon after a unit: dropped");
      mock.timers.tick(BEAT_MIN_MS);
      p.step("item 2");
      p.end();
    });
    assert.deepEqual(
      sent.map((s) => [s.progress, s.total, s.message]),
      [
        [0.5, undefined, "first request"],
        [1 - 1 / 3, 2, "working"],
        [1, 2, "item 1"],
        [2, 2, "item 2"],
      ],
    );
    for (let i = 1; i < sent.length; i++) assert.ok(sent[i].progress > sent[i - 1].progress);
  } finally {
    mock.timers.reset();
  }
});

test("a counter inside another reports beats; a later counter adds its total to the units already done", async () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    const { sent, extra } = recorder();
    await withProgress(extra, async () => {
      const outer = progressSteps(2);
      const inner = progressSteps(50);
      mock.timers.tick(BEAT_MIN_MS);
      inner.step("cue 1 of 50");
      inner.end();
      mock.timers.tick(BEAT_MIN_MS);
      outer.step("sequence 1");
      mock.timers.tick(BEAT_MIN_MS);
      outer.step("sequence 2");
      outer.end();
      const cook = progressSteps(2);
      mock.timers.tick(BEAT_MIN_MS);
      cook.step("cook 1");
      mock.timers.tick(BEAT_MIN_MS);
      cook.step("cook 2");
      cook.end();
    });
    assert.deepEqual(
      sent.map((s) => [s.progress, s.total, s.message]),
      [
        [0.5, 2, "cue 1 of 50"],
        [1, 2, "sequence 1"],
        [2, 2, "sequence 2"],
        [3, 4, "cook 1"],
        [4, 4, "cook 2"],
      ],
    );
  } finally {
    mock.timers.reset();
  }
});

test("a long request beats every PENDING_BEAT_MS until it settles", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval"] });
  try {
    const { sent, extra } = recorder();
    await withProgress(extra, async () => {
      const stop = beatWhilePending(() => "waiting for the console (cook)");
      mock.timers.tick(PENDING_BEAT_MS);
      mock.timers.tick(PENDING_BEAT_MS);
      stop();
      mock.timers.tick(PENDING_BEAT_MS * 3);
    });
    assert.equal(sent.length, 2);
    assert.ok(sent.every((s) => s.message === "waiting for the console (cook)" && s.progress < 1));
  } finally {
    mock.timers.reset();
  }
});

test("a failing notification never fails the call", async () => {
  const extra = { _meta: { progressToken: 7 }, sendNotification: async () => Promise.reject(new Error("closed")) };
  const r = await withProgress(extra, async () => {
    const p = progressSteps(1);
    p.step("x");
    p.end();
    return "done";
  });
  assert.equal(r, "done");
});

test("a beat after the last unit never passes the advertised total: a one-unit build whose clean-up waits > 5 s", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval"] });
  try {
    const { sent, extra } = recorder();
    await withProgress(extra, async () => {
      const p = progressSteps(1);
      mock.timers.tick(BEAT_MIN_MS);
      p.step("preset 1 of 1");
      // Still inside the counter: a beat beyond the total carries no total.
      mock.timers.tick(BEAT_MIN_MS);
      progressBeat("leaving Preview");
      p.end();
      const stop = beatWhilePending(() => "waiting for the console (Preview Off)");
      mock.timers.tick(PENDING_BEAT_MS);
      stop();
    });
    assert.deepEqual(sent.map((s) => [s.progress, s.total]), [[1, 1], [1.5, undefined], [2 - 1 / 3, undefined]]);
    assert.ok(sent.every((s) => s.total === undefined || s.progress <= s.total));
  } finally {
    mock.timers.reset();
  }
});
