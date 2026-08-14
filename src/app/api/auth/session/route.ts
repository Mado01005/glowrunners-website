import { NextResponse } from "next/server";
import {
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_COOKIE_OPTIONS,
  createAdminSessionToken,
  getAdminByUsername,
  getAdminSessionFromRequest,
  isAdminAuthConfigured,
  normalizeAdminUsername,
  verifyAdminPassword,
} from "@/lib/adminAuth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

type LoginRequestBody = Readonly<{
  username?: unknown;
  password?: unknown;
}>;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
} as const;

const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1_000;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_TRACKED_LOGIN_KEYS = 5_000;

type LoginAttempt = {
  count: number;
  resetAt: number;
};

const loginAttempts = new Map<string, LoginAttempt>();

function readLoginString(
  value: unknown,
  maximumLength: number,
): string | null {
  if (typeof value !== "string" || value.length > maximumLength) {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue : null;
}

function configurationErrorResponse() {
  return NextResponse.json(
    {
      success: false,
      error: "Admin authentication is not configured.",
    },
    {
      status: 500,
      headers: NO_STORE_HEADERS,
    },
  );
}

function getLoginAttemptKey(request: Request, username: string | null) {
  const forwardedFor =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";
  const normalizedUsername = username
    ? normalizeAdminUsername(username).slice(0, 80)
    : "missing";

  return `${forwardedFor}:${normalizedUsername || "invalid"}`;
}

function getRetryAfterSeconds(key: string, now: number) {
  const attempt = loginAttempts.get(key);

  if (!attempt) {
    return 0;
  }

  if (attempt.resetAt <= now) {
    loginAttempts.delete(key);
    return 0;
  }

  return attempt.count >= MAX_LOGIN_ATTEMPTS
    ? Math.max(1, Math.ceil((attempt.resetAt - now) / 1_000))
    : 0;
}

function recordFailedLogin(key: string, now: number) {
  if (loginAttempts.size >= MAX_TRACKED_LOGIN_KEYS) {
    for (const [candidateKey, attempt] of loginAttempts) {
      if (attempt.resetAt <= now) {
        loginAttempts.delete(candidateKey);
      }
    }

    if (loginAttempts.size >= MAX_TRACKED_LOGIN_KEYS) {
      loginAttempts.delete(loginAttempts.keys().next().value ?? "");
    }
  }

  const current = loginAttempts.get(key);

  loginAttempts.set(key, {
    count: current && current.resetAt > now ? current.count + 1 : 1,
    resetAt:
      current && current.resetAt > now
        ? current.resetAt
        : now + LOGIN_ATTEMPT_WINDOW_MS,
  });
}

export async function GET(request: Request) {
  const session = await getAdminSessionFromRequest(request);

  if (session === null) {
    return NextResponse.json(
      {
        authenticated: false,
      },
      {
        status: 401,
        headers: NO_STORE_HEADERS,
      },
    );
  }

  return NextResponse.json(
    {
      authenticated: true,
      admin: session.admin,
      expiresAt: session.expiresAt,
    },
    {
      headers: NO_STORE_HEADERS,
    },
  );
}

export async function POST(request: Request) {
  if (!isAdminAuthConfigured()) {
    return configurationErrorResponse();
  }

  const body = (await request.json().catch(() => null)) as
    | LoginRequestBody
    | null;
  const username = readLoginString(body?.username, 64);
  const password = readLoginString(body?.password, 256);
  const attemptKey = getLoginAttemptKey(request, username);
  const now = Date.now();
  const retryAfter = getRetryAfterSeconds(attemptKey, now);

  if (retryAfter > 0) {
    return NextResponse.json(
      {
        success: false,
        error: "Too many sign-in attempts. Wait and try again.",
      },
      {
        status: 429,
        headers: {
          ...NO_STORE_HEADERS,
          "Retry-After": String(retryAfter),
        },
      },
    );
  }

  const admin = username === null ? null : getAdminByUsername(username);

  if (
    admin === null ||
    password === null ||
    !verifyAdminPassword(admin, password)
  ) {
    recordFailedLogin(attemptKey, now);

    return NextResponse.json(
      {
        success: false,
        error: "Invalid admin credentials.",
      },
      {
        status: 403,
        headers: NO_STORE_HEADERS,
      },
    );
  }

  try {
    loginAttempts.delete(attemptKey);
    const token = await createAdminSessionToken(admin);
    const response = NextResponse.json(
      {
        success: true,
        admin,
      },
      {
        headers: NO_STORE_HEADERS,
      },
    );

    response.cookies.set({
      name: ADMIN_SESSION_COOKIE_NAME,
      value: token,
      ...ADMIN_SESSION_COOKIE_OPTIONS,
    });

    return response;
  } catch {
    return configurationErrorResponse();
  }
}

export async function DELETE() {
  const response = NextResponse.json(
    {
      success: true,
    },
    {
      headers: NO_STORE_HEADERS,
    },
  );

  response.cookies.set({
    name: ADMIN_SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });

  return response;
}
