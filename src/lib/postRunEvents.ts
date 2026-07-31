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

export const POST_RUN_EVENTS_SHEET_NAME = "PostRunEvents";
export const POST_RUN_PARTICIPANTS_SHEET_NAME = "PostRunParticipants";
export const POST_RUN_PARTICIPANT_UPDATES_SHEET_NAME =
  "PostRunParticipantUpdates";

export const POST_RUN_DEPOSIT_STATUSES = ["Pending", "Verified"] as const;
export const POST_RUN_SETTLEMENT_STATUSES = [
  "Unpaid",
  "Fully Cleared",
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
}>;

export type PostRunEventInput = Readonly<{
  title: string;
  associatedDate: string;
  totalCostPerPersonEgp: number;
  requiredDepositPerPersonEgp: number;
  maxCapacity: number | null;
  paymentInstructions: string;
}>;

export type PostRunParticipant = Readonly<{
  id: string;
  eventId: string;
  name: string;
  whatsappPhone: string;
  depositStatus: PostRunDepositStatus;
  depositAmountPaidEgp: number;
  paymentScreenshotUrl: string | null;
  remainingBalanceEgp: number;
  settlementStatus: PostRunSettlementStatus;
  createdAt: string;
  updatedAt: string;
  createdByAdminPhone: string;
  updatedByAdminPhone: string;
}>;

export type PostRunParticipantInput = Readonly<{
  name: string;
  whatsappPhone: string;
  depositStatus?: PostRunDepositStatus;
  depositAmountPaidEgp?: number;
  paymentScreenshotUrl?: string | null;
  settlementStatus?: PostRunSettlementStatus;
}>;

export type PostRunParticipantPatch = Readonly<{
  depositStatus?: PostRunDepositStatus;
  depositAmountPaidEgp?: number;
  paymentScreenshotUrl?: string | null;
  settlementStatus?: PostRunSettlementStatus;
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
  | "createdByAdminPhone";

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
  | "updatedByAdminPhone";

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
        "whatsapp number",
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
const MAX_PAYMENT_INSTRUCTIONS_LENGTH = 2_000;
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

  return phone;
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

function computeRemainingBalance(
  totalCostPerPersonEgp: number,
  depositAmountPaidEgp: number,
  settlementStatus: PostRunSettlementStatus,
): number {
  if (
    settlementStatus === "Fully Cleared" ||
    depositAmountPaidEgp >= totalCostPerPersonEgp
  ) {
    return 0;
  }

  return (
    Math.round((totalCostPerPersonEgp - depositAmountPaidEgp) * 100) / 100
  );
}

function finalSettlementStatus(
  requestedStatus: PostRunSettlementStatus,
  remainingBalanceEgp: number,
): PostRunSettlementStatus {
  return remainingBalanceEgp === 0 ? "Fully Cleared" : requestedStatus;
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
  sheetName: string,
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
    const matchingIndices: number[] = [];

    normalizedHeaders.forEach((header, index) => {
      if (header && aliases.has(header)) {
        matchingIndices.push(index);
      }
    });

    if (matchingIndices.length > 1) {
      throw configurationError(
        `${sheetName} has duplicate columns for "${definition.header}".`,
      );
    }

    if (matchingIndices.length === 1) {
      columns[definition.key] = matchingIndices[0];
      recognizedCount += 1;
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
      (sheet) => sheet.properties?.title === sheetName,
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
  let resolved = resolveHeaderColumns(sheetName, headerRow, definitions);
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
    resolved = resolveHeaderColumns(sheetName, headerRow, definitions);
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
): unknown[] {
  const row: unknown[] = Array(
    Math.max(...Object.values(columns)) + 1,
  ).fill("");

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
  row[columns.whatsappPhone] = participant.whatsappPhone;
  row[columns.depositStatus] = participant.depositStatus;
  row[columns.depositAmountPaidEgp] = participant.depositAmountPaidEgp;
  row[columns.paymentScreenshotUrl] = participant.paymentScreenshotUrl ?? "";
  row[columns.remainingBalanceEgp] = participant.remainingBalanceEgp;
  row[columns.settlementStatus] = participant.settlementStatus;
  row[columns.createdAt] = participant.createdAt;
  row[columns.updatedAt] = participant.updatedAt;
  row[columns.createdByAdminPhone] = participant.createdByAdminPhone;
  row[columns.updatedByAdminPhone] = participant.updatedByAdminPhone;

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
  };
}

function parseParticipantRow(
  row: readonly unknown[],
  rowIndex: number,
  columns: ColumnMap<ParticipantColumn>,
  event: PostRunEvent,
): PostRunParticipant {
  const depositAmountPaidEgp = normalizeMoney(
    getCell(row, columns, "depositAmountPaidEgp"),
    "Deposit amount paid",
    "CONFIGURATION",
  );

  if (depositAmountPaidEgp > event.totalCostPerPersonEgp) {
    throw configurationError(
      `Deposit exceeds the event cost in ${POST_RUN_PARTICIPANTS_SHEET_NAME} row ${rowIndex}.`,
    );
  }

  const requestedSettlementStatus = normalizeSettlementStatus(
    getCell(row, columns, "settlementStatus"),
    "CONFIGURATION",
  );
  const remainingBalanceEgp = computeRemainingBalance(
    event.totalCostPerPersonEgp,
    depositAmountPaidEgp,
    requestedSettlementStatus,
  );
  const settlementStatus = finalSettlementStatus(
    requestedSettlementStatus,
    remainingBalanceEgp,
  );
  const storedRemainingBalance = normalizeMoney(
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
    whatsappPhone: requireCanonicalPhone(
      getCell(row, columns, "whatsappPhone"),
      "WhatsApp phone",
      "CONFIGURATION",
    ),
    depositStatus: normalizeDepositStatus(
      getCell(row, columns, "depositStatus"),
      "CONFIGURATION",
    ),
    depositAmountPaidEgp,
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
  };
}

function parseParticipantUpdateRow(
  row: readonly unknown[],
  rowIndex: number,
  columns: ColumnMap<ParticipantUpdateColumn>,
  event: PostRunEvent,
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
    "depositStatus",
    "depositAmountPaidEgp",
    "paymentScreenshotUrl",
    "settlementStatus",
  ]);
  const unknownKey = Object.keys(rawPatch).find((key) => !allowedKeys.has(key));

  if (unknownKey) {
    throw configurationError(
      `Patch JSON has unsupported field "${unknownKey}" in ${POST_RUN_PARTICIPANT_UPDATES_SHEET_NAME} row ${rowIndex}.`,
    );
  }

  const patch: {
    depositStatus?: PostRunDepositStatus;
    depositAmountPaidEgp?: number;
    paymentScreenshotUrl?: string | null;
    settlementStatus?: PostRunSettlementStatus;
  } = {};

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
    assertParticipantAmount(patch.depositAmountPaidEgp, event);
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
  const depositAmountPaidEgp =
    update.patch.depositAmountPaidEgp ?? current.depositAmountPaidEgp;
  const requestedSettlementStatus =
    update.patch.settlementStatus ?? current.settlementStatus;
  const remainingBalanceEgp = computeRemainingBalance(
    event.totalCostPerPersonEgp,
    depositAmountPaidEgp,
    requestedSettlementStatus,
  );

  return {
    ...current,
    depositStatus: update.patch.depositStatus ?? current.depositStatus,
    depositAmountPaidEgp,
    paymentScreenshotUrl:
      update.patch.paymentScreenshotUrl === undefined
        ? current.paymentScreenshotUrl
        : update.patch.paymentScreenshotUrl,
    remainingBalanceEgp,
    settlementStatus: finalSettlementStatus(
      requestedSettlementStatus,
      remainingBalanceEgp,
    ),
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
    const value = parseEventRow(row, rowIndex, columns);

    if (seenIds.has(value.id)) {
      throw configurationError(
        `Duplicate event ID "${value.id}" in ${POST_RUN_EVENTS_SHEET_NAME}.`,
      );
    }

    seenIds.add(value.id);
    parsedRows.push({ value, rowIndex, rawRow: row });
  }

  return parsedRows;
}

async function requireEvent(
  eventId: string,
  columns: ColumnMap<EventColumn>,
): Promise<PostRunEvent> {
  const normalizedEventId = requireBoundedText(
    eventId,
    "Event ID",
    MAX_ID_LENGTH,
  );
  const events = await readEventRows(columns);
  const event = events.find((candidate) => candidate.value.id === normalizedEventId);

  if (!event) {
    throw new PostRunEventsError(
      "NOT_FOUND",
      `Post-run event "${normalizedEventId}" was not found.`,
    );
  }

  return event.value;
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
    const update = parseParticipantUpdateRow(row, rowIndex, columns, event);

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

function assertParticipantAmount(
  depositAmountPaidEgp: number,
  event: PostRunEvent,
): void {
  if (depositAmountPaidEgp > event.totalCostPerPersonEgp) {
    throw validationError(
      "Deposit amount paid cannot exceed the event total cost per person.",
    );
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
): Promise<PostRunParticipant> {
  await new Promise((resolve) => setTimeout(resolve, 125));

  const rows = (
    await readParticipantRows(
      event,
      columns.participants,
      columns.participantUpdates,
    )
  ).sort(compareParticipantRows);
  const uniquePhoneRows: ParticipantRow[] = [];
  const seenPhones = new Set<string>();
  const duplicateRows: ParticipantRow[] = [];

  for (const row of rows) {
    if (seenPhones.has(row.value.whatsappPhone)) {
      duplicateRows.push(row);
      continue;
    }

    seenPhones.add(row.value.whatsappPhone);
    uniquePhoneRows.push(row);
  }

  const capacityRows =
    event.maxCapacity === null
      ? uniquePhoneRows
      : uniquePhoneRows.slice(0, event.maxCapacity);
  const capacityWinnerIds = new Set(capacityRows.map((row) => row.value.id));
  const capacityLosers = uniquePhoneRows.filter(
    (row) => !capacityWinnerIds.has(row.value.id),
  );
  const loserRows = [...duplicateRows, ...capacityLosers];

  await clearParticipantRows(loserRows.map((row) => row.rowIndex));

  const addedRow = rows.find((row) => row.value.id === participant.id);

  if (!addedRow || loserRows.some((row) => row.value.id === participant.id)) {
    const phoneWinner = uniquePhoneRows.find(
      (row) => row.value.whatsappPhone === participant.whatsappPhone,
    );

    if (phoneWinner?.value.id !== participant.id) {
      throw new PostRunEventsError(
        "CONFLICT",
        "This phone number was registered by another request first.",
      );
    }

    throw new PostRunEventsError(
      "CAPACITY_REACHED",
      `"${event.title}" reached capacity while this participant was being added.`,
    );
  }

  return addedRow.value;
}

export async function listPostRunEvents(): Promise<PostRunEvent[]> {
  const columns = await getPostRunSheetColumns();
  const rows = await readEventRows(columns.events);

  return rows
    .map((row) => row.value)
    .sort((left, right) => {
      return (
        left.associatedDate.localeCompare(right.associatedDate) ||
        left.title.localeCompare(right.title)
      );
    });
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

export async function listEventParticipants(
  eventId: string,
): Promise<PostRunParticipant[]> {
  const columns = await getPostRunSheetColumns();
  const event = await requireEvent(eventId, columns.events);
  const participants = await readParticipantRows(
    event,
    columns.participants,
    columns.participantUpdates,
  );

  return participants.map((row) => row.value);
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
    const participants = await readParticipantRows(
      event,
      columns.participants,
      columns.participantUpdates,
    );
    const name = requireBoundedText(
      input.name,
      "Participant name",
      MAX_NAME_LENGTH,
    );
    const whatsappPhone = requireCanonicalPhone(
      input.whatsappPhone,
      "WhatsApp phone",
    );

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
      participants.some(
        (participant) =>
          participant.value.whatsappPhone === whatsappPhone,
      )
    ) {
      throw new PostRunEventsError(
        "CONFLICT",
        "This phone number is already registered for the event.",
      );
    }

    const depositStatus =
      input.depositStatus === undefined
        ? "Pending"
        : normalizeDepositStatus(input.depositStatus);
    const depositAmountPaidEgp =
      input.depositAmountPaidEgp === undefined
        ? 0
        : normalizeMoney(
            input.depositAmountPaidEgp,
            "Deposit amount paid",
          );
    assertParticipantAmount(depositAmountPaidEgp, event);

    const requestedSettlementStatus =
      input.settlementStatus === undefined
        ? "Unpaid"
        : normalizeSettlementStatus(input.settlementStatus);
    const remainingBalanceEgp = computeRemainingBalance(
      event.totalCostPerPersonEgp,
      depositAmountPaidEgp,
      requestedSettlementStatus,
    );
    const settlementStatus = finalSettlementStatus(
      requestedSettlementStatus,
      remainingBalanceEgp,
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

    return reconcileParticipantAddition(event, participant, columns);
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
      "depositStatus",
      "depositAmountPaidEgp",
      "paymentScreenshotUrl",
      "settlementStatus",
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

    const normalizedPatch: {
      depositStatus?: PostRunDepositStatus;
      depositAmountPaidEgp?: number;
      paymentScreenshotUrl?: string | null;
      settlementStatus?: PostRunSettlementStatus;
    } = {};

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
      assertParticipantAmount(normalizedPatch.depositAmountPaidEgp, event);
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

    return refreshed.value;
  });
}
