/** The one timeline of the conversation: this device's events, the engine's rows, and sent photos still waiting for their row — by time. */
export type TimelineItem<L, E, P> =
  | { kind: "local"; at: number; m: L } | { kind: "engine"; at: number; m: E; i: number } | { kind: "pending"; at: number; p: P };
export function buildTimeline<L extends { created: number }, E extends { at: number }, P extends { sentAt: number }>(
  a: { local: readonly L[]; engine: readonly E[]; pending: readonly P[] }): TimelineItem<L, E, P>[] {
  const items: TimelineItem<L, E, P>[] = [
    ...a.local.map((m) => ({ kind: "local" as const, at: m.created, m })),
    ...a.engine.map((m, i) => ({ kind: "engine" as const, at: m.at, m, i })),
    ...a.pending.map((p) => ({ kind: "pending" as const, at: p.sentAt, p })),
  ];
  return items.sort((x, y) => x.at - y.at);
}
