import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Preview-only infrastructure readiness. This does not query PostgreSQL or
 * Blob, and is not proof that credentials or permissions work.
 */
export function GET() {
  if (process.env.VERCEL_ENV !== "preview") {
    return new NextResponse(null, { status: 404 });
  }
  const database = Boolean(process.env.DATABASE_URL);
  const blob = Boolean(process.env.BLOB_STORE_ID);
  return NextResponse.json(
    {
      environment: "preview",
      checks: {
        neonConfigurationPresent: database,
        privateBlobStoreConfigurationPresent: blob,
      },
      databaseConnectionTested: false,
      privateBlobAccessTested: false,
      accountFeaturesEnabled: false,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
