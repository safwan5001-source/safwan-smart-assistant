/** What a finished owner turn changes about the «retry» copy, the error line and the text handed to a waiting voice session. Pure. */
import { runErrorRetryable, runErrorText } from "./run-error";

export type TurnRun = { status: "running" | "done" | "error" | "stopped"; text: string; errorCode?: string };
export type TurnOutcome<T> = {
  /** The copy whose photo previews can be released (the turn ended for good). */
  finished: T | null;
  /** What `lastTurn` becomes: nothing after success or a rate limit (a resend would hit the limit again), the same turn after another failure. */
  nextLastTurn: T | null;
  /** The turn offered for «إعادة المحاولة», if any. */
  failed: T | null;
  /** The text a waiting voice session receives. */
  endText: string;
  /** The error line for the conversation ("" when there is none). */
  error: string;
};
export function turnOutcome<T>(run: TurnRun, lastTurn: T | null): TurnOutcome<T> {
  const limited = run.status === "error" && !runErrorRetryable(run);
  const over = run.status === "done" || limited;
  const nextLastTurn = over ? null : lastTurn;
  return {
    finished: over ? lastTurn : null,
    nextLastTurn,
    failed: run.status !== "done" && nextLastTurn ? nextLastTurn : null,
    endText: limited ? runErrorText(run) : run.text,
    error: run.status === "error" ? runErrorText(run) : run.status === "stopped" ? "أُوقف الرد." : "",
  };
}
