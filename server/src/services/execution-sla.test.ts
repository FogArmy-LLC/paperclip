import { describe, expect, it } from "vitest";
import { executionSlaRetryDue, executionSlaStage } from "./execution-sla.js";

const identifiedAt = new Date("2026-11-10T00:00:00.000Z");
const at = (minutes: number) => new Date(identifiedAt.getTime() + minutes * 60_000);

describe("execution SLA timing", () => {
  it("warns exactly at 30 minutes and breaches exactly at 45 without resetting the clock", () => {
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(29.999), warningAt: null, breachAt: null })).toBeNull();
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(30), warningAt: null, breachAt: null })).toBe("warning");
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(44.999), warningAt: null, breachAt: null })).toBe("warning");
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(45), warningAt: null, breachAt: null })).toBe("breach");
  });

  it("sends breach only when first observed after the deadline and never reopens terminal stages", () => {
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(46), warningAt: null, breachAt: null })).toBe("breach");
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(46), warningAt: at(30), breachAt: null })).toBe("breach");
    expect(executionSlaStage({ firstIdentifiedAt: identifiedAt, now: at(60), warningAt: at(30), breachAt: at(45) })).toBeNull();
  });

  it("retries a failed or unavailable dispatch after five minutes without changing first identification", () => {
    expect(executionSlaRetryDue(at(40), at(44.999))).toBe(false);
    expect(executionSlaRetryDue(at(40), at(45))).toBe(true);
    expect(executionSlaRetryDue(null, at(45))).toBe(true);
    expect(identifiedAt.toISOString()).toBe("2026-11-10T00:00:00.000Z");
  });
});
