import { NextResponse } from "next/server";
import { buildHealth } from "@/server/health";

// Read BACKEND_URL at request time (never at build time) and never cache the answer.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Public liveness + API-hop check. GET only; reveals no configuration. */
export async function GET() {
  const { status, body } = await buildHealth();
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
