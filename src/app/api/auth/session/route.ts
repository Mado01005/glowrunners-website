import { NextResponse } from "next/server";
import {
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_COOKIE_OPTIONS,
  createAdminSessionToken,
  getAdminByPhone,
  getAdminSessionFromRequest,
  isAdminAuthConfigured,
  verifyAdminAccessCode,
} from "@/lib/adminAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type LoginRequestBody = Readonly<{
  phone?: unknown;
  accessCode?: unknown;
}>;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
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

function getLoginAttemptKey(request: Request, phone: string | null) {
  const forwardedFor =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";
  const phoneDigits = phone?.replace(/\D/g, "").slice(-15) || "missing";

  return `${forwardedFor}:${phoneDigits}`;
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
  const phone = readLoginString(body?.phone, 32);
  const accessCode = readLoginString(body?.accessCode, 512);
  const attemptKey = getLoginAttemptKey(request, phone);
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

  const admin = phone === null ? null : getAdminByPhone(phone);

  if (
    admin === null ||
    accessCode === null ||
    !verifyAdminAccessCode(accessCode)
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
