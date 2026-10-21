import { NextResponse, type NextRequest } from "next/server";

/**
 * Demo mode only (FLOW_DEMO=1): give each new visitor a sandbox id in a cookie,
 * so their notes and chats are their own (see lib/sandbox.ts). The id is also
 * added to this very request, in case it's an API call that arrived first.
 */
export function middleware(req: NextRequest) {
  if (process.env.FLOW_DEMO !== "1" || req.cookies.get("flow_sandbox")) return NextResponse.next();
  const id = crypto.randomUUID();
  const headers = new Headers(req.headers);
  headers.set("cookie", [req.headers.get("cookie"), `flow_sandbox=${id}`].filter(Boolean).join("; "));
  const res = NextResponse.next({ request: { headers } });
  res.cookies.set("flow_sandbox", id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 24, path: "/" });
  return res;
}

// Pages and API routes; not Next's own files or the icon.
export const config = { matcher: ["/((?!_next/|icon).*)"] };
