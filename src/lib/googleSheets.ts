import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { JWTInput } from "google-auth-library";
import { google, type sheets_v4 } from "googleapis";
import { isConfirmedAttendanceStatus } from "@/lib/attendanceStatus";
import { parseCheckedInCell } from "@/lib/gateRunnerStatus";
import {
  parseAttendanceSheetDate,
  selectLatestAttendanceDate,
  type ResolvedAttendanceDate,
} from "@/lib/attendanceSheetDate";

export { parseCheckedInCell };

const DEFAULT_SPREADSHEET_ID =
  "1MJApZDOATx8vZUGKBtaHOFnIo831lSZJHl8KUJEaguM";
export const GOOGLE_SPREADSHEET_ID =
  process.env.GOOGLE_SPREADSHEET_ID?.trim() ||
  process.env.SHEET_ID?.trim() ||
  DEFAULT_SPREADSHEET_ID;

const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_TIME_ZONE = "Africa/Cairo";


const GOOGLE_CREDENTIAL_ENV_NAMES = [
  "GOOGLE_CREDENTIALS_JSON",
  "GOOGLE_SHEETS_CREDENTIALS",
  "GOOGLE_CREDS_JSON",
] as const;
const MAX_SHEETS_REQUEST_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);
const RETRYABLE_GOOGLE_REASONS = [
  "backenderror",
  "internalerror",
  "ratelimitexceeded",
  "userratelimitexceeded",
];

let sheetsClientPromise: Promise<sheets_v4.Sheets> | undefined;

export type RunnerLookupResult = {
  rowIndex: number;
  fullName: string;
  phone: string;
  paymentType: string;
  status: string;
};

export type AttendanceRosterEntry = {
  rowIndex: number;
  name: string;
  phone: string;
  paymentType: string;
  status: string;
  amountPaid: number;
  balanceOwed: number;
};

type AttendanceColumn =
  | "name"
  | "phone"
  | "paymentType"
  | "status"
  | "amountPaid"
  | "balanceOwed";

type AttendanceColumns = Readonly<Record<AttendanceColumn, number>> & {
  readonly hasHeaderRow: boolean;
  readonly hasStatusHeader: boolean;
  readonly missingHeaders: readonly AttendanceColumn[];
};

const ATTENDANCE_HEADER_ALIASES: Readonly<
  Record<AttendanceColumn, readonly string[]>
> = {
  name: [
    "name",
    "full name",
    "runner name",
    "participant name",
    "runner full name",
  ],
  phone: [
    "phone",
    "phone number",
    "mobile",
    "mobile number",
    "whatsapp",
    "whatsapp phone",
    "whatsapp number",
  ],
  paymentType: [
    "payment",
    "payment type",
    "payment method",
    "payment mode",
    "method of payment",
  ],
  status: [
    "status",
    "attendance status",
    "check in status",
    "check-in status",
    "confirmation status",
    "confirmed",
    "confirmed?",
  ],
  amountPaid: [
    "amount paid",
    "amount paid egp",
    "paid amount",
    "amount received",
  ],
  balanceOwed: [
    "balance owed",
    "balance owed egp",
    "remaining balance",
    "amount owed",
  ],
};

const ATTENDANCE_HEADER_LABELS: Readonly<Record<AttendanceColumn, string>> = {
  name: "Full Name",
  phone: "Phone / WhatsApp",
  paymentType: "Payment Type",
  status: "Status",
  amountPaid: "Amount Paid EGP",
  balanceOwed: "Balance Owed EGP",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGoogleServiceAccountCredentials(
  value: unknown,
): value is JWTInput {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.client_email === "string" &&
    value.client_email.trim().length > 0 &&
    typeof value.private_key === "string" &&
    value.private_key.trim().length > 0
  );
}

function escapeControlCharactersInsideJsonStrings(value: string): string {
  let result = "";
  let insideString = false;
  let isEscaped = false;

  for (const character of value) {
    if (!insideString) {
      result += character;

      if (character === '"') {
        insideString = true;
      }

      continue;
    }

    if (isEscaped) {
      result += character;
      isEscaped = false;
      continue;
    }

    if (character === "\\") {
      result += character;
      isEscaped = true;
      continue;
    }

    if (character === '"') {
      result += character;
      insideString = false;
      continue;
    }

    const codePoint = character.codePointAt(0) ?? 0;

    if (codePoint < 0x20) {
      result += `\\u${codePoint.toString(16).padStart(4, "0")}`;
      continue;
    }

    result += character;
  }

  return result;
}

function parseGoogleSheetsCredentials(
  serializedCredentials: string,
  sourceName: string,
): JWTInput {
  let credentials: unknown;

  try {
    credentials = JSON.parse(serializedCredentials);
  } catch {
    try {
      credentials = JSON.parse(
        escapeControlCharactersInsideJsonStrings(serializedCredentials),
      );
    } catch {
      throw new Error(
        `${sourceName} must contain a valid service-account JSON object.`,
      );
    }
  }

  if (!isGoogleServiceAccountCredentials(credentials)) {
    throw new Error(
      `${sourceName} must contain a valid client_email and private_key.`,
    );
  }

  return {
    ...credentials,
    private_key: String(credentials.private_key).replace(/\\n/g, "\n"),
  };
}

async function getGoogleSheetsCredentials(): Promise<JWTInput> {
  const configuredEnvironmentCredential = GOOGLE_CREDENTIAL_ENV_NAMES.map(
    (name) => process.env[name]?.trim(),
  ).find((value): value is string => Boolean(value));

  if (configuredEnvironmentCredential) {
    return parseGoogleSheetsCredentials(
      configuredEnvironmentCredential,
      GOOGLE_CREDENTIAL_ENV_NAMES.join(", "),
    );
  }

  const credentialsPath = resolve(process.cwd(), "credentials.json");
  let fileCredentials: string;

  try {
    fileCredentials = (await readFile(credentialsPath, "utf8")).trim();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(
        `Configure one of ${GOOGLE_CREDENTIAL_ENV_NAMES.join(
          ", ",
        )} or provide credentials.json.`,
      );
    }

    throw new Error(
      `Unable to read credentials.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!fileCredentials) {
    throw new Error("credentials.json is empty.");
  }

  return parseGoogleSheetsCredentials(fileCredentials, "credentials.json");
}

export async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const credentials = await getGoogleSheetsCredentials();
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: [GOOGLE_SHEETS_SCOPE],
      });

      return google.sheets({ version: "v4", auth });
    })().catch((error: unknown) => {
      sheetsClientPromise = undefined;
      throw error;
    });
  }

  return sheetsClientPromise;
}

/*
 * Keep the client lazy: local development may use credentials.json, while
 * Vercel must provide one of the environment variables above.
 */

function readErrorStatus(error: unknown): number | undefined {
  if (!isObject(error)) {
    return undefined;
  }

  const response = isObject(error.response) ? error.response : undefined;
  const candidates = [
    error.status,
    error.statusCode,
    error.code,
    response?.status,
    response?.statusCode,
  ];

  for (const candidate of candidates) {
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 100 &&
      candidate <= 599
    ) {
      return candidate;
    }

    if (
      typeof candidate === "string" &&
      /^\d{3}$/.test(candidate) &&
      Number(candidate) >= 100 &&
      Number(candidate) <= 599
    ) {
      return Number(candidate);
    }
  }

  return undefined;
}

function readErrorCode(error: unknown): string {
  if (!isObject(error)) {
    return "";
  }

  return typeof error.code === "string" ? error.code.toUpperCase() : "";
}

function serializeErrorDetails(error: unknown): string {
  if (!isObject(error)) {
    return String(error).toLocaleLowerCase("en-US");
  }

  const response = isObject(error.response) ? error.response : undefined;
  const details = [
    error.message,
    error.errors,
    response?.data,
    response?.statusText,
  ];

  try {
    return JSON.stringify(details).toLocaleLowerCase("en-US");
  } catch {
    return String(error.message ?? error).toLocaleLowerCase("en-US");
  }
}

function isRetryableSheetsError(error: unknown): boolean {
  const status = readErrorStatus(error);

  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  if (RETRYABLE_NETWORK_CODES.has(readErrorCode(error))) {
    return true;
  }

  if (status === 403) {
    const details = serializeErrorDetails(error);
    return RETRYABLE_GOOGLE_REASONS.some((reason) =>
      details.includes(reason),
    );
  }

  return false;
}

function readRetryAfterMs(error: unknown): number | null {
  if (!isObject(error)) {
    return null;
  }

  const response = isObject(error.response) ? error.response : undefined;
  const headers = response?.headers;
  let retryAfter: unknown;

  if (isObject(headers)) {
    const getHeader = headers.get;

    if (typeof getHeader === "function") {
      try {
        retryAfter = getHeader.call(headers, "retry-after");
      } catch {
        retryAfter = undefined;
      }
    } else {
      retryAfter = headers["retry-after"] ?? headers["Retry-After"];
    }
  }

  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    return Math.max(0, retryAfter * 1_000);
  }

  if (typeof retryAfter !== "string" || !retryAfter.trim()) {
    return null;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1_000);
  }

  const retryAt = Date.parse(retryAfter);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : null;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export class GoogleSheetsMutationOutcomeUnknownError extends Error {
  readonly operation: string;
  readonly requestError: unknown;
  readonly verificationError: unknown;

  constructor(
    operation: string,
    requestError: unknown,
    verificationError: unknown,
  ) {
    super(
      `Google Sheets mutation "${operation}" may have completed, but its result could not be verified.`,
    );
    this.name = "GoogleSheetsMutationOutcomeUnknownError";
    this.operation = operation;
    this.requestError = requestError;
    this.verificationError = verificationError;
  }
}

export async function withGoogleSheetsRetry<T>(
  operation: string,
  request: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_SHEETS_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (
        attempt === MAX_SHEETS_REQUEST_ATTEMPTS ||
        !isRetryableSheetsError(error)
      ) {
        throw error;
      }

      const exponentialDelay = Math.min(
        MAX_RETRY_DELAY_MS,
        BASE_RETRY_DELAY_MS * 2 ** (attempt - 1),
      );
      const retryAfterDelay = Math.min(
        MAX_RETRY_DELAY_MS,
        readRetryAfterMs(error) ?? 0,
      );
      const jitter = Math.floor(Math.random() * BASE_RETRY_DELAY_MS);
      const delayMs = Math.max(exponentialDelay + jitter, retryAfterDelay);

      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Retrying Google Sheets request.",
          operation,
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          status: readErrorStatus(error),
          code: readErrorCode(error) || undefined,
        }),
      );

      await wait(delayMs);
    }
  }

  throw new Error(`Google Sheets operation "${operation}" did not complete.`);
}

export async function withGoogleSheetsIdempotentMutationRetry(
  operation: string,
  request: () => Promise<unknown>,
  hasCommitted: () => Promise<boolean>,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_SHEETS_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      await request();
      return;
    } catch (error) {
      let committed: boolean;

      try {
        committed = await withGoogleSheetsRetry(
          `verify ${operation}`,
          hasCommitted,
        );
      } catch (verificationError) {
        console.error(
          JSON.stringify({
            level: "error",
            message:
              "A Google Sheets mutation failed with an unknown commit outcome.",
            operation,
            attempt,
            status: readErrorStatus(error),
            code: readErrorCode(error) || undefined,
          }),
        );

        throw new GoogleSheetsMutationOutcomeUnknownError(
          operation,
          error,
          verificationError,
        );
      }

      if (committed) {
        console.warn(
          JSON.stringify({
            level: "warn",
            message:
              "Confirmed a Google Sheets mutation after an ambiguous response.",
            operation,
            attempt,
          }),
        );
        return;
      }

      if (
        attempt === MAX_SHEETS_REQUEST_ATTEMPTS ||
        !isRetryableSheetsError(error)
      ) {
        throw error;
      }

      const exponentialDelay = Math.min(
        MAX_RETRY_DELAY_MS,
        BASE_RETRY_DELAY_MS * 2 ** (attempt - 1),
      );
      const retryAfterDelay = Math.min(
        MAX_RETRY_DELAY_MS,
        readRetryAfterMs(error) ?? 0,
      );
      const jitter = Math.floor(Math.random() * BASE_RETRY_DELAY_MS);
      const delayMs = Math.max(exponentialDelay + jitter, retryAfterDelay);

      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Retrying an idempotency-checked Google Sheets mutation.",
          operation,
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          status: readErrorStatus(error),
          code: readErrorCode(error) || undefined,
        }),
      );

      await wait(delayMs);
    }
  }
}

export function quoteSheetName(sheetName: string): string {
  return `'${sheetName.replaceAll("'", "''")}'`;
}

export function columnIndexToA1(columnIndex: number): string {
  if (!Number.isSafeInteger(columnIndex) || columnIndex < 0) {
    throw new Error("Google Sheets column index must be a non-negative integer.");
  }

  let current = columnIndex + 1;
  let column = "";

  while (current > 0) {
    const remainder = (current - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    current = Math.floor((current - 1) / 26);
  }

  return column;
}

export function normalizeSheetHeader(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[.:/\\()[\]{}]+/g, " ")
    .replace(/[_\s-]+/g, " ")
    .trim();
}

export function cleanPhoneForQr(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

export function normalizeEgyptianMobilePhone(phone: string): string | null {
  let digits = cleanPhoneForQr(phone);

  if (!digits) {
    return null;
  }

  digits = digits.replace(/^0+/, "");

  if (digits.startsWith("20")) {
    digits = digits.slice(2).replace(/^0+/, "");
  }

  return /^(?:10|11|12|15)\d{8}$/.test(digits) ? digits : null;
}

export function normalizePhone(phone: string): string {
  return normalizeEgyptianMobilePhone(phone) ?? "";
}

function normalizeRosterContact(value: unknown): string {
  const contact = String(value ?? "").trim().replace(/^'/, "").trim();
  const egyptianPhone = normalizeEgyptianMobilePhone(contact);

  if (egyptianPhone) {
    return egyptianPhone;
  }

  if (!contact || contact === "-") {
    return "";
  }

  if (contact.startsWith("@") || /[a-z._-]/i.test(contact)) {
    return (contact.startsWith("@") ? contact : `@${contact}`).slice(0, 80);
  }

  const digits = contact.replace(/\D/g, "");
  return digits.length >= 8
    ? `${contact.startsWith("+") ? "+" : ""}${digits}`.slice(0, 30)
    : contact.slice(0, 80);
}

function serializeRosterContact(value: string): string {
  const contact = normalizeRosterContact(value);
  const egyptianPhone = normalizeEgyptianMobilePhone(contact);

  return egyptianPhone ? `'0${egyptianPhone}` : contact;
}

function safeAttendanceMoney(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

function resolveAttendanceColumns(headerRow: readonly unknown[]): AttendanceColumns {
  const normalizedHeaders = headerRow.map(normalizeSheetHeader);
  const findColumn = (field: AttendanceColumn): number | undefined => {
    const aliases = new Set(
      ATTENDANCE_HEADER_ALIASES[field].map(normalizeSheetHeader),
    );
    const index = normalizedHeaders.findIndex((header) => aliases.has(header));
    return index >= 0 ? index : undefined;
  };
  const name = findColumn("name");
  const phone = findColumn("phone");
  const paymentType = findColumn("paymentType");
  const status = findColumn("status");
  const amountPaid = findColumn("amountPaid");
  const balanceOwed = findColumn("balanceOwed");
  const hasHeaderRow = name !== undefined && phone !== undefined;
  const resolved: Partial<Record<AttendanceColumn, number>> = {
    name: name ?? 0,
    phone: phone ?? 1,
  };
  const missingHeaders: AttendanceColumn[] = [];
  let nextColumn = Math.max(headerRow.length, 2);

  for (const [field, existing] of [
    ["paymentType", paymentType],
    ["status", status],
    ["amountPaid", amountPaid],
    ["balanceOwed", balanceOwed],
  ] as const) {
    if (existing !== undefined) {
      resolved[field] = existing;
    } else {
      resolved[field] = nextColumn;
      nextColumn += 1;
      missingHeaders.push(field);
    }
  }

  return {
    ...(resolved as Record<AttendanceColumn, number>),
    hasHeaderRow,
    hasStatusHeader: status !== undefined,
    missingHeaders,
  };
}

async function getAttendanceValues(sheetName: string) {
  const sheets = await getSheetsClient();
  const response = await withGoogleSheetsRetry(
    `read attendance sheet ${sheetName}`,
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(sheetName)}!A:Z`,
      }),
  );

  const rows = response.data.values ?? [];
  const columns = resolveAttendanceColumns(rows[0] ?? []);

  return { rows, columns };
}

function ordinal(day: number): string {
  if (day >= 11 && day <= 13) {
    return `${day}th`;
  }

  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

function getLocalDateParts(date: Date, timeZone = DEFAULT_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });

  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
  };
}

export function getActiveAttendanceSheetName(
  date = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
): string {
  const { year, month, day } = getLocalDateParts(date, timeZone);
  const localNoonUtc = new Date(Date.UTC(year, month - 1, day, 12));
  const localWeekday = localNoonUtc.getUTCDay();
  const daysUntilTuesday = (2 - localWeekday + 7) % 7;
  const daysUntilFriday = (5 - localWeekday + 7) % 7;
  const daysUntilMeetup = Math.min(daysUntilTuesday, daysUntilFriday);
  const meetupDate = new Date(localNoonUtc);

  meetupDate.setUTCDate(localNoonUtc.getUTCDate() + daysUntilMeetup);

  const meetupDay = meetupDate.getUTCDate();
  const meetupMonth = meetupDate.toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  const meetupWeekday = meetupDate.toLocaleString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });

  return `Attendance - ${meetupWeekday} - ${ordinal(
    meetupDay,
  )} of ${meetupMonth}`;
}

export async function resolveActiveAttendanceSheetName(): Promise<{
  sheetName: string;
  isFallback: boolean;
}> {
  const configuredSheetName = process.env.ATTENDANCE_SHEET_NAME?.trim();
  const desiredSheetName =
    configuredSheetName || getActiveAttendanceSheetName();
  const sheets = await getSheetsClient();
  const response = await withGoogleSheetsRetry(
    "resolve active attendance sheet",
    () =>
      sheets.spreadsheets.get({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        fields: "sheets.properties(title,index)",
      }),
  );
  const availableSheets = (response.data.sheets ?? [])
    .map((sheet) => sheet.properties)
    .filter(
      (
        properties,
      ): properties is NonNullable<typeof properties> & {
        title: string;
      } => typeof properties?.title === "string",
    )
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  const desiredHeader = normalizeSheetHeader(desiredSheetName);
  const exactMatch = availableSheets.find(
    (sheet) => normalizeSheetHeader(sheet.title) === desiredHeader,
  );

  if (exactMatch) {
    return { sheetName: exactMatch.title, isFallback: false };
  }

  if (configuredSheetName) {
    return { sheetName: configuredSheetName, isFallback: false };
  }

  const localParts = getLocalDateParts(new Date(), DEFAULT_TIME_ZONE);
  const localToday = new Date(
    Date.UTC(localParts.year, localParts.month - 1, localParts.day, 12),
  );
  const nearestCycleSheet = availableSheets
    .flatMap((sheet) => {
      const eventDate = parseAttendanceSheetDate(sheet.title, localToday);

      return eventDate ? [{ sheet, eventDate }] : [];
    })
    .sort((left, right) => {
      const leftDelta = left.eventDate.getTime() - localToday.getTime();
      const rightDelta = right.eventDate.getTime() - localToday.getTime();
      const leftIsPast = leftDelta < 0 ? 1 : 0;
      const rightIsPast = rightDelta < 0 ? 1 : 0;

      return (
        leftIsPast - rightIsPast ||
        Math.abs(leftDelta) - Math.abs(rightDelta) ||
        (right.sheet.index ?? 0) - (left.sheet.index ?? 0)
      );
    })[0]?.sheet;
  const latestAttendanceSheet = [...availableSheets]
    .reverse()
    .find((sheet) =>
      normalizeSheetHeader(sheet.title).startsWith("attendance "),
    );
  const fallbackSheet = nearestCycleSheet ?? latestAttendanceSheet;

  return fallbackSheet
    ? { sheetName: fallbackSheet.title, isFallback: true }
    : { sheetName: desiredSheetName, isFallback: false };
}

export async function resolveLatestAttendanceDate(
  now = new Date(),
): Promise<ResolvedAttendanceDate | null> {
  const localParts = getLocalDateParts(now, DEFAULT_TIME_ZONE);
  const localToday = new Date(
    Date.UTC(localParts.year, localParts.month - 1, localParts.day, 12),
  );
  const sheets = await getSheetsClient();
  const response = await withGoogleSheetsRetry(
    "resolve latest attendance date",
    () =>
      sheets.spreadsheets.get({
        spreadsheetId: DEFAULT_SPREADSHEET_ID,
        fields: "sheets.properties(title,index,hidden,sheetType)",
      }),
  );
  const availableSheets = (response.data.sheets ?? []).flatMap((sheet) => {
    const properties = sheet.properties;

    return typeof properties?.title === "string"
      ? [
          {
            title: properties.title,
            index: properties.index,
            hidden: properties.hidden,
            sheetType: properties.sheetType,
          },
        ]
      : [];
  });

  return selectLatestAttendanceDate(availableSheets, localToday);
}

export async function findRunnerByPhone(
  sheetName: string,
  scannedPhone: string,
  preferredRowIndex?: number,
): Promise<RunnerLookupResult | null> {
  const normalizedScannedPhone = normalizeEgyptianMobilePhone(scannedPhone);

  if (!normalizedScannedPhone) {
    return null;
  }

  const { rows, columns } = await getAttendanceValues(sheetName);
  const startIndex = columns.hasHeaderRow ? 1 : 0;

  let firstMatch: RunnerLookupResult | null = null;

  for (let index = startIndex; index < rows.length; index += 1) {
    const row = rows[index];
    const fullName = String(row[columns.name] ?? "").trim();
    const sheetPhone = String(row[columns.phone] ?? "").trim();

    if (
      fullName &&
      sheetPhone &&
      normalizeEgyptianMobilePhone(sheetPhone) === normalizedScannedPhone
    ) {
      const rawStatus = String(row[columns.status] ?? "").trim().slice(0, 40);
      const colFCheckedIn = parseCheckedInCell(row[5]);
      const status =
        (colFCheckedIn || parseCheckedInCell(rawStatus)) &&
        !isConfirmedAttendanceStatus(rawStatus)
          ? "✅ CONFIRMED"
          : rawStatus;

      const match: RunnerLookupResult = {
        rowIndex: index + 1,
        fullName,
        phone: normalizedScannedPhone,
        paymentType:
          String(row[columns.paymentType] ?? "").trim().slice(0, 40) ||
          "Unknown",
        status,
      };

      if (preferredRowIndex === match.rowIndex) {
        return match;
      }

      firstMatch ??= match;
    }
  }

  return firstMatch;
}

export async function getAttendanceRoster(
  sheetName: string,
): Promise<AttendanceRosterEntry[]> {
  const { rows, columns } = await getAttendanceValues(sheetName);
  const roster: AttendanceRosterEntry[] = [];
  const startIndex = columns.hasHeaderRow ? 1 : 0;

  for (let index = startIndex; index < rows.length; index += 1) {
    const row = rows[index];
    const name = String(row[columns.name] ?? "").trim().slice(0, 100);
    const contact = normalizeRosterContact(row[columns.phone]);
    const paymentType =
      String(row[columns.paymentType] ?? "").trim().slice(0, 40) || "Unknown";
    const rawStatus = String(row[columns.status] ?? "").trim().slice(0, 40);
    const colFCheckedIn = parseCheckedInCell(row[5]); // Column F (Confirmed?)
    const status =
      (colFCheckedIn || parseCheckedInCell(rawStatus)) &&
      !isConfirmedAttendanceStatus(rawStatus)
        ? "✅ CONFIRMED"
        : rawStatus;

    if (!name) {
      continue;
    }

    roster.push({
      rowIndex: index + 1,
      name,
      phone: contact,
      paymentType,
      status,
      amountPaid: safeAttendanceMoney(row[columns.amountPaid]),
      balanceOwed: safeAttendanceMoney(row[columns.balanceOwed]),
    });
  }

  return roster;
}

export type AttendanceRunnerPatch = Readonly<{
  name: string;
  phone: string;
  paymentType: string;
  status: string;
  amountPaid: number;
  balanceOwed: number;
}>;

function runnerMatchesExpectedIdentity(
  row: readonly unknown[],
  columns: AttendanceColumns,
  expectedName: string,
  expectedPhone: string,
): boolean {
  return (
    String(row[columns.name] ?? "").trim() === expectedName.trim() &&
    normalizeRosterContact(row[columns.phone]) ===
      normalizeRosterContact(expectedPhone)
  );
}

export async function updateAttendanceRunner(
  sheetName: string,
  rowIndex: number,
  expectedName: string,
  expectedPhone: string,
  patch: AttendanceRunnerPatch,
): Promise<AttendanceRosterEntry> {
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 2) {
    throw new Error("Attendance runner row must be a data row.");
  }

  const { rows, columns } = await getAttendanceValues(sheetName);

  if (!columns.hasHeaderRow) {
    throw new Error("Attendance runner editing requires a header row.");
  }

  const currentRow = rows[rowIndex - 1] ?? [];

  if (
    !runnerMatchesExpectedIdentity(
      currentRow,
      columns,
      expectedName,
      expectedPhone,
    )
  ) {
    throw new Error(
      "This runner moved or changed. Refresh the roster before editing.",
    );
  }

  const isConfirmed =
    isConfirmedAttendanceStatus(patch.status) ||
    parseCheckedInCell(patch.status);
  const statusValue = isConfirmed ? "TRUE" : patch.status.trim();

  const sheets = await getSheetsClient();
  const headerWrites = columns.missingHeaders.map((field) => ({
    range: `${quoteSheetName(sheetName)}!${columnIndexToA1(columns[field])}1`,
    values: [[ATTENDANCE_HEADER_LABELS[field]]],
  }));
  const values: Readonly<Record<AttendanceColumn, unknown>> = {
    name: patch.name.trim(),
    phone: serializeRosterContact(patch.phone),
    paymentType: patch.paymentType.trim(),
    status: statusValue,
    amountPaid: safeAttendanceMoney(patch.amountPaid),
    balanceOwed: safeAttendanceMoney(patch.balanceOwed),
  };
  const runnerWrites = (
    Object.entries(values) as [AttendanceColumn, unknown][]
  ).map(([field, value]) => ({
    range: `${quoteSheetName(sheetName)}!${columnIndexToA1(
      columns[field],
    )}${rowIndex}`,
    values: [[value]],
  }));

  if (isConfirmed && columnIndexToA1(columns.status) !== "F") {
    runnerWrites.push({
      range: `${quoteSheetName(sheetName)}!F${rowIndex}`,
      values: [["TRUE"]],
    });
  }

  await withGoogleSheetsRetry(
    `update attendance runner row ${rowIndex} in ${sheetName}`,
    () =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: [...headerWrites, ...runnerWrites],
        },
      }),
  );

  const updated = (await getAttendanceRoster(sheetName)).find(
    (runner) => runner.rowIndex === rowIndex,
  );

  if (!updated) {
    throw new Error("The updated runner could not be read back.");
  }

  return updated;
}

export async function deleteAttendanceRunner(
  sheetName: string,
  rowIndex: number,
  expectedName: string,
  expectedPhone: string,
): Promise<AttendanceRosterEntry> {
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 2) {
    throw new Error("Attendance runner row must be a data row.");
  }

  const { rows, columns } = await getAttendanceValues(sheetName);
  const currentRow = rows[rowIndex - 1] ?? [];

  if (
    !runnerMatchesExpectedIdentity(
      currentRow,
      columns,
      expectedName,
      expectedPhone,
    )
  ) {
    throw new Error(
      "This runner moved or changed. Refresh the roster before deleting.",
    );
  }

  const deletedRunner: AttendanceRosterEntry = {
    rowIndex,
    name: String(currentRow[columns.name] ?? "").trim().slice(0, 100),
    phone: normalizeRosterContact(currentRow[columns.phone]),
    paymentType:
      String(currentRow[columns.paymentType] ?? "").trim().slice(0, 40) ||
      "Unknown",
    status: String(currentRow[columns.status] ?? "").trim().slice(0, 40),
    amountPaid: safeAttendanceMoney(currentRow[columns.amountPaid]),
    balanceOwed: safeAttendanceMoney(currentRow[columns.balanceOwed]),
  };

  const sheets = await getSheetsClient();
  const metadata = await withGoogleSheetsRetry(
    `find attendance sheet ${sheetName}`,
    () =>
      sheets.spreadsheets.get({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        fields: "sheets.properties(sheetId,title)",
      }),
  );
  const sheetId = metadata.data.sheets?.find(
    (sheet) => sheet.properties?.title === sheetName,
  )?.properties?.sheetId;

  if (typeof sheetId !== "number") {
    throw new Error("The active attendance sheet could not be resolved.");
  }

  await withGoogleSheetsIdempotentMutationRetry(
    `delete attendance runner row ${rowIndex} in ${sheetName}`,
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId,
                  dimension: "ROWS",
                  startIndex: rowIndex - 1,
                  endIndex: rowIndex,
                },
              },
            },
          ],
        },
      }),
    async () => {
      const refreshed = await getAttendanceValues(sheetName);
      return !runnerMatchesExpectedIdentity(
        refreshed.rows[rowIndex - 1] ?? [],
        refreshed.columns,
        expectedName,
        expectedPhone,
      );
    },
  );

  return deletedRunner;
}

export async function markAsConfirmed(
  sheetName: string,
  rowIndex: number,
): Promise<void> {
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 1) {
    throw new Error("Attendance row index must be a positive integer.");
  }

  const sheets = await getSheetsClient();
  const headerResponse = await withGoogleSheetsRetry(
    `read attendance headers for ${sheetName}`,
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(sheetName)}!A1:Z1`,
      }),
  );
  const columns = resolveAttendanceColumns(
    headerResponse.data.values?.[0] ?? [],
  );
  const statusColumn = columnIndexToA1(columns.status);

  await withGoogleSheetsRetry(`confirm attendance in ${sheetName}`, () =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: [
          ...(columns.hasHeaderRow && !columns.hasStatusHeader
            ? [
                {
                  range: `${quoteSheetName(sheetName)}!${statusColumn}1`,
                  values: [["Status"]],
                },
              ]
            : []),
          {
            range: `${quoteSheetName(
              sheetName,
            )}!${statusColumn}${rowIndex}`,
            values: [["TRUE"]],
          },
          ...(statusColumn !== "F"
            ? [
                {
                  range: `${quoteSheetName(sheetName)}!F${rowIndex}`,
                  values: [["TRUE"]],
                },
              ]
            : []),
        ],
      },
    }),
  );
}

export const getRunnerByPhone = findRunnerByPhone;
export const confirmAttendance = markAsConfirmed;

export async function getConfirmedAttendanceCount(
  sheetName: string,
): Promise<number> {
  const { rows, columns } = await getAttendanceValues(sheetName);
  const startIndex = columns.hasHeaderRow ? 1 : 0;

  return rows.slice(startIndex).reduce((count, row) => {
    return isConfirmedAttendanceStatus(row[columns.status]) ||
      parseCheckedInCell(row[5])
      ? count + 1
      : count;
  }, 0);
}

