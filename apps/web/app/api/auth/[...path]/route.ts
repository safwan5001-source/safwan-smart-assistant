import { handleAuth } from "@/server/owner-auth";

// Never cached, evaluated per request (reads environment at runtime, not at build time).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ path: string[] }> };
const handler = async (req: Request, ctx: Ctx) => handleAuth(req, (await ctx.params).path);
export { handler as GET, handler as POST };
