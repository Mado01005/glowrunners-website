const TOKEN_VERSION = 1;
const MAX_TOKEN_LENGTH = 2_048;
const MAX_CLOCK_SKEW_SECONDS = 60;

export const ADMIN_SESSION_COOKIE_NAME =
  "__Host-glowrunners-admin-session";
export const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export const ADMIN_SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
} as const;

export type AdminId = "abdallah-saad" | "iwan-haitham" | "layal";
export type AdminRole = "super-admin" | "admin";

export type AdminIdentity = Readonly<{
  id: AdminId;
  displayName: string;
  role: AdminRole;
  phoneE164: string;
}>;

export type AdminSession = Readonly<{
  admin: AdminIdentity;
  issuedAt: number;
  expiresAt: number;
}>;

type AdminSessionPayload = Readonly<{
  version: typeof TOKEN_VERSION;
  adminId: AdminId;
  phoneE164: string;
  issuedAt: number;
  expiresAt: number;
}>;

const ADMINS: readonly AdminIdentity[] = [
  {
    id: "abdallah-saad",
    displayName: "Abdallah Saad",
    role: "super-admin",
    phoneE164: "+201025272693",
  },
  {
    id: "iwan-haitham",
    displayName: "Iwan Haitham",
    role: "admin",
    phoneE164: "+201110112860",
  },
  {
    id: "layal",
    displayName: "Layal",
    role: "admin",
    phoneE164: "+201060804017",
  },
] as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function getAdminAccessCode(): string | null {
  return (
    process.env.ADMIN_ACCESS_CODE?.trim() ||
    process.env.ADMIN_SECRET_KEY?.trim() ||
    null
  );
}

function getAdminSessionSecret(): string | null {
  return (
    process.env.ADMIN_SESSION_SECRET?.trim() ||
    process.env.ADMIN_SECRET_KEY?.trim() ||
    null
  );
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    return null;
  }

  const paddingLength = (4 - (value.length % 4)) % 4;
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");

  try {
    const binary = atob(`${base64}${"=".repeat(paddingLength)}`);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch {
    return null;
  }
}

function encodePayload(payload: AdminSessionPayload): string {
  return bytesToBase64Url(textEncoder.encode(JSON.stringify(payload)));
}

function decodePayload(encodedPayload: string): unknown {
  const bytes = base64UrlToBytes(encodedPayload);

  if (bytes === null) {
    return null;
  }

  try {
    return JSON.parse(textDecoder.decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSessionPayload(value: unknown): AdminSessionPayload | null {
  if (
    !isRecord(value) ||
    value.version !== TOKEN_VERSION ||
    typeof value.adminId !== "string" ||
    typeof value.phoneE164 !== "string" ||
    typeof value.issuedAt !== "number" ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    return null;
  }

  const admin = getAdminById(value.adminId);

  if (admin === null || admin.phoneE164 !== value.phoneE164) {
    return null;
  }

  return {
    version: TOKEN_VERSION,
    adminId: admin.id,
    phoneE164: admin.phoneE164,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
}

async function importHmacKey(
  secret: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    usages,
  );
}

async function signPayload(
  encodedPayload: string,
  secret: string,
): Promise<string> {
  const key = await importHmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(encodedPayload),
  );

  return bytesToBase64Url(new Uint8Array(signature));
}

async function hasValidSignature(
  encodedPayload: string,
  encodedSignature: string,
  secret: string,
): Promise<boolean> {
  const signature = base64UrlToBytes(encodedSignature);

  if (signature === null) {
    return false;
  }

  try {
    const key = await importHmacKey(secret, ["verify"]);
    const signatureBuffer = signature.buffer.slice(
      signature.byteOffset,
      signature.byteOffset + signature.byteLength,
    ) as ArrayBuffer;

    return await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBuffer,
      textEncoder.encode(encodedPayload),
    );
  } catch {
    return false;
  }
}

function readCookieValue(
  cookieHeader: string | null,
  cookieName: string,
): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const cookie of cookieHeader.split(";")) {
    const separatorIndex = cookie.indexOf("=");

    if (separatorIndex < 0) {
      continue;
    }

    const name = cookie.slice(0, separatorIndex).trim();

    if (name !== cookieName) {
      continue;
    }

    const rawValue = cookie.slice(separatorIndex + 1).trim();

    try {
      return decodeURIComponent(rawValue);
    } catch {
      return null;
    }
  }

  return null;
}

export function normalizeEgyptianAdminPhone(phone: string): string {
  let digits = phone.replace(/\D/gu, "");

  if (digits.startsWith("0020")) {
    digits = digits.slice(4);
  } else if (digits.startsWith("20")) {
    digits = digits.slice(2);
  }

  return digits.replace(/^0+/u, "");
}

export function getAdminByPhone(phone: string): AdminIdentity | null {
  const normalizedPhone = normalizeEgyptianAdminPhone(phone);

  if (!normalizedPhone) {
    return null;
  }

  return (
    ADMINS.find(
      (admin) =>
        normalizeEgyptianAdminPhone(admin.phoneE164) === normalizedPhone,
    ) ?? null
  );
}

export function getAdminById(id: string): AdminIdentity | null {
  return ADMINS.find((admin) => admin.id === id) ?? null;
}

export function isAdminAuthConfigured(): boolean {
  return getAdminAccessCode() !== null && getAdminSessionSecret() !== null;
}

export function verifyAdminAccessCode(candidate: string): boolean {
  const expectedCode = getAdminAccessCode();

  return expectedCode !== null && safeStringEqual(candidate, expectedCode);
}

export async function createAdminSessionToken(
  admin: AdminIdentity,
  now = Date.now(),
): Promise<string> {
  const configuredAdmin = getAdminById(admin.id);
  const secret = getAdminSessionSecret();

  if (
    configuredAdmin === null ||
    configuredAdmin.phoneE164 !== admin.phoneE164
  ) {
    throw new Error("Cannot create a session for an unknown administrator.");
  }

  if (secret === null) {
    throw new Error("Admin session signing is not configured.");
  }

  const issuedAt = Math.floor(now / 1_000);
  const payload: AdminSessionPayload = {
    version: TOKEN_VERSION,
    adminId: configuredAdmin.id,
    phoneE164: configuredAdmin.phoneE164,
    issuedAt,
    expiresAt: issuedAt + ADMIN_SESSION_MAX_AGE_SECONDS,
  };
  const encodedPayload = encodePayload(payload);
  const encodedSignature = await signPayload(encodedPayload, secret);

  return `${encodedPayload}.${encodedSignature}`;
}

export async function verifyAdminSessionToken(
  token: string | null | undefined,
  now = Date.now(),
): Promise<AdminSession | null> {
  const secret = getAdminSessionSecret();

  if (!token || token.length > MAX_TOKEN_LENGTH || secret === null) {
    return null;
  }

  const tokenParts = token.split(".");

  if (tokenParts.length !== 2) {
    return null;
  }

  const [encodedPayload, encodedSignature] = tokenParts;

  if (
    !encodedPayload ||
    !encodedSignature ||
    !(await hasValidSignature(encodedPayload, encodedSignature, secret))
  ) {
    return null;
  }

  const payload = parseSessionPayload(decodePayload(encodedPayload));

  if (payload === null) {
    return null;
  }

  const nowSeconds = Math.floor(now / 1_000);
  const sessionLifetime = payload.expiresAt - payload.issuedAt;

  if (
    payload.issuedAt > nowSeconds + MAX_CLOCK_SKEW_SECONDS ||
    payload.expiresAt <= nowSeconds ||
    sessionLifetime <= 0 ||
    sessionLifetime >
      ADMIN_SESSION_MAX_AGE_SECONDS + MAX_CLOCK_SKEW_SECONDS
  ) {
    return null;
  }

  const admin = getAdminById(payload.adminId);

  if (admin === null) {
    return null;
  }

  return {
    admin,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
}

export async function getAdminSessionFromRequest(
  request: Request,
): Promise<AdminSession | null> {
  const token = readCookieValue(
    request.headers.get("cookie"),
    ADMIN_SESSION_COOKIE_NAME,
  );

  return verifyAdminSessionToken(token);
}
