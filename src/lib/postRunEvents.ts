import { randomUUID } from "node:crypto";
import {
  GOOGLE_SPREADSHEET_ID,
  columnIndexToA1,
  getSheetsClient,
  normalizeEgyptianMobilePhone,
  normalizeSheetHeader,
  quoteSheetName,
  withGoogleSheetsIdempotentMutationRetry,
  withGoogleSheetsRetry,
} from "@/lib/googleSheets";

export const parseCheckedInCell = (val: unknown): boolean => {
  if (val === true || val === 1) return true;
  if (!val) return false;


  const str = val.toString().trim().toLowerCase();
  return (
    str === "true" ||
    str === "yes" ||
    str === "1" ||
    str === "confirmed" ||
    str === "cleared" ||
    str === "checked-in" ||
    str === "checked in" ||
    str === "x" ||
    str === "✅ confirmed" ||
    str === "fully cleared" ||
    str === "[x]" ||
    str === "[ x ]"
  );
};

export const POST_RUN_EVENTS_SHEET_NAME = "PostRunEvents";
export const POST_RUN_PARTICIPANTS_SHEET_NAME = "PostRunParticipants";
export const POST_RUN_PARTICIPANT_UPDATES_SHEET_NAME =
  "PostRunParticipantUpdates";
const POST_RUN_EVENT_TAB_HEADERS = [
  "Full Name",
  "Phone / WhatsApp",
  "Payment Status",
  "Amount Paid",
  "Balance Owed",
  "Confirmed?",
] as const;

export const POST_RUN_DEPOSIT_STATUSES = ["Pending", "Verified"] as const;
export const POST_RUN_SETTLEMENT_STATUSES = [
  "Unpaid",
  "Fully Cleared",
  "Free",
] as const;

export type PostRunDepositStatus =
  (typeof POST_RUN_DEPOSIT_STATUSES)[number];
export type PostRunSettlementStatus =
  (typeof POST_RUN_SETTLEMENT_STATUSES)[number];

export type PostRunEvent = Readonly<{
  id: string;
  title: string;
  associatedDate: string;
  totalCostPerPersonEgp: number;
  requiredDepositPerPersonEgp: number;
  maxCapacity: number | null;
  paymentInstructions: string;
  createdAt: string;
  updatedAt: string;
  createdByAdminPhone: string;
  archivedAt: string | null;
  archivedByAdminPhone: string | null;
}>;

export type PostRunEventInput = Readonly<{
  title: string;
  associatedDate: string;
  totalCostPerPersonEgp: number;
  requiredDepositPerPersonEgp: number;
  maxCapacity: number | null;
  paymentInstructions: string;
}>;

export type PostRunEventPatch = Readonly<
  Partial<PostRunEventInput>
>;

export type PostRunEventDeletionResult = Readonly<{
  event: PostRunEvent;
  participantCount: number;
  paymentProofUrls: readonly string[];
}>;

export type PostRunParticipant = Readonly<{
  id: string;
  eventId: string;
  name: string;
  whatsappPhone: string;
  depositStatus: PostRunDepositStatus;
  depositAmountPaidEgp: number;
  paymentMethod?: string;
  changeOwed?: number;
  paymentScreenshotUrl: string | null;
  remainingBalanceEgp: number;
  settlementStatus: PostRunSettlementStatus;
  checkedIn?: boolean;
  createdAt: string;
  updatedAt: string;
  createdByAdminPhone: string;
  updatedByAdminPhone: string;
  internalNotes: string;
  deletedAt: string | null;
  deletedByAdminPhone: string | null;
}>;


export type PostRunParticipantInput = Readonly<{
  name: string;
  whatsappPhone: string;
  force?: boolean;
  depositStatus?: PostRunDepositStatus;
  depositAmountPaidEgp?: number;
  paymentMethod?: string;
  changeOwed?: number;
  paymentScreenshotUrl?: string | null;
  settlementStatus?: PostRunSettlementStatus;
  internalNotes?: string;
}>;

export type PostRunParticipantPatch = Readonly<{
  name?: string;
  whatsappPhone?: string;
  depositStatus?: PostRunDepositStatus;
  depositAmountPaidEgp?: number;
  paymentMethod?: string;
  changeOwed?: number;
  paymentScreenshotUrl?: string | null;
  settlementStatus?: PostRunSettlementStatus;
  internalNotes?: string;
  deletedAt?: string | null;
  deletedByAdminPhone?: string | null;
}>;


export type PostRunEventsErrorCode =
  | "CAPACITY_REACHED"
  | "CONFLICT"
  | "CONFIGURATION"
  | "NOT_FOUND"
  | "VALIDATION";

export class PostRunEventsError extends Error {
  readonly code: PostRunEventsErrorCode;

  constructor(code: PostRunEventsErrorCode, message: string) {
    super(message);
    this.name = "PostRunEventsError";
    this.code = code;
  }
}

type EventColumn =
  | "id"
  | "title"
  | "associatedDate"
  | "totalCostPerPersonEgp"
  | "requiredDepositPerPersonEgp"
  | "maxCapacity"
  | "paymentInstructions"
  | "createdAt"
  | "updatedAt"
  | "createdByAdminPhone"
  | "archivedAt"
  | "archivedByAdminPhone";

type ParticipantColumn =
  | "id"
  | "eventId"
  | "name"
  | "whatsappPhone"
  | "depositStatus"
  | "depositAmountPaidEgp"
  | "paymentScreenshotUrl"
  | "remainingBalanceEgp"
  | "settlementStatus"
  | "createdAt"
  | "updatedAt"
  | "createdByAdminPhone"
  | "updatedByAdminPhone"
  | "internalNotes"
  | "deletedAt"
  | "deletedByAdminPhone";

type ParticipantUpdateColumn =
  | "id"
  | "eventId"
  | "participantId"
  | "patchJson"
  | "createdAt"
  | "updatedByAdminPhone";

type HeaderDefinition<Key extends string> = Readonly<{
  key: Key;
  header: string;
  aliases: readonly string[];
}>;

type ColumnMap<Key extends string> = Readonly<Record<Key, number>>;

type PostRunSheetColumns = Readonly<{
  events: ColumnMap<EventColumn>;
  participants: ColumnMap<ParticipantColumn>;
  participantUpdates: ColumnMap<ParticipantUpdateColumn>;
}>;

type EventRow = Readonly<{
  value: PostRunEvent;
  rowIndex: number;
  rawRow: readonly unknown[];
}>;

type ParticipantRow = Readonly<{
  value: PostRunParticipant;
  rowIndex: number;
  rawRow: readonly unknown[];
}>;

type ParticipantUpdate = Readonly<{
  id: string;
  eventId: string;
  participantId: string;
  patch: PostRunParticipantPatch;
  createdAt: string;
  updatedByAdminPhone: string;
}>;

const EVENT_HEADER_DEFINITIONS: readonly HeaderDefinition<EventColumn>[] = [
  {
    key: "id",
    header: "Event ID",
    aliases: ["event id", "event uuid", "id"],
  },
  {
    key: "title",
    header: "Event Title",
    aliases: ["event title", "event name", "title", "activity"],
  },
  {
    key: "associatedDate",
    header: "Associated Date",
    aliases: ["associated date", "event date", "date"],
  },
  {
    key: "totalCostPerPersonEgp",
    header: "Total Cost Per Person EGP",
    aliases: [
      "total cost per person egp",
      "total cost egp",
      "cost per person",
      "total cost",
    ],
  },
  {
    key: "requiredDepositPerPersonEgp",
    header: "Required Deposit Per Person EGP",
    aliases: [
      "required deposit per person egp",
      "required deposit egp",
      "deposit per person",
      "required deposit",
    ],
  },
  {
    key: "maxCapacity",
    header: "Max Capacity",
    aliases: ["max capacity", "maximum capacity", "capacity"],
  },
  {
    key: "paymentInstructions",
    header: "Payment Instructions",
    aliases: [
      "payment instructions",
      "payment instruction",
      "payment link",
      "instapay link",
    ],
  },
  {
    key: "createdAt",
    header: "Created At",
    aliases: ["created at", "created timestamp", "created"],
  },
  {
    key: "updatedAt",
    header: "Updated At",
    aliases: ["updated at", "updated timestamp", "last updated"],
  },
  {
    key: "createdByAdminPhone",
    header: "Created By Admin Phone",
    aliases: [
      "created by admin phone",
      "created by phone",
      "created by",
      "admin phone",
    ],
  },
  {
    key: "archivedAt",
    header: "Archived At",
    aliases: ["archived at", "archive timestamp"],
  },
  {
    key: "archivedByAdminPhone",
    header: "Archived By Admin Phone",
    aliases: ["archived by admin phone", "archived by", "archive admin phone"],
  },
];

const PARTICIPANT_HEADER_DEFINITIONS: readonly HeaderDefinition<ParticipantColumn>[] =
  [
    {
      key: "id",
      header: "Participant ID",
      aliases: ["participant id", "participant uuid", "id"],
    },
    {
      key: "eventId",
      header: "Event ID",
      aliases: ["event id", "event uuid"],
    },
    {
      key: "name",
      header: "Participant Name",
      aliases: ["participant name", "full name", "name"],
    },
    {
      key: "whatsappPhone",
      header: "WhatsApp Phone",
      aliases: [
        "whatsapp phone",
        "whatsapp phone or username",
        "whatsapp number",
        "whatsapp username",
        "username",
        "contact",
        "phone number",
        "mobile number",
        "phone",
      ],
    },
    {
      key: "depositStatus",
      header: "Deposit Status",
      aliases: ["deposit status", "deposit verification", "deposit verified"],
    },
    {
      key: "depositAmountPaidEgp",
      header: "Deposit Amount Paid EGP",
      aliases: [
        "deposit amount paid egp",
        "deposit paid egp",
        "deposit amount",
        "deposit paid",
      ],
    },
    {
      key: "paymentScreenshotUrl",
      header: "Payment Screenshot URL",
      aliases: [
        "payment screenshot url",
        "payment screenshot",
        "proof url",
        "payment proof",
        "payment proof url",
      ],
    },
    {
      key: "remainingBalanceEgp",
      header: "Remaining Balance EGP",
      aliases: [
        "remaining balance egp",
        "remaining balance",
        "balance remaining",
      ],
    },
    {
      key: "settlementStatus",
      header: "Settlement Status",
      aliases: ["settlement status", "balance status", "clearance status"],
    },
    {
      key: "createdAt",
      header: "Created At",
      aliases: ["created at", "created timestamp", "created"],
    },
    {
      key: "updatedAt",
      header: "Updated At",
      aliases: ["updated at", "updated timestamp", "last updated"],
    },
    {
      key: "createdByAdminPhone",
      header: "Created By Admin Phone",
      aliases: [
        "created by admin phone",
        "created by phone",
        "created by",
      ],
    },
    {
      key: "updatedByAdminPhone",
      header: "Updated By Admin Phone",
      aliases: [
        "updated by admin phone",
        "updated by phone",
        "updated by",
      ],
    },
    {
      key: "internalNotes",
      header: "Internal Notes",
      aliases: ["internal notes", "admin notes", "notes"],
    },
    {
      key: "deletedAt",
      header: "Deleted At",
      aliases: ["deleted at", "removed at"],
    },
    {
      key: "deletedByAdminPhone",
      header: "Deleted By Admin Phone",
      aliases: ["deleted by admin phone", "deleted by", "removed by"],
    },
  ];

const PARTICIPANT_UPDATE_HEADER_DEFINITIONS: readonly HeaderDefinition<ParticipantUpdateColumn>[] =
  [
    {
      key: "id",
      header: "Update ID",
      aliases: ["update id", "operation id", "id"],
    },
    {
      key: "eventId",
      header: "Event ID",
      aliases: ["event id", "event uuid"],
    },
    {
      key: "participantId",
      header: "Participant ID",
      aliases: ["participant id", "participant uuid"],
    },
    {
      key: "patchJson",
      header: "Patch JSON",
      aliases: ["patch json", "update json", "changes json"],
    },
    {
      key: "createdAt",
      header: "Created At",
      aliases: ["created at", "updated at", "timestamp"],
    },
    {
      key: "updatedByAdminPhone",
      header: "Updated By Admin Phone",
      aliases: ["updated by admin phone", "updated by phone", "updated by"],
    },
  ];

const MAX_TITLE_LENGTH = 120;
const MAX_NAME_LENGTH = 120;
const MAX_CONTACT_LENGTH = 80;
const MAX_PAYMENT_INSTRUCTIONS_LENGTH = 2_000;
const MAX_INTERNAL_NOTES_LENGTH = 2_000;
// Google Sheets cells accept up to 50,000 characters. Keep the inline fallback
// below that boundary while still accepting normal Blob URLs.
const MAX_SCREENSHOT_URL_LENGTH = 45_000;
const MAX_ID_LENGTH = 100;
const MAX_MONEY_EGP = 100_000_000;
const MAX_CAPACITY = 100_000;
const READ_RANGE_END_COLUMN = "AZ";

const eventMutationLocks = new Map<string, Promise<void>>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configurationError(message: string): PostRunEventsError {
  return new PostRunEventsError("CONFIGURATION", message);
}

function validationError(message: string): PostRunEventsError {
  return new PostRunEventsError("VALIDATION", message);
}

function requireBoundedText(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw validationError(`${fieldName} must be text.`);
  }

  const normalized = value.trim();

  if (!normalized) {
    throw validationError(`${fieldName} is required.`);
  }

  if (normalized.length > maxLength) {
    throw validationError(
      `${fieldName} must be ${maxLength} characters or fewer.`,
    );
  }

  return normalized;
}

function requireStoredText(
  value: unknown,
  fieldName: string,
  rowIndex: number,
  maxLength: number,
): string {
  try {
    return requireBoundedText(value, fieldName, maxLength);
  } catch {
    throw configurationError(
      `${fieldName} is missing or invalid in sheet row ${rowIndex}.`,
    );
  }
}

function normalizeInternalNotes(
  value: unknown,
  errorKind: "CONFIGURATION" | "VALIDATION" = "VALIDATION",
): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  if (typeof value !== "string") {
    throw new PostRunEventsError(errorKind, "Internal notes must be text.");
  }

  const normalized = value.trim();

  if (normalized.length > MAX_INTERNAL_NOTES_LENGTH) {
    throw new PostRunEventsError(
      errorKind,
      `Internal notes must be ${MAX_INTERNAL_NOTES_LENGTH} characters or fewer.`,
    );
  }

  return normalized;
}

function normalizeMoney(
  value: unknown,
  fieldName: string,
  errorKind: "CONFIGURATION" | "VALIDATION" = "VALIDATION",
): number {
  let parsed: number;

  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && value.trim()) {
    parsed = Number(value.replaceAll(",", "").trim());
  } else {
    parsed = Number.NaN;
  }

  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    parsed > MAX_MONEY_EGP ||
    Math.abs(parsed * 100 - Math.round(parsed * 100)) > 1e-7
  ) {
    throw new PostRunEventsError(
      errorKind,
      `${fieldName} must be a non-negative EGP amount with at most two decimal places.`,
    );
  }

  return Math.round(parsed * 100) / 100;
}

function requireCapacity(
  value: unknown,
  errorKind: "CONFIGURATION" | "VALIDATION" = "VALIDATION",
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;

  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CAPACITY) {
    throw new PostRunEventsError(
      errorKind,
      `Max capacity must be a whole number between 1 and ${MAX_CAPACITY}.`,
    );
  }

  return parsed;
}

function requireIsoDate(
  value: unknown,
  fieldName: string,
  errorKind: "CONFIGURATION" | "VALIDATION" = "VALIDATION",
): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new PostRunEventsError(
      errorKind,
      `${fieldName} must use YYYY-MM-DD format.`,
    );
  }

  const normalized = value.trim();
  const [year, month, day] = normalized.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new PostRunEventsError(
      errorKind,
      `${fieldName} must be a real calendar date.`,
    );
  }

  return normalized;
}

function requireTimestamp(
  value: unknown,
  fieldName: string,
  rowIndex: number,
): string {
  const timestamp = requireStoredText(value, fieldName, rowIndex, 60);

  if (!Number.isFinite(Date.parse(timestamp))) {
    throw configurationError(
      `${fieldName} is not a valid timestamp in sheet row ${rowIndex}.`,
    );
  }

  return timestamp;
}

function optionalTimestamp(
  value: unknown,
  fieldName: string,
  rowIndex: number,
): string | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  return requireTimestamp(value, fieldName, rowIndex);
}

function normalizeOptionalMutationTimestamp(
  value: unknown,
  fieldName: string,
): string | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw validationError(`${fieldName} must be a valid timestamp.`);
  }

  return value;
}

function requireCanonicalPhone(
  value: unknown,
  fieldName: string,
  errorKind: "CONFIGURATION" | "VALIDATION" = "VALIDATION",
): string {
  const phone =
    typeof value === "string" ? normalizeEgyptianMobilePhone(value) : null;

  if (phone === null) {
    throw new PostRunEventsError(
      errorKind,
      `${fieldName} must be a valid Egyptian mobile number.`,
    );
  }

  return `+20${phone}`;
}

export function normalizeContactInput(
  input: string | null | undefined,
): string {
  if (!input || typeof input !== "string") {
    return "";
  }

  const trimmed = input.trim().replace(/^'/, "").trim();

  if (!trimmed || trimmed === "-") {
    return "";
  }

  const isHandle = trimmed.startsWith("@") || /[a-z._-]/i.test(trimmed);

  if (isHandle) {
    return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
  }

  const hasLeadingPlus = trimmed.startsWith("+");
  const digitsOnly = trimmed.replace(/\D/g, "");

  if (!digitsOnly) {
    return "";
  }

  if (hasLeadingPlus) {
    return `+${digitsOnly}`;
  }

  if (digitsOnly.startsWith("01") && digitsOnly.length === 11) {
    return `+20${digitsOnly.slice(1)}`;
  }

  return digitsOnly.length >= 8 ? `+${digitsOnly}` : digitsOnly;
}

function normalizeParticipantContact(
  value: unknown,
  errorKind: "CONFIGURATION" | "VALIDATION" = "VALIDATION",
): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value !== "string") {
    throw new PostRunEventsError(
      errorKind,
      "WhatsApp phone or @username must be text.",
    );
  }

  const rawContact = value.trim();

  if (!rawContact || rawContact === "-") {
    return "";
  }

  if (rawContact.length > MAX_CONTACT_LENGTH) {
    throw new PostRunEventsError(
      errorKind,
      `WhatsApp phone or @username must be at most ${MAX_CONTACT_LENGTH} characters.`,
    );
  }

  const contact = normalizeContactInput(rawContact);

  if (!contact) {
    return "";
  }

  if (contact.startsWith("@")) {
    return contact;
  }

  return contact;
}

function serializeParticipantContact(value: string): string {
  const contact = value.trim();

  if (!contact || contact.startsWith("@")) {
    return contact;
  }

  return contact.startsWith("'") ? contact : `'${contact}`;
}

function optionalCanonicalPhone(
  value: unknown,
  fieldName: string,
  rowIndex: number,
): string | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  try {
    return requireCanonicalPhone(value, fieldName, "CONFIGURATION");
  } catch {
    throw configurationError(
      `${fieldName} is invalid in sheet row ${rowIndex}.`,
    );
  }
}

function normalizeDepositStatus(
  value: unknown,
  errorKind: "CONFIGURATION" | "VALIDATION" = "VALIDATION",
): PostRunDepositStatus {
  const normalized =
    typeof value === "string"
      ? value.trim().toLocaleLowerCase("en-US")
      : "";

  if (normalized === "pending") {
    return "Pending";
  }

  if (normalized === "verified") {
    return "Verified";
  }

  throw new PostRunEventsError(
    errorKind,
    `Deposit status must be one of: ${POST_RUN_DEPOSIT_STATUSES.join(", ")}.`,
  );
}

function normalizeSettlementStatus(
  value: unknown,
  errorKind: "CONFIGURATION" | "VALIDATION" = "VALIDATION",
): PostRunSettlementStatus {
  const normalized =
    typeof value === "string"
      ? value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ")
      : "";

  if (normalized === "unpaid") {
    return "Unpaid";
  }

  if (normalized === "fully cleared") {
    return "Fully Cleared";
  }

  if (normalized === "free" || normalized === "free attendee") {
    return "Free";
  }

  throw new PostRunEventsError(
    errorKind,
    `Settlement status must be one of: ${POST_RUN_SETTLEMENT_STATUSES.join(
      ", ",
    )}.`,
  );
}

function normalizeScreenshotUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw validationError("Payment screenshot URL must be text.");
  }

  const normalized = value.trim();

  if (!normalized) {
    return null;
  }

  if (normalized.length > MAX_SCREENSHOT_URL_LENGTH) {
    throw validationError(
      `Payment screenshot URL must be ${MAX_SCREENSHOT_URL_LENGTH} characters or fewer.`,
    );
  }

  if (
    /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(
      normalized,
    )
  ) {
    return normalized;
  }

  let parsed: URL;

  try {
    parsed = new URL(normalized);
  } catch {
    throw validationError("Payment screenshot URL must be a valid URL.");
  }

  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname.endsWith(".private.blob.vercel-storage.com") ||
    !parsed.pathname.startsWith("/post-run-proofs/")
  ) {
    throw validationError(
      "Payment screenshot must use the configured private proof store.",
    );
  }

  return parsed.toString();
}

function normalizeStoredScreenshotUrl(
  value: unknown,
  rowIndex: number,
): string | null {
  try {
    return normalizeScreenshotUrl(value);
  } catch {
    throw configurationError(
      `Payment screenshot URL is invalid in sheet row ${rowIndex}.`,
    );
  }
}

export function computePostRunRemainingBalance(
  totalCostPerPersonEgp: number,
  depositAmountPaidEgp: number,
): number {
  const safeTicketPrice = Number.isFinite(totalCostPerPersonEgp)
    ? Math.max(0, totalCostPerPersonEgp)
    : 0;
  const safeAmountPaid = Number.isFinite(depositAmountPaidEgp)
    ? Math.max(0, depositAmountPaidEgp)
    : 0;

  return Math.max(
    0,
    Math.round((safeTicketPrice - safeAmountPaid) * 100) / 100,
  );
}

export function derivePostRunPaymentStatuses(
  amountPaidEgp: number,
  eventTicketPriceEgp: number,
  requestedSettlementStatus?: PostRunSettlementStatus,
): {
  depositStatus: PostRunDepositStatus;
  settlementStatus: PostRunSettlementStatus;
} {
  if (requestedSettlementStatus === "Free") {
    return {
      depositStatus: "Pending",
      settlementStatus: "Free",
    };
  }

  const safeAmountPaid = Number.isFinite(amountPaidEgp)
    ? Math.max(0, amountPaidEgp)
    : 0;
  const safeTicketPrice = Number.isFinite(eventTicketPriceEgp)
    ? Math.max(0, eventTicketPriceEgp)
    : 0;

  if (safeAmountPaid <= 0) {
    return {
      depositStatus: "Pending",
      settlementStatus: "Unpaid",
    };
  }

  if (safeAmountPaid >= safeTicketPrice) {
    return {
      depositStatus: "Verified",
      settlementStatus: "Fully Cleared",
    };
  }

  return {
    depositStatus: "Verified",
    settlementStatus: "Unpaid",
  };
}

function getCell<Key extends string>(
  row: readonly unknown[],
  columns: ColumnMap<Key>,
  key: Key,
): unknown {
  return row[columns[key]];
}

function normalizedAliases<Key extends string>(
  definition: HeaderDefinition<Key>,
): Set<string> {
  return new Set(
    [definition.header, ...definition.aliases].map(normalizeSheetHeader),
  );
}

function resolveHeaderColumns<Key extends string>(
  headerRow: readonly unknown[],
  definitions: readonly HeaderDefinition<Key>[],
): {
  columns: Partial<Record<Key, number>>;
  recognizedCount: number;
} {
  const normalizedHeaders = headerRow.map(normalizeSheetHeader);
  const columns: Partial<Record<Key, number>> = {};
  let recognizedCount = 0;

  for (const definition of definitions) {
    const aliases = normalizedAliases(definition);
    for (let index = normalizedHeaders.length - 1; index >= 0; index -= 1) {
      const header = normalizedHeaders[index];

      if (header && aliases.has(header)) {
        columns[definition.key] = index;
        recognizedCount += 1;
        break;
      }
    }
  }

  return { columns, recognizedCount };
}

async function findSheetProperties(sheetName: string) {
  const sheets = await getSheetsClient();
  const response = await withGoogleSheetsRetry(
    `find ${sheetName} sheet`,
    () =>
      sheets.spreadsheets.get({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        fields: "sheets.properties(sheetId,title)",
      }),
  );

  return (
    response.data.sheets?.find(
      (sheet) =>
        sheet.properties?.title
          ?.trim()
          .toLocaleLowerCase("en-US") ===
        sheetName.trim().toLocaleLowerCase("en-US"),
    )?.properties ?? null
  );
}

async function ensureSheetExists(sheetName: string): Promise<number> {
  const existing = await findSheetProperties(sheetName);

  if (typeof existing?.sheetId === "number") {
    return existing.sheetId;
  }

  const sheets = await getSheetsClient();

  try {
    const response = await withGoogleSheetsRetry(
      `create ${sheetName} sheet`,
      () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId: GOOGLE_SPREADSHEET_ID,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: sheetName,
                  },
                },
              },
            ],
          },
        }),
    );
    const createdSheetId =
      response.data.replies?.[0]?.addSheet?.properties?.sheetId;

    if (typeof createdSheetId === "number") {
      return createdSheetId;
    }
  } catch (error) {
    const createdByConcurrentRequest = await findSheetProperties(sheetName);

    if (typeof createdByConcurrentRequest?.sheetId === "number") {
      return createdByConcurrentRequest.sheetId;
    }

    throw error;
  }

  const created = await findSheetProperties(sheetName);

  if (typeof created?.sheetId !== "number") {
    throw configurationError(`Unable to create the ${sheetName} sheet.`);
  }

  return created.sheetId;
}

async function ensureSheetHeaders<Key extends string>(
  sheetName: string,
  definitions: readonly HeaderDefinition<Key>[],
): Promise<ColumnMap<Key>> {
  const sheetId = await ensureSheetExists(sheetName);
  const sheets = await getSheetsClient();
  const response = await withGoogleSheetsRetry(
    `read ${sheetName} headers`,
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(sheetName)}!1:1`,
      }),
  );
  let headerRow = [...(response.data.values?.[0] ?? [])];
  let resolved = resolveHeaderColumns(headerRow, definitions);
  const hasNonEmptyCell = headerRow.some(
    (cell) => normalizeSheetHeader(cell).length > 0,
  );

  if (hasNonEmptyCell && resolved.recognizedCount === 0) {
    await withGoogleSheetsRetry(`insert ${sheetName} header row`, () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId,
                  dimension: "ROWS",
                  startIndex: 0,
                  endIndex: 1,
                },
                inheritFromBefore: false,
              },
            },
          ],
        },
      }),
    );
    headerRow = [];
    resolved = resolveHeaderColumns(headerRow, definitions);
  }

  const columns = { ...resolved.columns } as Partial<Record<Key, number>>;
  let headersChanged = false;

  for (const definition of definitions) {
    if (columns[definition.key] !== undefined) {
      continue;
    }

    const columnIndex = headerRow.length;
    headerRow.push(definition.header);
    columns[definition.key] = columnIndex;
    headersChanged = true;
  }

  if (headersChanged || !hasNonEmptyCell) {
    const finalColumn = columnIndexToA1(Math.max(0, headerRow.length - 1));

    await withGoogleSheetsRetry(`write ${sheetName} headers`, () =>
      sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(sheetName)}!A1:${finalColumn}1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [headerRow],
        },
      }),
    );
  }

  for (const definition of definitions) {
    if (columns[definition.key] === undefined) {
      throw configurationError(
        `${sheetName} is missing the "${definition.header}" column.`,
      );
    }
  }

  return columns as ColumnMap<Key>;
}

async function getExistingEventColumns(): Promise<ColumnMap<EventColumn> | null> {
  const existing = await findSheetProperties(POST_RUN_EVENTS_SHEET_NAME);

  if (typeof existing?.sheetId !== "number") {
    return null;
  }

  const sheets = await getSheetsClient();
  const response = await withGoogleSheetsRetry(
    `read ${POST_RUN_EVENTS_SHEET_NAME} headers without initialization`,
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(POST_RUN_EVENTS_SHEET_NAME)}!1:1`,
      }),
  );
  const headerRow = response.data.values?.[0] ?? [];
  const hasNonEmptyCell = headerRow.some(
    (cell) => normalizeSheetHeader(cell).length > 0,
  );

  if (!hasNonEmptyCell) {
    return null;
  }

  const hasDataRows = async () => {
    const dataResponse = await withGoogleSheetsRetry(
      `check ${POST_RUN_EVENTS_SHEET_NAME} initialization state`,
      () =>
        sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SPREADSHEET_ID,
          range: `${quoteSheetName(
            POST_RUN_EVENTS_SHEET_NAME,
          )}!A2:${READ_RANGE_END_COLUMN}`,
        }),
    );

    return (dataResponse.data.values ?? []).some((row) =>
      row.some((cell) => String(cell ?? "").trim().length > 0),
    );
  };
  let resolved: ReturnType<typeof resolveHeaderColumns<EventColumn>>;

  try {
    resolved = resolveHeaderColumns(
      headerRow,
      EVENT_HEADER_DEFINITIONS,
    );
  } catch (error) {
    if (
      error instanceof PostRunEventsError &&
      error.code === "CONFIGURATION" &&
      !(await hasDataRows())
    ) {
      return null;
    }

    throw error;
  }

  if (resolved.recognizedCount === 0) {
    return null;
  }

  const columns = { ...resolved.columns } as Partial<
    Record<EventColumn, number>
  >;
  const optionalColumns = new Set<EventColumn>([
    "archivedAt",
    "archivedByAdminPhone",
  ]);
  let virtualColumnIndex = headerRow.length;

  for (const definition of EVENT_HEADER_DEFINITIONS) {
    if (
      columns[definition.key] === undefined &&
      optionalColumns.has(definition.key)
    ) {
      columns[definition.key] = virtualColumnIndex;
      virtualColumnIndex += 1;
    }
  }

  const missingRequiredColumn = EVENT_HEADER_DEFINITIONS.find(
    (definition) => columns[definition.key] === undefined,
  );

  if (missingRequiredColumn) {
    if (!(await hasDataRows())) {
      return null;
    }

    throw configurationError(
      `${POST_RUN_EVENTS_SHEET_NAME} is missing the "${missingRequiredColumn.header}" column.`,
    );
  }

  return columns as ColumnMap<EventColumn>;
}

async function getPostRunSheetColumns(): Promise<PostRunSheetColumns> {
  const [events, participants, participantUpdates] = await Promise.all([
    ensureSheetHeaders(POST_RUN_EVENTS_SHEET_NAME, EVENT_HEADER_DEFINITIONS),
    ensureSheetHeaders(
      POST_RUN_PARTICIPANTS_SHEET_NAME,
      PARTICIPANT_HEADER_DEFINITIONS,
    ),
    ensureSheetHeaders(
      POST_RUN_PARTICIPANT_UPDATES_SHEET_NAME,
      PARTICIPANT_UPDATE_HEADER_DEFINITIONS,
    ),
  ]);

  return { events, participants, participantUpdates };
}

function eventToRow(
  event: PostRunEvent,
  columns: ColumnMap<EventColumn>,
  existingRow: readonly unknown[] = [],
): unknown[] {
  const row = [...existingRow];
  const requiredLength = Math.max(...Object.values(columns)) + 1;

  while (row.length < requiredLength) {
    row.push("");
  }

  row[columns.id] = event.id;
  row[columns.title] = event.title;
  row[columns.associatedDate] = event.associatedDate;
  row[columns.totalCostPerPersonEgp] = event.totalCostPerPersonEgp;
  row[columns.requiredDepositPerPersonEgp] =
    event.requiredDepositPerPersonEgp;
  row[columns.maxCapacity] = event.maxCapacity ?? "";
  row[columns.paymentInstructions] = event.paymentInstructions;
  row[columns.createdAt] = event.createdAt;
  row[columns.updatedAt] = event.updatedAt;
  row[columns.createdByAdminPhone] = event.createdByAdminPhone;
  row[columns.archivedAt] = event.archivedAt ?? "";
  row[columns.archivedByAdminPhone] = event.archivedByAdminPhone ?? "";

  return row;
}

function participantToRow(
  participant: PostRunParticipant,
  columns: ColumnMap<ParticipantColumn>,
  existingRow: readonly unknown[] = [],
): unknown[] {
  const row = [...existingRow];
  const requiredLength = Math.max(...Object.values(columns)) + 1;

  while (row.length < requiredLength) {
    row.push("");
  }

  row[columns.id] = participant.id;
  row[columns.eventId] = participant.eventId;
  row[columns.name] = participant.name;
  row[columns.whatsappPhone] = serializeParticipantContact(
    participant.whatsappPhone,
  );
  row[columns.depositStatus] = participant.depositStatus;
  row[columns.depositAmountPaidEgp] = participant.depositAmountPaidEgp;
  row[columns.paymentScreenshotUrl] = participant.paymentScreenshotUrl ?? "";
  row[columns.remainingBalanceEgp] = participant.remainingBalanceEgp;
  row[columns.settlementStatus] = participant.settlementStatus;
  row[columns.createdAt] = participant.createdAt;
  row[columns.updatedAt] = participant.updatedAt;
  row[columns.createdByAdminPhone] = participant.createdByAdminPhone.startsWith("'")
    ? participant.createdByAdminPhone
    : `'${participant.createdByAdminPhone}`;
  row[columns.updatedByAdminPhone] = participant.updatedByAdminPhone.startsWith("'")
    ? participant.updatedByAdminPhone
    : `'${participant.updatedByAdminPhone}`;
  row[columns.internalNotes] = participant.internalNotes;
  row[columns.deletedAt] = participant.deletedAt ?? "";
  row[columns.deletedByAdminPhone] = participant.deletedByAdminPhone
    ? participant.deletedByAdminPhone.startsWith("'")
      ? participant.deletedByAdminPhone
      : `'${participant.deletedByAdminPhone}`
    : "";

  return row;
}

function participantUpdateToRow(
  update: ParticipantUpdate,
  columns: ColumnMap<ParticipantUpdateColumn>,
): unknown[] {
  const row: unknown[] = Array(
    Math.max(...Object.values(columns)) + 1,
  ).fill("");

  row[columns.id] = update.id;
  row[columns.eventId] = update.eventId;
  row[columns.participantId] = update.participantId;
  row[columns.patchJson] = JSON.stringify(update.patch);
  row[columns.createdAt] = update.createdAt;
  row[columns.updatedByAdminPhone] = update.updatedByAdminPhone;

  return row;
}

function parseEventRow(
  row: readonly unknown[],
  rowIndex: number,
  columns: ColumnMap<EventColumn>,
): PostRunEvent {
  const totalCostPerPersonEgp = normalizeMoney(
    getCell(row, columns, "totalCostPerPersonEgp"),
    "Total cost per person",
    "CONFIGURATION",
  );
  const requiredDepositPerPersonEgp = normalizeMoney(
    getCell(row, columns, "requiredDepositPerPersonEgp"),
    "Required deposit per person",
    "CONFIGURATION",
  );

  if (requiredDepositPerPersonEgp > totalCostPerPersonEgp) {
    throw configurationError(
      `Required deposit exceeds total cost in ${POST_RUN_EVENTS_SHEET_NAME} row ${rowIndex}.`,
    );
  }

  return {
    id: requireStoredText(
      getCell(row, columns, "id"),
      "Event ID",
      rowIndex,
      MAX_ID_LENGTH,
    ),
    title: requireStoredText(
      getCell(row, columns, "title"),
      "Event title",
      rowIndex,
      MAX_TITLE_LENGTH,
    ),
    associatedDate: requireIsoDate(
      getCell(row, columns, "associatedDate"),
      "Associated date",
      "CONFIGURATION",
    ),
    totalCostPerPersonEgp,
    requiredDepositPerPersonEgp,
    maxCapacity: requireCapacity(
      getCell(row, columns, "maxCapacity"),
      "CONFIGURATION",
    ),
    paymentInstructions: requireStoredText(
      getCell(row, columns, "paymentInstructions"),
      "Payment instructions",
      rowIndex,
      MAX_PAYMENT_INSTRUCTIONS_LENGTH,
    ),
    createdAt: requireTimestamp(
      getCell(row, columns, "createdAt"),
      "Created at",
      rowIndex,
    ),
    updatedAt: requireTimestamp(
      getCell(row, columns, "updatedAt"),
      "Updated at",
      rowIndex,
    ),
    createdByAdminPhone: requireCanonicalPhone(
      getCell(row, columns, "createdByAdminPhone"),
      "Created by admin phone",
      "CONFIGURATION",
    ),
    archivedAt: optionalTimestamp(
      getCell(row, columns, "archivedAt"),
      "Archived at",
      rowIndex,
    ),
    archivedByAdminPhone: optionalCanonicalPhone(
      getCell(row, columns, "archivedByAdminPhone"),
      "Archived by admin phone",
      rowIndex,
    ),
  };
}

function parseParticipantRow(
  row: readonly unknown[],
  rowIndex: number,
  columns: ColumnMap<ParticipantColumn>,
  event: PostRunEvent,
): PostRunParticipant {
  const requestedSettlementStatus = normalizeSettlementStatus(
    getCell(row, columns, "settlementStatus"),
    "CONFIGURATION",
  );
  const depositAmountPaidEgp = requestedSettlementStatus === "Free"
    ? 0
    : normalizeMoney(
        getCell(row, columns, "depositAmountPaidEgp"),
        "Deposit amount paid",
        "CONFIGURATION",
      );
  const effectiveAmountPaidEgp = requestedSettlementStatus === "Free"
    ? 0
    : requestedSettlementStatus === "Fully Cleared" &&
        depositAmountPaidEgp < event.totalCostPerPersonEgp
      ? event.totalCostPerPersonEgp
      : depositAmountPaidEgp;
  const remainingBalanceEgp = requestedSettlementStatus === "Free"
    ? 0
    : computePostRunRemainingBalance(
        event.totalCostPerPersonEgp,
        effectiveAmountPaidEgp,
      );
  const { depositStatus, settlementStatus } = derivePostRunPaymentStatuses(
    effectiveAmountPaidEgp,
    event.totalCostPerPersonEgp,
    requestedSettlementStatus,
  );
  const storedRemainingBalance = requestedSettlementStatus === "Free"
    ? 0
    : normalizeMoney(
        getCell(row, columns, "remainingBalanceEgp"),
        "Remaining balance",
        "CONFIGURATION",
      );

  if (Math.abs(storedRemainingBalance - remainingBalanceEgp) >= 0.01) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Corrected a stale computed post-run remaining balance.",
        sheet: POST_RUN_PARTICIPANTS_SHEET_NAME,
        rowIndex,
        storedRemainingBalance,
        computedRemainingBalance: remainingBalanceEgp,
      }),
    );
  }

  return {
    id: requireStoredText(
      getCell(row, columns, "id"),
      "Participant ID",
      rowIndex,
      MAX_ID_LENGTH,
    ),
    eventId: requireStoredText(
      getCell(row, columns, "eventId"),
      "Event ID",
      rowIndex,
      MAX_ID_LENGTH,
    ),
    name: requireStoredText(
      getCell(row, columns, "name"),
      "Participant name",
      rowIndex,
      MAX_NAME_LENGTH,
    ),
    whatsappPhone: normalizeParticipantContact(
      getCell(row, columns, "whatsappPhone"),
      "CONFIGURATION",
    ),
    depositStatus,
    depositAmountPaidEgp: effectiveAmountPaidEgp,
    paymentScreenshotUrl: normalizeStoredScreenshotUrl(
      getCell(row, columns, "paymentScreenshotUrl"),
      rowIndex,
    ),
    remainingBalanceEgp,
    settlementStatus,
    createdAt: requireTimestamp(
      getCell(row, columns, "createdAt"),
      "Created at",
      rowIndex,
    ),
    updatedAt: requireTimestamp(
      getCell(row, columns, "updatedAt"),
      "Updated at",
      rowIndex,
    ),
    createdByAdminPhone: requireCanonicalPhone(
      getCell(row, columns, "createdByAdminPhone"),
      "Created by admin phone",
      "CONFIGURATION",
    ),
    updatedByAdminPhone: requireCanonicalPhone(
      getCell(row, columns, "updatedByAdminPhone"),
      "Updated by admin phone",
      "CONFIGURATION",
    ),
    internalNotes: normalizeInternalNotes(
      getCell(row, columns, "internalNotes"),
      "CONFIGURATION",
    ),
    checkedIn: parseCheckedInCell(row[5]), // Column F (Confirmed?)
    deletedAt: optionalTimestamp(
      getCell(row, columns, "deletedAt"),
      "Deleted at",
      rowIndex,
    ),
    deletedByAdminPhone: optionalCanonicalPhone(
      getCell(row, columns, "deletedByAdminPhone"),
      "Deleted by admin phone",
      rowIndex,
    ),
  };
}


function parseParticipantUpdateRow(
  row: readonly unknown[],
  rowIndex: number,
  columns: ColumnMap<ParticipantUpdateColumn>,
): ParticipantUpdate {
  const serializedPatch = requireStoredText(
    getCell(row, columns, "patchJson"),
    "Patch JSON",
    rowIndex,
    MAX_SCREENSHOT_URL_LENGTH + 1_000,
  );
  let rawPatch: unknown;

  try {
    rawPatch = JSON.parse(serializedPatch);
  } catch {
    throw configurationError(
      `Patch JSON is invalid in ${POST_RUN_PARTICIPANT_UPDATES_SHEET_NAME} row ${rowIndex}.`,
    );
  }

  if (!isObject(rawPatch)) {
    throw configurationError(
      `Patch JSON must be an object in ${POST_RUN_PARTICIPANT_UPDATES_SHEET_NAME} row ${rowIndex}.`,
    );
  }

  const allowedKeys = new Set([
    "name",
    "whatsappPhone",
    "depositStatus",
    "depositAmountPaidEgp",
    "paymentScreenshotUrl",
    "settlementStatus",
    "internalNotes",
    "deletedAt",
    "deletedByAdminPhone",
  ]);
  const unknownKey = Object.keys(rawPatch).find((key) => !allowedKeys.has(key));

  if (unknownKey) {
    throw configurationError(
      `Patch JSON has unsupported field "${unknownKey}" in ${POST_RUN_PARTICIPANT_UPDATES_SHEET_NAME} row ${rowIndex}.`,
    );
  }

  const patch: {
    name?: string;
    whatsappPhone?: string;
    depositStatus?: PostRunDepositStatus;
    depositAmountPaidEgp?: number;
    paymentScreenshotUrl?: string | null;
    settlementStatus?: PostRunSettlementStatus;
    internalNotes?: string;
    deletedAt?: string | null;
    deletedByAdminPhone?: string | null;
  } = {};

  if (Object.prototype.hasOwnProperty.call(rawPatch, "name")) {
    patch.name = requireStoredText(
      rawPatch.name,
      "Participant name",
      rowIndex,
      MAX_NAME_LENGTH,
    );
  }

  if (Object.prototype.hasOwnProperty.call(rawPatch, "whatsappPhone")) {
    patch.whatsappPhone = normalizeParticipantContact(
      rawPatch.whatsappPhone,
      "CONFIGURATION",
    );
  }

  if (Object.prototype.hasOwnProperty.call(rawPatch, "depositStatus")) {
    patch.depositStatus = normalizeDepositStatus(
      rawPatch.depositStatus,
      "CONFIGURATION",
    );
  }

  if (Object.prototype.hasOwnProperty.call(rawPatch, "depositAmountPaidEgp")) {
    patch.depositAmountPaidEgp = normalizeMoney(
      rawPatch.depositAmountPaidEgp,
      "Deposit amount paid",
      "CONFIGURATION",
    );
  }

  if (Object.prototype.hasOwnProperty.call(rawPatch, "paymentScreenshotUrl")) {
    patch.paymentScreenshotUrl = normalizeStoredScreenshotUrl(
      rawPatch.paymentScreenshotUrl,
      rowIndex,
    );
  }

  if (Object.prototype.hasOwnProperty.call(rawPatch, "settlementStatus")) {
    patch.settlementStatus = normalizeSettlementStatus(
      rawPatch.settlementStatus,
      "CONFIGURATION",
    );
  }

  if (Object.prototype.hasOwnProperty.call(rawPatch, "internalNotes")) {
    patch.internalNotes = normalizeInternalNotes(
      rawPatch.internalNotes,
      "CONFIGURATION",
    );
  }

  if (Object.prototype.hasOwnProperty.call(rawPatch, "deletedAt")) {
    patch.deletedAt = optionalTimestamp(
      rawPatch.deletedAt,
      "Deleted at",
      rowIndex,
    );
  }

  if (Object.prototype.hasOwnProperty.call(rawPatch, "deletedByAdminPhone")) {
    patch.deletedByAdminPhone = optionalCanonicalPhone(
      rawPatch.deletedByAdminPhone,
      "Deleted by admin phone",
      rowIndex,
    );
  }

  if (Object.keys(patch).length === 0) {
    throw configurationError(
      `Patch JSON has no changes in ${POST_RUN_PARTICIPANT_UPDATES_SHEET_NAME} row ${rowIndex}.`,
    );
  }

  return {
    id: requireStoredText(
      getCell(row, columns, "id"),
      "Update ID",
      rowIndex,
      MAX_ID_LENGTH,
    ),
    eventId: requireStoredText(
      getCell(row, columns, "eventId"),
      "Event ID",
      rowIndex,
      MAX_ID_LENGTH,
    ),
    participantId: requireStoredText(
      getCell(row, columns, "participantId"),
      "Participant ID",
      rowIndex,
      MAX_ID_LENGTH,
    ),
    patch,
    createdAt: requireTimestamp(
      getCell(row, columns, "createdAt"),
      "Created at",
      rowIndex,
    ),
    updatedByAdminPhone: requireCanonicalPhone(
      getCell(row, columns, "updatedByAdminPhone"),
      "Updated by admin phone",
      "CONFIGURATION",
    ),
  };
}

function applyParticipantUpdate(
  current: PostRunParticipant,
  update: ParticipantUpdate,
  event: PostRunEvent,
): PostRunParticipant {
  const patchedAmountPaidEgp =
    update.patch.depositAmountPaidEgp ?? current.depositAmountPaidEgp;
  const requestedSettlementStatus =
    update.patch.settlementStatus ??
    (update.patch.depositAmountPaidEgp === undefined
      ? current.settlementStatus
      : undefined);
  const depositAmountPaidEgp = requestedSettlementStatus === "Free"
    ? 0
    : update.patch.settlementStatus === "Fully Cleared" &&
        update.patch.depositAmountPaidEgp === undefined
      ? Math.max(patchedAmountPaidEgp, event.totalCostPerPersonEgp)
      : patchedAmountPaidEgp;
  const remainingBalanceEgp = requestedSettlementStatus === "Free"
    ? 0
    : computePostRunRemainingBalance(
        event.totalCostPerPersonEgp,
        depositAmountPaidEgp,
      );
  const { depositStatus, settlementStatus } = derivePostRunPaymentStatuses(
    depositAmountPaidEgp,
    event.totalCostPerPersonEgp,
    requestedSettlementStatus,
  );

  return {
    ...current,
    name: update.patch.name ?? current.name,
    whatsappPhone:
      update.patch.whatsappPhone ?? current.whatsappPhone,
    depositStatus,
    depositAmountPaidEgp,
    paymentScreenshotUrl:
      update.patch.paymentScreenshotUrl === undefined
        ? current.paymentScreenshotUrl
        : update.patch.paymentScreenshotUrl,
    remainingBalanceEgp,
    settlementStatus,
    internalNotes: update.patch.internalNotes ?? current.internalNotes,
    deletedAt:
      update.patch.deletedAt === undefined
        ? current.deletedAt
        : update.patch.deletedAt,
    deletedByAdminPhone:
      update.patch.deletedByAdminPhone === undefined
        ? current.deletedByAdminPhone
        : update.patch.deletedByAdminPhone,
    updatedAt: update.createdAt,
    updatedByAdminPhone: update.updatedByAdminPhone,
  };
}

async function readEventRows(
  columns: ColumnMap<EventColumn>,
): Promise<EventRow[]> {
  const sheets = await getSheetsClient();
  const response = await withGoogleSheetsRetry("list post-run events", () =>
    sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: `${quoteSheetName(
        POST_RUN_EVENTS_SHEET_NAME,
      )}!A2:${READ_RANGE_END_COLUMN}`,
    }),
  );
  const rows = response.data.values ?? [];
  const parsedRows: EventRow[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];

    if (row.every((cell) => String(cell ?? "").trim() === "")) {
      continue;
    }

    const rowIndex = index + 2;

    let value: PostRunEvent;

    try {
      value = parseEventRow(row, rowIndex, columns);
    } catch (rowError) {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Skipping corrupted post-run event row.",
          sheet: POST_RUN_EVENTS_SHEET_NAME,
          rowIndex,
          error:
            rowError instanceof Error ? rowError.message : String(rowError),
        }),
      );
      continue;
    }

    if (seenIds.has(value.id)) {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: `Skipping duplicate event ID "${value.id}" in ${POST_RUN_EVENTS_SHEET_NAME}.`,
          sheet: POST_RUN_EVENTS_SHEET_NAME,
          rowIndex,
        }),
      );
      continue;
    }

    seenIds.add(value.id);
    parsedRows.push({ value, rowIndex, rawRow: row });
  }

  return parsedRows;
}

async function requireEvent(
  eventId: string,
  columns: ColumnMap<EventColumn>,
  options: Readonly<{ includeArchived?: boolean }> = {},
): Promise<PostRunEvent> {
  const normalizedEventId = requireBoundedText(
    eventId,
    "Event ID",
    MAX_ID_LENGTH,
  );
  const events = await readEventRows(columns);
  const event = events.find((candidate) => candidate.value.id === normalizedEventId);

  if (!event || (!options.includeArchived && event.value.archivedAt !== null)) {
    throw new PostRunEventsError(
      "NOT_FOUND",
      `Post-run event "${normalizedEventId}" was not found.`,
    );
  }

  return event.value;
}

async function readMatchingRowIndices(
  sheetName: string,
  columnIndex: number,
  expectedValue: string,
): Promise<number[]> {
  const sheets = await getSheetsClient();
  const response = await withGoogleSheetsRetry(
    `find ${sheetName} rows for post-run event ${expectedValue}`,
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(sheetName)}!A2:${READ_RANGE_END_COLUMN}`,
      }),
  );

  return (response.data.values ?? []).flatMap((row, index) =>
    String(row[columnIndex] ?? "").trim() === expectedValue ? [index + 2] : [],
  );
}

async function readBaseParticipantRows(
  event: PostRunEvent,
  columns: ColumnMap<ParticipantColumn>,
): Promise<ParticipantRow[]> {
  const sheets = await getSheetsClient();
  const response = await withGoogleSheetsRetry(
    `list participants for post-run event ${event.id}`,
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(
          POST_RUN_PARTICIPANTS_SHEET_NAME,
        )}!A2:${READ_RANGE_END_COLUMN}`,
      }),
  );
  const rows = response.data.values ?? [];
  const parsedRows: ParticipantRow[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];

    if (row.every((cell) => String(cell ?? "").trim() === "")) {
      continue;
    }

    const rowEventId = String(getCell(row, columns, "eventId") ?? "").trim();

    if (rowEventId !== event.id) {
      continue;
    }

    const rowIndex = index + 2;
    const value = parseParticipantRow(row, rowIndex, columns, event);

    if (seenIds.has(value.id)) {
      throw configurationError(
        `Duplicate participant ID "${value.id}" for event "${event.id}".`,
      );
    }

    seenIds.add(value.id);
    parsedRows.push({ value, rowIndex, rawRow: row });
  }

  return parsedRows;
}

async function readParticipantUpdates(
  event: PostRunEvent,
  columns: ColumnMap<ParticipantUpdateColumn>,
): Promise<ParticipantUpdate[]> {
  const sheets = await getSheetsClient();
  const response = await withGoogleSheetsRetry(
    `list participant updates for post-run event ${event.id}`,
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(
          POST_RUN_PARTICIPANT_UPDATES_SHEET_NAME,
        )}!A2:${READ_RANGE_END_COLUMN}`,
      }),
  );
  const rows = response.data.values ?? [];
  const updates: ParticipantUpdate[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];

    if (row.every((cell) => String(cell ?? "").trim() === "")) {
      continue;
    }

    const rowEventId = String(getCell(row, columns, "eventId") ?? "").trim();

    if (rowEventId !== event.id) {
      continue;
    }

    const rowIndex = index + 2;
    const update = parseParticipantUpdateRow(row, rowIndex, columns);

    if (seenIds.has(update.id)) {
      throw configurationError(
        `Duplicate update ID "${update.id}" in ${POST_RUN_PARTICIPANT_UPDATES_SHEET_NAME}.`,
      );
    }

    seenIds.add(update.id);
    updates.push(update);
  }

  return updates.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

async function readParticipantRows(
  event: PostRunEvent,
  participantColumns: ColumnMap<ParticipantColumn>,
  updateColumns: ColumnMap<ParticipantUpdateColumn>,
): Promise<ParticipantRow[]> {
  const [baseRows, updates] = await Promise.all([
    readBaseParticipantRows(event, participantColumns),
    readParticipantUpdates(event, updateColumns),
  ]);
  const rowsById = new Map(baseRows.map((row) => [row.value.id, row]));

  for (const update of updates) {
    const currentRow = rowsById.get(update.participantId);

    if (!currentRow) {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Ignored an orphaned post-run participant update.",
          eventId: event.id,
          participantId: update.participantId,
          updateId: update.id,
        }),
      );
      continue;
    }

    rowsById.set(update.participantId, {
      ...currentRow,
      value: applyParticipantUpdate(currentRow.value, update, event),
    });
  }

  return [...rowsById.values()];
}

async function withEventMutationLock<T>(
  eventId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = eventMutationLocks.get(eventId) ?? Promise.resolve();
  let releaseLock: () => void = () => undefined;
  const lock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => lock);

  eventMutationLocks.set(eventId, tail);
  await previous.catch(() => undefined);

  try {
    return await mutation();
  } finally {
    releaseLock();

    if (eventMutationLocks.get(eventId) === tail) {
      eventMutationLocks.delete(eventId);
    }
  }
}

function compareParticipantRows(
  left: ParticipantRow,
  right: ParticipantRow,
): number {
  return (
    left.rowIndex - right.rowIndex ||
    left.value.createdAt.localeCompare(right.value.createdAt) ||
    left.value.id.localeCompare(right.value.id)
  );
}

async function clearParticipantRows(rowIndices: readonly number[]) {
  const uniqueRows = [...new Set(rowIndices)].filter(
    (rowIndex) => Number.isSafeInteger(rowIndex) && rowIndex >= 2,
  );

  if (uniqueRows.length === 0) {
    return;
  }

  const sheets = await getSheetsClient();

  await withGoogleSheetsRetry("reconcile concurrent participant additions", () =>
    sheets.spreadsheets.values.batchClear({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      requestBody: {
        ranges: uniqueRows.map(
          (rowIndex) =>
            `${quoteSheetName(
              POST_RUN_PARTICIPANTS_SHEET_NAME,
            )}!A${rowIndex}:${READ_RANGE_END_COLUMN}${rowIndex}`,
        ),
      },
    }),
  );
}

async function reconcileParticipantAddition(
  event: PostRunEvent,
  participant: PostRunParticipant,
  columns: PostRunSheetColumns,
  allowDuplicateContact: boolean,
): Promise<PostRunParticipant> {
  await new Promise((resolve) => setTimeout(resolve, 125));

  const rows = (
    await readParticipantRows(
      event,
      columns.participants,
      columns.participantUpdates,
    )
  )
    .filter((row) => row.value.deletedAt === null)
    .sort(compareParticipantRows);
  const addedRow = rows.find((row) => row.value.id === participant.id);

  if (!addedRow) {
    throw new PostRunEventsError(
      "CAPACITY_REACHED",
      `"${event.title}" reached capacity while this participant was being added.`,
    );
  }

  const participantContactKey = participant.whatsappPhone
    .trim()
    .toLocaleLowerCase("en-US");

  if (!allowDuplicateContact && participantContactKey) {
    const phoneWinner = rows.find(
      (row) =>
        row.value.whatsappPhone.trim().toLocaleLowerCase("en-US") ===
        participantContactKey,
    );

    if (phoneWinner?.value.id !== participant.id) {
      await clearParticipantRows([addedRow.rowIndex]);
      throw new PostRunEventsError(
        "CONFLICT",
        "This phone number was registered by another request first.",
      );
    }
  }

  if (
    event.maxCapacity !== null &&
    !rows.slice(0, event.maxCapacity).some(
      (row) => row.value.id === participant.id,
    )
  ) {
    await clearParticipantRows([addedRow.rowIndex]);
    throw new PostRunEventsError(
      "CAPACITY_REACHED",
      `"${event.title}" reached capacity while this participant was being added.`,
    );
  }

  return addedRow.value;
}

function sanitizeEventTabName(title: string): string {
  const cleaned = title.replace(/[:\\/?*\[\]]/g, " ").trim();
  return (cleaned || "EventTab").slice(0, 100);
}

export async function getOrEnsureEventSheet(eventName: string): Promise<number> {
  const tabName = sanitizeEventTabName(eventName);
  const sheetId = await ensureSheetExists(tabName);
  const sheets = await getSheetsClient();

  const headerResponse = await withGoogleSheetsRetry(
    `read ${tabName} headers`,
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(tabName)}!1:1`,
      }),
  );

  const existingHeaders = headerResponse.data.values?.[0] ?? [];
  if (existingHeaders.length === 0) {
    await withGoogleSheetsRetry(`write ${tabName} headers`, () =>
      sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(tabName)}!A1:F1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[...POST_RUN_EVENT_TAB_HEADERS]],
        },
      }),
    );
  }

  return sheetId;
}

function eventTabPaymentStatus(participant: PostRunParticipant): string {
  if (participant.settlementStatus === "Free") {
    return "Free";
  }

  if (participant.settlementStatus === "Fully Cleared") {
    return "Fully Cleared";
  }

  return participant.depositAmountPaidEgp > 0 ? "Deposit Paid" : "Unpaid";
}

async function syncParticipantToEventTab(
  event: PostRunEvent,
  participant: PostRunParticipant,
): Promise<void> {
  const tabName = sanitizeEventTabName(event.title);
  try {
    const sheets = await getSheetsClient();

    const formattedPhone = serializeParticipantContact(
      participant.whatsappPhone,
    );

    const isCleared =
      participant.settlementStatus === "Fully Cleared" ||
      participant.settlementStatus === "Free" ||
      participant.checkedIn === true;
    const colFValue = isCleared ? "TRUE" : "FALSE";

    const rowValues = [
      participant.name,
      formattedPhone,
      eventTabPaymentStatus(participant),
      participant.depositAmountPaidEgp,
      participant.remainingBalanceEgp,
      colFValue,
    ];

    await withGoogleSheetsIdempotentMutationRetry(
      `append participant to ${tabName} tab`,
      () =>
        sheets.spreadsheets.values.append({
          spreadsheetId: GOOGLE_SPREADSHEET_ID,
          range: `${quoteSheetName(tabName)}!A:F`,
          valueInputOption: "RAW",
          insertDataOption: "INSERT_ROWS",
          requestBody: {
            values: [rowValues],
          },
        }),
      async () => {
        const rowsResponse = await sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SPREADSHEET_ID,
          range: `${quoteSheetName(tabName)}!A2:F`,
        });
        const rows = rowsResponse.data.values ?? [];
        return rows.some((row) => {
          const storedContact = String(row[1] ?? "")
            .trim()
            .replace(/^'/, "");

          return (
            String(row[0] ?? "").trim() === participant.name &&
            storedContact === participant.whatsappPhone
          );
        });
      },
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: `Failed to sync participant to event tab "${tabName}". Master ledger recording succeeded.`,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function syncParticipantUpdateToEventTab(
  event: PostRunEvent,
  participant: PostRunParticipant,
  previousParticipant: PostRunParticipant,
): Promise<void> {
  const tabName = sanitizeEventTabName(event.title);

  try {
    const sheets = await getSheetsClient();
    const rowsResponse = await withGoogleSheetsRetry(
      `find participant in ${tabName} tab`,
      () =>
        sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SPREADSHEET_ID,
          range: `${quoteSheetName(tabName)}!A2:F`,
        }),
    );
    const rows = rowsResponse.data.values ?? [];
    const rowOffset = rows.findIndex((row) => {
      const storedContact = String(row[1] ?? "").trim().replace(/^'/, "");

      return (
        String(row[0] ?? "").trim() === previousParticipant.name &&
        storedContact === previousParticipant.whatsappPhone
      );
    });

    if (rowOffset < 0) {
      return;
    }

    const isCleared =
      participant.settlementStatus === "Fully Cleared" ||
      participant.settlementStatus === "Free" ||
      participant.checkedIn === true;
    const colFValue = isCleared ? "TRUE" : "FALSE";

    const rowNumber = rowOffset + 2;
    await withGoogleSheetsRetry(`update participant in ${tabName} tab`, () =>
      sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(tabName)}!A${rowNumber}:F${rowNumber}`,
        valueInputOption: "RAW",
        requestBody: {
          values: [[
            participant.name,
            serializeParticipantContact(participant.whatsappPhone),
            eventTabPaymentStatus(participant),
            participant.depositAmountPaidEgp,
            participant.remainingBalanceEgp,
            colFValue,
          ]],
        },
      }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: `Failed to update participant in event tab "${tabName}". Master ledger recording succeeded.`,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}


let cachedPostRunEvents: {
  events: PostRunEvent[];
  updatedAt: number;
} | null = null;

export async function listPostRunEvents(
  options: Readonly<{ includeArchived?: boolean }> = {},
): Promise<PostRunEvent[]> {
  const columns = await getExistingEventColumns();

  if (!columns) {
    return [];
  }

  const rows = await readEventRows(columns);
  const events = rows
    .map((row) => row.value)
    .filter((event) => options.includeArchived || event.archivedAt === null)
    .sort((left, right) => {
      return (
        Number(left.archivedAt !== null) - Number(right.archivedAt !== null) ||
        left.associatedDate.localeCompare(right.associatedDate) ||
        left.title.localeCompare(right.title)
      );
    });

  cachedPostRunEvents = { events, updatedAt: Date.now() };

  return events;
}

export type PostRunEventsResult = Readonly<{
  events: PostRunEvent[];
  source: "live" | "cache";
}>;

export async function listPostRunEventsWithFallback(
  options: Readonly<{ includeArchived?: boolean }> = {},
): Promise<PostRunEventsResult> {
  try {
    const events = await listPostRunEvents(options);
    return { events, source: "live" };
  } catch (error) {
    if (cachedPostRunEvents) {
      console.warn(
        JSON.stringify({
          level: "warn",
          message:
            "Google Sheets request failed; returning cached post-run events.",
          cacheAge: `${Math.round((Date.now() - cachedPostRunEvents.updatedAt) / 1_000)}s`,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

      let events = cachedPostRunEvents.events;

      if (!options.includeArchived) {
        events = events.filter((event) => event.archivedAt === null);
      }

      return { events, source: "cache" };
    }

    throw error;
  }
}

export async function createPostRunEvent(
  input: PostRunEventInput,
  adminPhone: string,
): Promise<PostRunEvent> {
  if (!isObject(input)) {
    throw validationError("Event input must be an object.");
  }

  const title = requireBoundedText(input.title, "Event title", MAX_TITLE_LENGTH);
  const associatedDate = requireIsoDate(
    input.associatedDate,
    "Associated date",
  );
  const totalCostPerPersonEgp = normalizeMoney(
    input.totalCostPerPersonEgp,
    "Total cost per person",
  );
  const requiredDepositPerPersonEgp = normalizeMoney(
    input.requiredDepositPerPersonEgp,
    "Required deposit per person",
  );

  if (requiredDepositPerPersonEgp > totalCostPerPersonEgp) {
    throw validationError(
      "Required deposit per person cannot exceed total cost per person.",
    );
  }

  const maxCapacity = requireCapacity(input.maxCapacity);
  const paymentInstructions = requireBoundedText(
    input.paymentInstructions,
    "Payment instructions",
    MAX_PAYMENT_INSTRUCTIONS_LENGTH,
  );
  const createdByAdminPhone = requireCanonicalPhone(
    adminPhone,
    "Admin phone",
  );
  const columns = await getPostRunSheetColumns();
  const now = new Date().toISOString();
  const event: PostRunEvent = {
    id: randomUUID(),
    title,
    associatedDate,
    totalCostPerPersonEgp,
    requiredDepositPerPersonEgp,
    maxCapacity,
    paymentInstructions,
    createdAt: now,
    updatedAt: now,
    createdByAdminPhone,
    archivedAt: null,
    archivedByAdminPhone: null,
  };
  const sheets = await getSheetsClient();
  const finalColumn = columnIndexToA1(
    Math.max(...Object.values(columns.events)),
  );

  await withGoogleSheetsIdempotentMutationRetry(
    "create post-run event",
    () =>
      sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(
          POST_RUN_EVENTS_SHEET_NAME,
        )}!A:${finalColumn}`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [eventToRow(event, columns.events)],
        },
      }),
    async () => {
      const events = await readEventRows(columns.events);
      return events.some((candidate) => candidate.value.id === event.id);
    },
  );

  return event;
}

export async function updatePostRunEvent(
  eventId: string,
  patch: PostRunEventPatch,
  adminPhone: string,
): Promise<PostRunEvent> {
  const normalizedEventId = requireBoundedText(
    eventId,
    "Event ID",
    MAX_ID_LENGTH,
  );

  return withEventMutationLock(normalizedEventId, async () => {
    if (!isObject(patch)) {
      throw validationError("Event patch must be an object.");
    }

    const patchKeys: readonly (keyof PostRunEventPatch)[] = [
      "title",
      "associatedDate",
      "totalCostPerPersonEgp",
      "requiredDepositPerPersonEgp",
      "maxCapacity",
      "paymentInstructions",
    ];
    const unknownPatchKey = Object.keys(patch).find(
      (key) => !patchKeys.includes(key as keyof PostRunEventPatch),
    );

    if (unknownPatchKey) {
      throw validationError(
        `Event patch field "${unknownPatchKey}" is not supported.`,
      );
    }

    if (
      !patchKeys.some((key) => Object.prototype.hasOwnProperty.call(patch, key))
    ) {
      throw validationError("Event patch does not contain any changes.");
    }

    const columns = await getPostRunSheetColumns();
    const eventRows = await readEventRows(columns.events);
    const currentRow = eventRows.find(
      (candidate) =>
        candidate.value.id === normalizedEventId &&
        candidate.value.archivedAt === null,
    );

    if (!currentRow) {
      throw new PostRunEventsError(
        "NOT_FOUND",
        `Post-run event "${normalizedEventId}" was not found.`,
      );
    }

    const current = currentRow.value;
    const totalCostPerPersonEgp = Object.prototype.hasOwnProperty.call(
      patch,
      "totalCostPerPersonEgp",
    )
      ? normalizeMoney(
          patch.totalCostPerPersonEgp,
          "Total cost per person",
        )
      : current.totalCostPerPersonEgp;
    const requiredDepositPerPersonEgp = Object.prototype.hasOwnProperty.call(
      patch,
      "requiredDepositPerPersonEgp",
    )
      ? normalizeMoney(
          patch.requiredDepositPerPersonEgp,
          "Required deposit per person",
        )
      : current.requiredDepositPerPersonEgp;

    if (requiredDepositPerPersonEgp > totalCostPerPersonEgp) {
      throw validationError(
        "Required deposit per person cannot exceed total cost per person.",
      );
    }

    requireCanonicalPhone(adminPhone, "Admin phone");
    const updated: PostRunEvent = {
      ...current,
      title: Object.prototype.hasOwnProperty.call(patch, "title")
        ? requireBoundedText(patch.title, "Event title", MAX_TITLE_LENGTH)
        : current.title,
      associatedDate: Object.prototype.hasOwnProperty.call(
        patch,
        "associatedDate",
      )
        ? requireIsoDate(patch.associatedDate, "Associated date")
        : current.associatedDate,
      totalCostPerPersonEgp,
      requiredDepositPerPersonEgp,
      maxCapacity: Object.prototype.hasOwnProperty.call(patch, "maxCapacity")
        ? requireCapacity(patch.maxCapacity)
        : current.maxCapacity,
      paymentInstructions: Object.prototype.hasOwnProperty.call(
        patch,
        "paymentInstructions",
      )
        ? requireBoundedText(
            patch.paymentInstructions,
            "Payment instructions",
            MAX_PAYMENT_INSTRUCTIONS_LENGTH,
          )
        : current.paymentInstructions,
      updatedAt: new Date().toISOString(),
    };
    const finalColumn = columnIndexToA1(
      Math.max(
        ...Object.values(columns.events),
        currentRow.rawRow.length - 1,
      ),
    );
    const range = `${quoteSheetName(POST_RUN_EVENTS_SHEET_NAME)}!A${
      currentRow.rowIndex
    }:${finalColumn}${currentRow.rowIndex}`;
    const sheets = await getSheetsClient();

    await withGoogleSheetsIdempotentMutationRetry(
      `update post-run event ${updated.id}`,
      () =>
        sheets.spreadsheets.values.update({
          spreadsheetId: GOOGLE_SPREADSHEET_ID,
          range,
          valueInputOption: "RAW",
          requestBody: {
            values: [
              eventToRow(updated, columns.events, currentRow.rawRow),
            ],
          },
        }),
      async () => {
        const refreshedRows = await readEventRows(columns.events);
        return refreshedRows.some(
          (candidate) =>
            candidate.value.id === updated.id &&
            candidate.value.updatedAt === updated.updatedAt,
        );
      },
    );

    return updated;
  });
}

export async function archivePostRunEvent(
  eventId: string,
  adminPhone: string,
): Promise<PostRunEvent> {
  const normalizedEventId = requireBoundedText(
    eventId,
    "Event ID",
    MAX_ID_LENGTH,
  );

  return withEventMutationLock(normalizedEventId, async () => {
    const columns = await getPostRunSheetColumns();
    const eventRows = await readEventRows(columns.events);
    const currentRow = eventRows.find(
      (candidate) =>
        candidate.value.id === normalizedEventId &&
        candidate.value.archivedAt === null,
    );

    if (!currentRow) {
      throw new PostRunEventsError(
        "NOT_FOUND",
        `Post-run event "${normalizedEventId}" was not found.`,
      );
    }

    const archivedByAdminPhone = requireCanonicalPhone(
      adminPhone,
      "Admin phone",
    );
    const now = new Date().toISOString();
    const archived: PostRunEvent = {
      ...currentRow.value,
      updatedAt: now,
      archivedAt: now,
      archivedByAdminPhone,
    };
    const finalColumn = columnIndexToA1(
      Math.max(
        ...Object.values(columns.events),
        currentRow.rawRow.length - 1,
      ),
    );
    const range = `${quoteSheetName(POST_RUN_EVENTS_SHEET_NAME)}!A${
      currentRow.rowIndex
    }:${finalColumn}${currentRow.rowIndex}`;
    const sheets = await getSheetsClient();

    await withGoogleSheetsIdempotentMutationRetry(
      `archive post-run event ${archived.id}`,
      () =>
        sheets.spreadsheets.values.update({
          spreadsheetId: GOOGLE_SPREADSHEET_ID,
          range,
          valueInputOption: "RAW",
          requestBody: {
            values: [
              eventToRow(archived, columns.events, currentRow.rawRow),
            ],
          },
        }),
      async () => {
        const refreshedRows = await readEventRows(columns.events);
        return refreshedRows.some(
          (candidate) =>
            candidate.value.id === archived.id &&
            candidate.value.archivedAt === archived.archivedAt,
        );
      },
    );

    return archived;
  });
}

export async function unarchivePostRunEvent(
  eventId: string,
  adminPhone: string,
): Promise<PostRunEvent> {
  const normalizedEventId = requireBoundedText(
    eventId,
    "Event ID",
    MAX_ID_LENGTH,
  );

  return withEventMutationLock(normalizedEventId, async () => {
    const columns = await getPostRunSheetColumns();
    const eventRows = await readEventRows(columns.events);
    const currentRow = eventRows.find(
      (candidate) =>
        candidate.value.id === normalizedEventId &&
        candidate.value.archivedAt !== null,
    );

    if (!currentRow) {
      throw new PostRunEventsError(
        "NOT_FOUND",
        `Archived post-run event "${normalizedEventId}" was not found.`,
      );
    }

    requireCanonicalPhone(adminPhone, "Admin phone");
    const restored: PostRunEvent = {
      ...currentRow.value,
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      archivedByAdminPhone: null,
    };
    const finalColumn = columnIndexToA1(
      Math.max(
        ...Object.values(columns.events),
        currentRow.rawRow.length - 1,
      ),
    );
    const range = `${quoteSheetName(POST_RUN_EVENTS_SHEET_NAME)}!A${
      currentRow.rowIndex
    }:${finalColumn}${currentRow.rowIndex}`;
    const sheets = await getSheetsClient();

    await withGoogleSheetsIdempotentMutationRetry(
      `unarchive post-run event ${restored.id}`,
      () =>
        sheets.spreadsheets.values.update({
          spreadsheetId: GOOGLE_SPREADSHEET_ID,
          range,
          valueInputOption: "RAW",
          requestBody: {
            values: [
              eventToRow(restored, columns.events, currentRow.rawRow),
            ],
          },
        }),
      async () => {
        const refreshedRows = await readEventRows(columns.events);
        return refreshedRows.some(
          (candidate) =>
            candidate.value.id === restored.id &&
            candidate.value.archivedAt === null &&
            candidate.value.updatedAt === restored.updatedAt,
        );
      },
    );

    return restored;
  });
}

export async function deletePostRunEvent(
  eventId: string,
  adminPhone: string,
): Promise<PostRunEventDeletionResult> {
  const normalizedEventId = requireBoundedText(
    eventId,
    "Event ID",
    MAX_ID_LENGTH,
  );

  return withEventMutationLock(normalizedEventId, async () => {
    requireCanonicalPhone(adminPhone, "Admin phone");
    const columns = await getPostRunSheetColumns();
    const eventRows = await readEventRows(columns.events);
    const currentRow = eventRows.find(
      (candidate) => candidate.value.id === normalizedEventId,
    );

    if (!currentRow) {
      throw new PostRunEventsError(
        "NOT_FOUND",
        `Post-run event "${normalizedEventId}" was not found.`,
      );
    }

    const [participantRows, updateRowIndices] = await Promise.all([
      readParticipantRows(
        currentRow.value,
        columns.participants,
        columns.participantUpdates,
      ),
      readMatchingRowIndices(
        POST_RUN_PARTICIPANT_UPDATES_SHEET_NAME,
        columns.participantUpdates.eventId,
        normalizedEventId,
      ),
    ]);
    const participantRowIndices = participantRows.map((row) => row.rowIndex);
    const ranges = [
      `${quoteSheetName(POST_RUN_EVENTS_SHEET_NAME)}!${currentRow.rowIndex}:${currentRow.rowIndex}`,
      ...participantRowIndices.map(
        (rowIndex) =>
          `${quoteSheetName(POST_RUN_PARTICIPANTS_SHEET_NAME)}!${rowIndex}:${rowIndex}`,
      ),
      ...updateRowIndices.map(
        (rowIndex) =>
          `${quoteSheetName(POST_RUN_PARTICIPANT_UPDATES_SHEET_NAME)}!${rowIndex}:${rowIndex}`,
      ),
    ];
    const sheets = await getSheetsClient();

    await withGoogleSheetsIdempotentMutationRetry(
      `permanently delete post-run event ${normalizedEventId}`,
      () =>
        sheets.spreadsheets.values.batchClear({
          spreadsheetId: GOOGLE_SPREADSHEET_ID,
          requestBody: { ranges },
        }),
      async () => {
        const [eventMatches, participantMatches, updateMatches] =
          await Promise.all([
            readMatchingRowIndices(
              POST_RUN_EVENTS_SHEET_NAME,
              columns.events.id,
              normalizedEventId,
            ),
            readMatchingRowIndices(
              POST_RUN_PARTICIPANTS_SHEET_NAME,
              columns.participants.eventId,
              normalizedEventId,
            ),
            readMatchingRowIndices(
              POST_RUN_PARTICIPANT_UPDATES_SHEET_NAME,
              columns.participantUpdates.eventId,
              normalizedEventId,
            ),
          ]);

        return (
          eventMatches.length === 0 &&
          participantMatches.length === 0 &&
          updateMatches.length === 0
        );
      },
    );

    return {
      event: currentRow.value,
      participantCount: participantRows.length,
      paymentProofUrls: [
        ...new Set(
          participantRows.flatMap((row) =>
            row.value.paymentScreenshotUrl?.includes(
              ".blob.vercel-storage.com",
            )
              ? [row.value.paymentScreenshotUrl]
              : [],
          ),
        ),
      ],
    };
  });
}

export async function listEventParticipants(
  eventId: string,
  options: Readonly<{ includeArchived?: boolean }> = {},
): Promise<PostRunParticipant[]> {
  const columns = await getPostRunSheetColumns();
  const event = await requireEvent(eventId, columns.events, options);
  const participants = await readParticipantRows(
    event,
    columns.participants,
    columns.participantUpdates,
  );

  return participants
    .map((row) => row.value)
    .filter((participant) => participant.deletedAt === null);
}

export async function addEventParticipant(
  eventId: string,
  input: PostRunParticipantInput,
  adminPhone: string,
): Promise<PostRunParticipant> {
  const normalizedEventId = requireBoundedText(
    eventId,
    "Event ID",
    MAX_ID_LENGTH,
  );

  return withEventMutationLock(normalizedEventId, async () => {
    if (!isObject(input)) {
      throw validationError("Participant input must be an object.");
    }

    const columns = await getPostRunSheetColumns();
    const event = await requireEvent(normalizedEventId, columns.events);
    await getOrEnsureEventSheet(event.title);
    const participants = (
      await readParticipantRows(
        event,
        columns.participants,
        columns.participantUpdates,
      )
    ).filter((participant) => participant.value.deletedAt === null);
    const name = requireBoundedText(
      input.name,
      "Participant name",
      MAX_NAME_LENGTH,
    );
    const whatsappPhone = normalizeParticipantContact(input.whatsappPhone);

    if (
      event.maxCapacity !== null &&
      participants.length >= event.maxCapacity
    ) {
      throw new PostRunEventsError(
        "CAPACITY_REACHED",
        `"${event.title}" has reached its maximum capacity.`,
      );
    }

    if (
      !input.force &&
      whatsappPhone &&
      participants.some(
        (participant) =>
          participant.value.whatsappPhone.toLocaleLowerCase("en-US") ===
          whatsappPhone.toLocaleLowerCase("en-US"),
      )
    ) {
      throw new PostRunEventsError(
        "CONFLICT",
        "This phone number or username is already registered for the event.",
      );
    }

    const requestedSettlementStatus =
      input.settlementStatus === undefined
        ? undefined
        : normalizeSettlementStatus(input.settlementStatus);
    const submittedAmountPaidEgp =
      input.depositAmountPaidEgp === undefined
        ? 0
        : normalizeMoney(
            input.depositAmountPaidEgp,
            "Deposit amount paid",
          );
    const depositAmountPaidEgp = requestedSettlementStatus === "Free"
      ? 0
      : submittedAmountPaidEgp;
    const remainingBalanceEgp = requestedSettlementStatus === "Free"
      ? 0
      : computePostRunRemainingBalance(
          event.totalCostPerPersonEgp,
          depositAmountPaidEgp,
        );
    const { depositStatus, settlementStatus } = derivePostRunPaymentStatuses(
      depositAmountPaidEgp,
      event.totalCostPerPersonEgp,
      requestedSettlementStatus,
    );
    const paymentScreenshotUrl = normalizeScreenshotUrl(
      input.paymentScreenshotUrl,
    );
    const normalizedAdminPhone = requireCanonicalPhone(
      adminPhone,
      "Admin phone",
    );
    const now = new Date().toISOString();
    const participant: PostRunParticipant = {
      id: randomUUID(),
      eventId: event.id,
      name,
      whatsappPhone,
      depositStatus,
      depositAmountPaidEgp,
      paymentScreenshotUrl,
      remainingBalanceEgp,
      settlementStatus,
      createdAt: now,
      updatedAt: now,
      createdByAdminPhone: normalizedAdminPhone,
      updatedByAdminPhone: normalizedAdminPhone,
      internalNotes: normalizeInternalNotes(input.internalNotes),
      deletedAt: null,
      deletedByAdminPhone: null,
    };
    const sheets = await getSheetsClient();
    const finalColumn = columnIndexToA1(
      Math.max(...Object.values(columns.participants)),
    );

    await withGoogleSheetsIdempotentMutationRetry(
      `add participant to post-run event ${event.id}`,
      () =>
        sheets.spreadsheets.values.append({
          spreadsheetId: GOOGLE_SPREADSHEET_ID,
          range: `${quoteSheetName(
            POST_RUN_PARTICIPANTS_SHEET_NAME,
          )}!A:${finalColumn}`,
          valueInputOption: "RAW",
          insertDataOption: "INSERT_ROWS",
          requestBody: {
            values: [participantToRow(participant, columns.participants)],
          },
        }),
      async () => {
        const rows = await readBaseParticipantRows(event, columns.participants);
        return rows.some((row) => row.value.id === participant.id);
      },
    );

    const reconciled = await reconcileParticipantAddition(
      event,
      participant,
      columns,
      input.force === true,
    );
    await syncParticipantToEventTab(event, reconciled);
    return reconciled;
  });
}

export async function updateEventParticipant(
  eventId: string,
  participantId: string,
  patch: PostRunParticipantPatch,
  adminPhone: string,
): Promise<PostRunParticipant> {
  const normalizedEventId = requireBoundedText(
    eventId,
    "Event ID",
    MAX_ID_LENGTH,
  );
  const normalizedParticipantId = requireBoundedText(
    participantId,
    "Participant ID",
    MAX_ID_LENGTH,
  );

  return withEventMutationLock(normalizedEventId, async () => {
    if (!isObject(patch)) {
      throw validationError("Participant patch must be an object.");
    }

    const patchKeys: readonly (keyof PostRunParticipantPatch)[] = [
      "name",
      "whatsappPhone",
      "depositStatus",
      "depositAmountPaidEgp",
      "paymentScreenshotUrl",
      "settlementStatus",
      "internalNotes",
      "deletedAt",
      "deletedByAdminPhone",
    ];
    const unknownPatchKey = Object.keys(patch).find(
      (key) => !patchKeys.includes(key as keyof PostRunParticipantPatch),
    );

    if (unknownPatchKey) {
      throw validationError(
        `Participant patch field "${unknownPatchKey}" is not supported.`,
      );
    }

    const hasChange = patchKeys.some(
      (key) => Object.prototype.hasOwnProperty.call(patch, key),
    );

    if (!hasChange) {
      throw validationError("Participant patch does not contain any changes.");
    }

    const columns = await getPostRunSheetColumns();
    const event = await requireEvent(normalizedEventId, columns.events);
    const participants = await readParticipantRows(
      event,
      columns.participants,
      columns.participantUpdates,
    );
    const currentRow = participants.find(
      (participant) => participant.value.id === normalizedParticipantId,
    );

    if (!currentRow) {
      throw new PostRunEventsError(
        "NOT_FOUND",
        `Participant "${normalizedParticipantId}" was not found for this event.`,
      );
    }

    if (currentRow.value.deletedAt !== null) {
      throw new PostRunEventsError(
        "NOT_FOUND",
        `Participant "${normalizedParticipantId}" was already deleted.`,
      );
    }

    const normalizedPatch: {
      name?: string;
      whatsappPhone?: string;
      depositStatus?: PostRunDepositStatus;
      depositAmountPaidEgp?: number;
      paymentScreenshotUrl?: string | null;
      settlementStatus?: PostRunSettlementStatus;
      internalNotes?: string;
      deletedAt?: string | null;
      deletedByAdminPhone?: string | null;
    } = {};

    if (Object.prototype.hasOwnProperty.call(patch, "name")) {
      normalizedPatch.name = requireBoundedText(
        patch.name,
        "Participant name",
        MAX_NAME_LENGTH,
      );
    }

    if (Object.prototype.hasOwnProperty.call(patch, "whatsappPhone")) {
      normalizedPatch.whatsappPhone = normalizeParticipantContact(
        patch.whatsappPhone,
      );
    }

    if (Object.prototype.hasOwnProperty.call(patch, "depositStatus")) {
      normalizedPatch.depositStatus = normalizeDepositStatus(
        patch.depositStatus,
      );
    }

    if (Object.prototype.hasOwnProperty.call(patch, "depositAmountPaidEgp")) {
      normalizedPatch.depositAmountPaidEgp = normalizeMoney(
        patch.depositAmountPaidEgp,
        "Deposit amount paid",
      );
    }

    if (Object.prototype.hasOwnProperty.call(patch, "paymentScreenshotUrl")) {
      normalizedPatch.paymentScreenshotUrl = normalizeScreenshotUrl(
        patch.paymentScreenshotUrl,
      );
    }

    if (Object.prototype.hasOwnProperty.call(patch, "settlementStatus")) {
      normalizedPatch.settlementStatus = normalizeSettlementStatus(
        patch.settlementStatus,
      );
    }

    if (Object.prototype.hasOwnProperty.call(patch, "internalNotes")) {
      normalizedPatch.internalNotes = normalizeInternalNotes(
        patch.internalNotes,
      );
    }

    if (Object.prototype.hasOwnProperty.call(patch, "deletedAt")) {
      normalizedPatch.deletedAt = normalizeOptionalMutationTimestamp(
        patch.deletedAt,
        "Deleted at",
      );
    }

    if (Object.prototype.hasOwnProperty.call(patch, "deletedByAdminPhone")) {
      normalizedPatch.deletedByAdminPhone =
        patch.deletedByAdminPhone === null
          ? null
          : requireCanonicalPhone(
              patch.deletedByAdminPhone,
              "Deleted by admin phone",
            );
    }

    const updatedByAdminPhone = requireCanonicalPhone(
      adminPhone,
      "Admin phone",
    );
    const update: ParticipantUpdate = {
      id: randomUUID(),
      eventId: event.id,
      participantId: currentRow.value.id,
      patch: normalizedPatch,
      createdAt: new Date().toISOString(),
      updatedByAdminPhone,
    };
    const row = participantUpdateToRow(
      update,
      columns.participantUpdates,
    );
    const finalColumn = columnIndexToA1(
      Math.max(...Object.values(columns.participantUpdates)),
    );
    const sheets = await getSheetsClient();

    await withGoogleSheetsIdempotentMutationRetry(
      `update participant ${currentRow.value.id} for post-run event ${event.id}`,
      () =>
        sheets.spreadsheets.values.append({
          spreadsheetId: GOOGLE_SPREADSHEET_ID,
          range: `${quoteSheetName(
            POST_RUN_PARTICIPANT_UPDATES_SHEET_NAME,
          )}!A:${finalColumn}`,
          valueInputOption: "RAW",
          insertDataOption: "INSERT_ROWS",
          requestBody: {
            values: [row],
          },
        }),
      async () => {
        const updates = await readParticipantUpdates(
          event,
          columns.participantUpdates,
        );
        return updates.some((candidate) => candidate.id === update.id);
      },
    );

    const refreshedParticipants = await readParticipantRows(
      event,
      columns.participants,
      columns.participantUpdates,
    );
    const refreshed = refreshedParticipants.find(
      (participant) => participant.value.id === normalizedParticipantId,
    );

    if (!refreshed) {
      throw new PostRunEventsError(
        "NOT_FOUND",
        `Participant "${normalizedParticipantId}" was removed during the update.`,
      );
    }

    await syncParticipantUpdateToEventTab(
      event,
      refreshed.value,
      currentRow.value,
    );
    return refreshed.value;
  });
}

export async function deleteEventParticipant(
  eventId: string,
  participantId: string,
  adminPhone: string,
): Promise<PostRunParticipant> {
  const deletedByAdminPhone = requireCanonicalPhone(
    adminPhone,
    "Admin phone",
  );

  return updateEventParticipant(
    eventId,
    participantId,
    {
      deletedAt: new Date().toISOString(),
      deletedByAdminPhone,
    },
    deletedByAdminPhone,
  );
}
