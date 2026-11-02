import { handleNotify } from "@/server/notify/api";
import { getRuntime } from "@/server/notify/runtime";

// Never cached, evaluated per request (reads environment at runtime, not at build time).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ path: string[] }> };
const handler = async (req: Request, ctx: Ctx) => handleNotify(req, (await ctx.params).path, getRuntime());
export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
