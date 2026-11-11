/** Keep bounded company spans out of the noisy automatic-instrumentation queue.
 * Both queues retain the SDK's bounded buffering, exporter and flush semantics.
 * This is queue admission, not tenant authorization; the collector still verifies
 * company identity and scrubs every exported span.
 */
export interface QueueSpan { attributes: Record<string, unknown> }
export interface TraceQueue {
  onStart(...args: unknown[]): void;
  onEnd(span: QueueSpan): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}
const COMPANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isolateNativeSpanQueue(createQueue: () => TraceQueue): TraceQueue {
  const native = createQueue();
  const automatic = createQueue();
  let shutdown: Promise<void> | undefined;
  return {
    // BatchSpanProcessor's onStart is a no-op; admission occurs on ended attrs.
    onStart() {},
    onEnd(span) {
      const company = span.attributes["paperclip.task.run.company_id"];
      const queue = typeof company === "string" && COMPANY.test(company) ? native : automatic;
      queue.onEnd(span);
    },
    async forceFlush() { await Promise.all([native.forceFlush(), automatic.forceFlush()]); },
    shutdown() { return shutdown ??= Promise.all([native.shutdown(), automatic.shutdown()]).then(() => {}); },
  };
}
