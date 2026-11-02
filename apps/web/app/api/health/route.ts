import { NextResponse } from "next/server";
import { cachedHealth } from "@/server/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Public liveness + backend-hop check. GET only; reveals no configuration. */
export async function GET() {
  const { status, body } = await cachedHealth();
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
