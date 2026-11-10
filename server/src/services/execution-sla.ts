export type ExecutionSlaStage = "warning" | "breach";

export function executionSlaStage(input: {
  firstIdentifiedAt: Date;
  now: Date;
  warningAt: Date | null;
  breachAt: Date | null;
}): ExecutionSlaStage | null {
  if (input.breachAt) return null;
  const elapsedMs = input.now.getTime() - input.firstIdentifiedAt.getTime();
  if (elapsedMs >= 45 * 60 * 1000) return "breach";
  if (!input.warningAt && elapsedMs >= 30 * 60 * 1000) return "warning";
  return null;
}

export function executionSlaRetryDue(attemptAt: Date | null, now: Date): boolean {
  return !attemptAt || attemptAt.getTime() <= now.getTime() - 5 * 60 * 1000;
}
