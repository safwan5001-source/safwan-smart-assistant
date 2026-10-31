import { NextResponse } from "next/server";
import { buildHealth } from "@/server/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Public liveness + backend-hop check. GET only; reveals no configuration. */
export async function GET() {
  const { status, body } = await buildHealth();
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
