/**
 * BASHT HQ feature flag. Off unless the build sets NEXT_PUBLIC_HQ_ENABLED=1 (owner decision: off in production until final
 * approval). Not a secret — it only decides whether the HQ tab and route exist in this build.
 */
export const HQ_ENABLED = process.env.NEXT_PUBLIC_HQ_ENABLED === "1";
