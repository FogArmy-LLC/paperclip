import { describe, expect, it, vi } from "vitest";
import { isolateNativeSpanQueue, type TraceQueue } from "./native-span-queue.js";

describe("native evidence queue isolation", () => {
  it("preserves 200 company spans while 6000 automatic spans saturate their queue", () => {
    const queues: unknown[][] = [];
    const processor = isolateNativeSpanQueue(() => {
      const accepted: unknown[] = []; queues.push(accepted);
      return { onStart() {}, onEnd(s) { if (accepted.length < 2048) accepted.push(s); },
        async forceFlush() {}, async shutdown() {} };
    });
    for (let i = 0; i < 6000; i++) {
      processor.onEnd({ attributes: {} });
      if (i % 30 === 0) processor.onEnd({ attributes: { "paperclip.task.run.company_id": "bca6f421-1b87-48b0-b95d-87c073cc7090" } });
    }
    expect(queues.map(q => q.length)).toEqual([200, 2048]);
  });
  it("keeps malformed or absent company IDs ordinary and does not select a tenant", () => {
    const counts = [0, 0]; let index = 0;
    const processor = isolateNativeSpanQueue(() => {
      const n = index++;
      return { onStart() {}, onEnd() { counts[n]++; }, async forceFlush() {}, async shutdown() {} };
    });
    for (const value of [undefined, "not-a-company", 42, "", "bca6f421-1b87-48b0-b95d-87c073cc7090", "ee668315-e4d6-4232-a8bc-7d85d3f71234"]) {
      processor.onEnd({ attributes: { "paperclip.task.run.company_id": value } });
    }
    expect(counts).toEqual([2, 4]);
  });
  it("flushes both queues and shuts each down once across concurrent callers", async () => {
    const flush = vi.fn(async () => {}), stop = vi.fn(async () => {});
    const factory = (): TraceQueue => ({ onStart() {}, onEnd() {}, forceFlush: flush, shutdown: stop });
    const processor = isolateNativeSpanQueue(factory);
    await processor.forceFlush();
    await Promise.all([processor.shutdown(), processor.shutdown()]);
    expect(flush).toHaveBeenCalledTimes(2); expect(stop).toHaveBeenCalledTimes(2);
  });
});
