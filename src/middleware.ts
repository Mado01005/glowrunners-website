import { NextResponse, type NextRequest } from "next/server";
import { getAdminSessionFromRequest } from "@/lib/adminAuth";

const ADMIN_LOGIN_PATH = "/admin/login";
const AUTH_SESSION_API_PATH = "/api/auth/session";

function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (
    pathname === ADMIN_LOGIN_PATH ||
    pathname === AUTH_SESSION_API_PATH ||
    (!isAdminPath(pathname) && !isApiPath(pathname))
  ) {
    return NextResponse.next();
  }

  const session = await getAdminSessionFromRequest(request);

  if (session !== null) {
    return NextResponse.next();
  }

  if (isApiPath(pathname)) {
    return NextResponse.json(
      {
        success: false,
        error: "Forbidden.",
      },
      {
        status: 403,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const loginUrl = new URL(ADMIN_LOGIN_PATH, request.url);
  loginUrl.searchParams.set("next", `${pathname}${search}`);

  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/admin/:path*", "/api/:path*"],
};
