import { randomUUID } from "node:crypto";
import type { AdminIdentity } from "@/lib/adminAuth";
import {
  GOOGLE_SPREADSHEET_ID,
  columnIndexToA1,
  getSheetsClient,
  normalizeSheetHeader,
  quoteSheetName,
  withGoogleSheetsIdempotentMutationRetry,
  withGoogleSheetsRetry,
} from "@/lib/googleSheets";

const ACTIVITY_SHEET = "AdminActivityLog";
const PAYMENTS_SHEET = "GatePayments";
const EXPENSES_SHEET = "EventExpenses";
const LOCKS_SHEET = "RunnerOperationLocks";
const RUNNER_LOCK_TTL_MS = 2 * 60 * 1_000;
const READ_CACHE_TTL_MS = 5_000;
const STALE_READ_CACHE_TTL_MS = 2 * 60_000;

const sheetIdCache = new Map<string, number>();
const headerCache = new Map<string, Readonly<Record<string, number>>>();
let activityReadCache:
  | { loadedAt: number; value: AdminActivity[] }
  | undefined;
let paymentReadCache:
  | { loadedAt: number; value: GatePayment[] }
  | undefined;
let expenseReadCache:
  | { loadedAt: number; value: EventExpense[] }
  | undefined;
let lockReadCache:
  | { loadedAt: number; value: RunnerOperationLock[] }
  | undefined;

type HeaderDefinition<Key extends string> = Readonly<{
  key: Key;
  header: string;
  aliases?: readonly string[];
}>;

type ColumnMap<Key extends string> = Readonly<Record<Key, number>>;

type ActivityColumn =
  | "id"
  | "adminName"
  | "adminPhone"
  | "actionType"
  | "description"
  | "timestamp";

type PaymentColumn =
  | "id"
  | "sheetName"
  | "runnerRow"
  | "runnerName"
  | "runnerPhone"
  | "paymentMethod"
  | "amountDue"
  | "amountReceived"
  | "changeOwed"
  | "adminName"
  | "adminPhone"
  | "timestamp";

type ExpenseColumn =
  | "id"
  | "description"
  | "amount"
  | "paymentMethod"
  | "adminName"
  | "adminPhone"
  | "timestamp";

type LockColumn =
  | "id"
  | "targetLockId"
  | "operation"
  | "runnerKey"
  | "sheetName"
  | "runnerRow"
  | "runnerName"
  | "runnerPhone"
  | "adminName"
  | "adminPhone"
  | "timestamp"
  | "expiresAt";

const ACTIVITY_HEADERS: readonly HeaderDefinition<ActivityColumn>[] = [
  { key: "id", header: "Activity ID", aliases: ["ID"] },
  { key: "adminName", header: "Admin Name" },
  { key: "adminPhone", header: "Admin Phone" },
  { key: "actionType", header: "Action Type", aliases: ["Action"] },
  { key: "description", header: "Description" },
  { key: "timestamp", header: "Timestamp", aliases: ["Created At"] },
];

const PAYMENT_HEADERS: readonly HeaderDefinition<PaymentColumn>[] = [
  { key: "id", header: "Payment ID", aliases: ["Operation ID", "ID"] },
  { key: "sheetName", header: "Attendance Sheet", aliases: ["Sheet Name"] },
  { key: "runnerRow", header: "Runner Row", aliases: ["Row"] },
  { key: "runnerName", header: "Runner Name", aliases: ["Name"] },
  { key: "runnerPhone", header: "Runner Phone", aliases: ["Phone"] },
  { key: "paymentMethod", header: "Payment Method", aliases: ["Method"] },
  { key: "amountDue", header: "Amount Due EGP", aliases: ["Amount Due"] },
  {
    key: "amountReceived",
    header: "Amount Received EGP",
    aliases: ["Amount Received"],
  },
  { key: "changeOwed", header: "Change Owed EGP", aliases: ["Change Owed"] },
  { key: "adminName", header: "Admin Name" },
  { key: "adminPhone", header: "Admin Phone" },
  { key: "timestamp", header: "Timestamp", aliases: ["Created At"] },
];

const EXPENSE_HEADERS: readonly HeaderDefinition<ExpenseColumn>[] = [
  { key: "id", header: "Expense ID", aliases: ["ID"] },
  { key: "description", header: "Description" },
  { key: "amount", header: "Amount EGP", aliases: ["Amount"] },
  { key: "paymentMethod", header: "Payment Method", aliases: ["Method"] },
  { key: "adminName", header: "Admin Name" },
  { key: "adminPhone", header: "Admin Phone" },
  { key: "timestamp", header: "Timestamp", aliases: ["Created At"] },
];

const LOCK_HEADERS: readonly HeaderDefinition<LockColumn>[] = [
  { key: "id", header: "Lock Event ID", aliases: ["ID"] },
  { key: "targetLockId", header: "Target Lock ID" },
  { key: "operation", header: "Operation" },
  { key: "runnerKey", header: "Runner Key" },
  { key: "sheetName", header: "Attendance Sheet", aliases: ["Sheet Name"] },
  { key: "runnerRow", header: "Runner Row", aliases: ["Row"] },
  { key: "runnerName", header: "Runner Name", aliases: ["Name"] },
  { key: "runnerPhone", header: "Runner Phone", aliases: ["Phone"] },
  { key: "adminName", header: "Admin Name" },
  { key: "adminPhone", header: "Admin Phone" },
  { key: "timestamp", header: "Timestamp", aliases: ["Created At"] },
  { key: "expiresAt", header: "Expires At" },
];

export type AdminActivity = Readonly<{
  id: string;
  adminName: string;
  adminPhone: string;
  actionType: string;
  description: string;
  timestamp: string;
}>;

export type GatePayment = Readonly<{
  id: string;
  sheetName: string;
  runnerRow: number;
  runnerName: string;
  runnerPhone: string;
  paymentMethod: string;
  amountDueEgp: number;
  amountReceivedEgp: number;
  changeOwedEgp: number;
  adminName: string;
  adminPhone: string;
  timestamp: string;
}>;

export type EventExpense = Readonly<{
  id: string;
  description: string;
  amountEgp: number;
  paymentMethod: string;
  adminName: string;
  adminPhone: string;
  timestamp: string;
}>;

export type RunnerOperationLock = Readonly<{
  id: string;
  runnerKey: string;
  sheetName: string;
  runnerRow: number;
  runnerName: string;
  runnerPhone: string;
  adminName: string;
  adminPhone: string;
  timestamp: string;
  expiresAt: string;
}>;

function safeText(value: unknown, maxLength = 200): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function safeMoney(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function createRow<Key extends string>(
  columns: ColumnMap<Key>,
  values: Readonly<Partial<Record<Key, unknown>>>,
): unknown[] {
  const columnIndices = Object.values(columns) as number[];
  const row = Array(Math.max(...columnIndices) + 1).fill("");

  for (const [key, value] of Object.entries(values)) {
    const column = columns[key as Key];

    if (column !== undefined) {
      row[column] = value ?? "";
    }
  }

  return row;
}

async function findSheetId(sheetName: string): Promise<number | null> {
  const cached = sheetIdCache.get(sheetName);

  if (cached !== undefined) {
    return cached;
  }

  const sheets = await getSheetsClient();
  const response = await withGoogleSheetsRetry(`find ${sheetName} sheet`, () =>
    sheets.spreadsheets.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      fields: "sheets.properties(sheetId,title)",
    }),
  );
  const match = response.data.sheets?.find(
    (sheet) => sheet.properties?.title === sheetName,
  );

  if (typeof match?.properties?.sheetId === "number") {
    sheetIdCache.set(sheetName, match.properties.sheetId);
    return match.properties.sheetId;
  }

  return null;
}

async function ensureSheet(sheetName: string): Promise<number> {
  const existing = await findSheetId(sheetName);

  if (existing !== null) {
    return existing;
  }

  const sheets = await getSheetsClient();

  try {
    const response = await withGoogleSheetsRetry(`create ${sheetName} sheet`, () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        requestBody: {
          requests: [{ addSheet: { properties: { title: sheetName } } }],
        },
      }),
    );
    const created =
      response.data.replies?.[0]?.addSheet?.properties?.sheetId;

    if (typeof created === "number") {
      sheetIdCache.set(sheetName, created);
      return created;
    }
  } catch (error) {
    const concurrent = await findSheetId(sheetName);

    if (concurrent !== null) {
      return concurrent;
    }

    throw error;
  }

  const created = await findSheetId(sheetName);

  if (created === null) {
    throw new Error(`Unable to create the ${sheetName} sheet.`);
  }

  return created;
}

function resolveColumns<Key extends string>(
  headers: readonly unknown[],
  definitions: readonly HeaderDefinition<Key>[],
): Partial<Record<Key, number>> {
  const normalized = headers.map(normalizeSheetHeader);
  const result: Partial<Record<Key, number>> = {};

  for (const definition of definitions) {
    const names = [definition.header, ...(definition.aliases ?? [])].map(
      normalizeSheetHeader,
    );
    const index = normalized.findIndex((header) => names.includes(header));

    if (index >= 0) {
      result[definition.key] = index;
    }
  }

  return result;
}

async function ensureHeaders<Key extends string>(
  sheetName: string,
  definitions: readonly HeaderDefinition<Key>[],
): Promise<ColumnMap<Key>> {
  const cached = headerCache.get(sheetName);

  if (cached) {
    return cached as ColumnMap<Key>;
  }

  const sheetId = await ensureSheet(sheetName);
  const sheets = await getSheetsClient();
  const response = await withGoogleSheetsRetry(`read ${sheetName} headers`, () =>
    sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: `${quoteSheetName(sheetName)}!1:1`,
    }),
  );
  let headers = [...(response.data.values?.[0] ?? [])];
  let columns = resolveColumns(headers, definitions);
  const hasValues = headers.some((value) => normalizeSheetHeader(value));

  if (hasValues && Object.keys(columns).length === 0) {
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
    headers = [];
    columns = {};
  }

  let changed = !hasValues;

  for (const definition of definitions) {
    if (columns[definition.key] !== undefined) {
      continue;
    }

    columns[definition.key] = headers.length;
    headers.push(definition.header);
    changed = true;
  }

  if (changed) {
    const lastColumn = columnIndexToA1(headers.length - 1);
    await withGoogleSheetsRetry(`write ${sheetName} headers`, () =>
      sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(sheetName)}!A1:${lastColumn}1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] },
      }),
    );
  }

  const resolved = columns as ColumnMap<Key>;
  headerCache.set(sheetName, resolved);
  return resolved;
}

async function readRows<Key extends string>(
  sheetName: string,
  definitions: readonly HeaderDefinition<Key>[],
): Promise<{ columns: ColumnMap<Key>; rows: unknown[][] }> {
  const columns = await ensureHeaders(sheetName, definitions);
  const sheets = await getSheetsClient();
  const response = await withGoogleSheetsRetry(`read ${sheetName} rows`, () =>
    sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SPREADSHEET_ID,
      range: `${quoteSheetName(sheetName)}!A2:Z`,
    }),
  );

  return { columns, rows: response.data.values ?? [] };
}

async function appendUniqueRow<Key extends string>(
  sheetName: string,
  definitions: readonly HeaderDefinition<Key>[],
  idKey: Key,
  id: string,
  values: Readonly<Partial<Record<Key, unknown>>>,
): Promise<void> {
  const columns = await ensureHeaders(sheetName, definitions);
  const sheets = await getSheetsClient();
  const row = createRow(columns, values);
  const idColumn = columnIndexToA1(columns[idKey]);

  await withGoogleSheetsIdempotentMutationRetry(
    `append ${sheetName} ${id}`,
    () =>
      sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(sheetName)}!A:Z`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [row] },
      }),
    async () => {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SPREADSHEET_ID,
        range: `${quoteSheetName(sheetName)}!${idColumn}2:${idColumn}`,
      });

      return (response.data.values ?? []).some(
        (candidate) => safeText(candidate[0]) === id,
      );
    },
  );
}

export async function recordAdminActivity(
  admin: AdminIdentity,
  actionType: string,
  description: string,
  idempotencyKey: string = randomUUID(),
): Promise<AdminActivity> {
  const activity: AdminActivity = {
    id: safeText(idempotencyKey, 100),
    adminName: admin.displayName,
    adminPhone: admin.phoneE164,
    actionType: safeText(actionType, 60).toUpperCase(),
    description: safeText(description, 500),
    timestamp: new Date().toISOString(),
  };

  await appendUniqueRow(
    ACTIVITY_SHEET,
    ACTIVITY_HEADERS,
    "id",
    activity.id,
    activity,
  );
  activityReadCache = undefined;

  return activity;
}

export async function listAdminActivities(
  limit = 100,
): Promise<AdminActivity[]> {
  if (
    activityReadCache &&
    Date.now() - activityReadCache.loadedAt < READ_CACHE_TTL_MS
  ) {
    return activityReadCache.value.slice(
      0,
      Math.max(1, Math.min(250, limit)),
    );
  }

  const { columns, rows } = await readRows(ACTIVITY_SHEET, ACTIVITY_HEADERS);
  const activities = rows
    .map((row): AdminActivity | null => {
      const id = safeText(row[columns.id], 100);

      return id
        ? {
            id,
            adminName: safeText(row[columns.adminName], 100),
            adminPhone: safeText(row[columns.adminPhone], 30),
            actionType: safeText(row[columns.actionType], 60),
            description: safeText(row[columns.description], 500),
            timestamp: safeText(row[columns.timestamp], 40),
          }
        : null;
    })
    .filter((entry): entry is AdminActivity => entry !== null)
    .sort(
      (left, right) =>
        Date.parse(right.timestamp) - Date.parse(left.timestamp),
    );
  activityReadCache = { loadedAt: Date.now(), value: activities };

  return activities.slice(0, Math.max(1, Math.min(250, limit)));
}

export async function recordGatePayment(
  input: Omit<GatePayment, "adminName" | "adminPhone" | "timestamp">,
  admin: AdminIdentity,
): Promise<GatePayment> {
  const payment: GatePayment = {
    ...input,
    id: safeText(input.id, 100),
    sheetName: safeText(input.sheetName, 120),
    runnerName: safeText(input.runnerName, 100),
    runnerPhone: safeText(input.runnerPhone, 30),
    paymentMethod: safeText(input.paymentMethod, 40),
    runnerRow: Math.max(1, Math.trunc(input.runnerRow)),
    amountDueEgp: safeMoney(input.amountDueEgp),
    amountReceivedEgp: safeMoney(input.amountReceivedEgp),
    changeOwedEgp: safeMoney(input.changeOwedEgp),
    adminName: admin.displayName,
    adminPhone: admin.phoneE164,
    timestamp: new Date().toISOString(),
  };

  await appendUniqueRow(PAYMENTS_SHEET, PAYMENT_HEADERS, "id", payment.id, {
    id: payment.id,
    sheetName: payment.sheetName,
    runnerRow: payment.runnerRow,
    runnerName: payment.runnerName,
    runnerPhone: payment.runnerPhone,
    paymentMethod: payment.paymentMethod,
    amountDue: payment.amountDueEgp,
    amountReceived: payment.amountReceivedEgp,
    changeOwed: payment.changeOwedEgp,
    adminName: payment.adminName,
    adminPhone: payment.adminPhone,
    timestamp: payment.timestamp,
  });
  paymentReadCache = undefined;

  return payment;
}

export async function listGatePayments(
  sheetName?: string,
): Promise<GatePayment[]> {
  const normalizedSheet = normalizeSheetHeader(sheetName ?? "");
  let payments: GatePayment[];

  if (
    paymentReadCache &&
    Date.now() - paymentReadCache.loadedAt < READ_CACHE_TTL_MS
  ) {
    payments = paymentReadCache.value;
  } else {
    const { columns, rows } = await readRows(PAYMENTS_SHEET, PAYMENT_HEADERS);
    payments = rows
      .map((row): GatePayment | null => {
      const id = safeText(row[columns.id], 100);
      const rowSheet = safeText(row[columns.sheetName], 120);

      if (!id) {
        return null;
      }

      return {
        id,
        sheetName: rowSheet,
        runnerRow: Math.max(1, Math.trunc(safeMoney(row[columns.runnerRow]))),
        runnerName: safeText(row[columns.runnerName], 100),
        runnerPhone: safeText(row[columns.runnerPhone], 30),
        paymentMethod: safeText(row[columns.paymentMethod], 40),
        amountDueEgp: safeMoney(row[columns.amountDue]),
        amountReceivedEgp: safeMoney(row[columns.amountReceived]),
        changeOwedEgp: safeMoney(row[columns.changeOwed]),
        adminName: safeText(row[columns.adminName], 100),
        adminPhone: safeText(row[columns.adminPhone], 30),
        timestamp: safeText(row[columns.timestamp], 40),
      };
      })
      .filter((entry): entry is GatePayment => entry !== null);
    paymentReadCache = { loadedAt: Date.now(), value: payments };
  }

  return normalizedSheet
    ? payments.filter(
        (payment) =>
          normalizeSheetHeader(payment.sheetName) === normalizedSheet,
      )
    : payments;
}

export async function createEventExpense(
  description: string,
  amountEgp: number,
  paymentMethod: string,
  admin: AdminIdentity,
  id: string = randomUUID(),
): Promise<EventExpense> {
  const expense: EventExpense = {
    id: safeText(id, 100),
    description: safeText(description, 240),
    amountEgp: safeMoney(amountEgp),
    paymentMethod: safeText(paymentMethod, 40) || "Cash",
    adminName: admin.displayName,
    adminPhone: admin.phoneE164,
    timestamp: new Date().toISOString(),
  };

  await appendUniqueRow(EXPENSES_SHEET, EXPENSE_HEADERS, "id", expense.id, {
    id: expense.id,
    description: expense.description,
    amount: expense.amountEgp,
    paymentMethod: expense.paymentMethod,
    adminName: expense.adminName,
    adminPhone: expense.adminPhone,
    timestamp: expense.timestamp,
  });
  expenseReadCache = undefined;

  return expense;
}

export async function listEventExpenses(): Promise<EventExpense[]> {
  if (
    expenseReadCache &&
    Date.now() - expenseReadCache.loadedAt < READ_CACHE_TTL_MS
  ) {
    return expenseReadCache.value;
  }

  const { columns, rows } = await readRows(EXPENSES_SHEET, EXPENSE_HEADERS);

  const expenses = rows
    .map((row): EventExpense | null => {
      const id = safeText(row[columns.id], 100);

      return id
        ? {
            id,
            description: safeText(row[columns.description], 240),
            amountEgp: safeMoney(row[columns.amount]),
            paymentMethod: safeText(row[columns.paymentMethod], 40),
            adminName: safeText(row[columns.adminName], 100),
            adminPhone: safeText(row[columns.adminPhone], 30),
            timestamp: safeText(row[columns.timestamp], 40),
          }
        : null;
    })
    .filter((entry): entry is EventExpense => entry !== null)
    .sort(
      (left, right) =>
        Date.parse(right.timestamp) - Date.parse(left.timestamp),
    );
  expenseReadCache = { loadedAt: Date.now(), value: expenses };
  return expenses;
}

function parseActiveLocks(
  rows: readonly unknown[][],
  columns: ColumnMap<LockColumn>,
): RunnerOperationLock[] {
  const active = new Map<string, RunnerOperationLock>();
  const now = Date.now();

  for (const row of rows) {
    const operation = safeText(row[columns.operation], 20).toUpperCase();
    const targetLockId = safeText(row[columns.targetLockId], 100);

    if (operation === "RELEASE") {
      for (const [runnerKey, lock] of active) {
        if (lock.id === targetLockId) {
          active.delete(runnerKey);
          break;
        }
      }
      continue;
    }

    if (operation !== "ACQUIRE") {
      continue;
    }

    const id = safeText(row[columns.id], 100);
    const runnerKey = safeText(row[columns.runnerKey], 180);
    const expiresAt = safeText(row[columns.expiresAt], 40);
    const existing = active.get(runnerKey);

    if (!id || !runnerKey || Date.parse(expiresAt) <= now) {
      continue;
    }

    if (existing && Date.parse(existing.expiresAt) > now) {
      continue;
    }

    active.set(runnerKey, {
      id,
      runnerKey,
      sheetName: safeText(row[columns.sheetName], 120),
      runnerRow: Math.max(1, Math.trunc(safeMoney(row[columns.runnerRow]))),
      runnerName: safeText(row[columns.runnerName], 100),
      runnerPhone: safeText(row[columns.runnerPhone], 30),
      adminName: safeText(row[columns.adminName], 100),
      adminPhone: safeText(row[columns.adminPhone], 30),
      timestamp: safeText(row[columns.timestamp], 40),
      expiresAt,
    });
  }

  return [...active.values()];
}

export async function listActiveRunnerLocks(): Promise<RunnerOperationLock[]> {
  if (
    lockReadCache &&
    Date.now() - lockReadCache.loadedAt < READ_CACHE_TTL_MS
  ) {
    return lockReadCache.value;
  }

  try {
    const { columns, rows } = await readRows(LOCKS_SHEET, LOCK_HEADERS);
    const locks = parseActiveLocks(rows, columns);
    lockReadCache = { loadedAt: Date.now(), value: locks };
    return locks;
  } catch (error) {
    if (
      lockReadCache &&
      Date.now() - lockReadCache.loadedAt < STALE_READ_CACHE_TTL_MS
    ) {
      return lockReadCache.value.filter(
        (lock) => Date.parse(lock.expiresAt) > Date.now(),
      );
    }

    throw error;
  }
}

export async function acquireRunnerLock(
  input: Readonly<{
    sheetName: string;
    runnerRow: number;
    runnerName: string;
    runnerPhone: string;
  }>,
  admin: AdminIdentity,
): Promise<{
  acquired: boolean;
  lock: RunnerOperationLock;
}> {
  const timestamp = new Date();
  const runnerKey = `${normalizeSheetHeader(input.sheetName)}:${
    safeText(input.runnerPhone, 30) ||
    Math.max(1, Math.trunc(input.runnerRow))
  }`;
  const lock: RunnerOperationLock = {
    id: randomUUID(),
    runnerKey,
    sheetName: safeText(input.sheetName, 120),
    runnerRow: Math.max(1, Math.trunc(input.runnerRow)),
    runnerName: safeText(input.runnerName, 100),
    runnerPhone: safeText(input.runnerPhone, 30),
    adminName: admin.displayName,
    adminPhone: admin.phoneE164,
    timestamp: timestamp.toISOString(),
    expiresAt: new Date(timestamp.getTime() + RUNNER_LOCK_TTL_MS).toISOString(),
  };

  await appendUniqueRow(LOCKS_SHEET, LOCK_HEADERS, "id", lock.id, {
    id: lock.id,
    targetLockId: "",
    operation: "ACQUIRE",
    runnerKey: lock.runnerKey,
    sheetName: lock.sheetName,
    runnerRow: lock.runnerRow,
    runnerName: lock.runnerName,
    runnerPhone: lock.runnerPhone,
    adminName: lock.adminName,
    adminPhone: lock.adminPhone,
    timestamp: lock.timestamp,
    expiresAt: lock.expiresAt,
  });
  lockReadCache = undefined;

  const winner =
    (await listActiveRunnerLocks()).find(
      (candidate) => candidate.runnerKey === runnerKey,
    ) ?? lock;

  return { acquired: winner.id === lock.id, lock: winner };
}

export async function releaseRunnerLock(
  lockId: string,
  admin: AdminIdentity,
): Promise<void> {
  const id = randomUUID();

  await appendUniqueRow(LOCKS_SHEET, LOCK_HEADERS, "id", id, {
    id,
    targetLockId: safeText(lockId, 100),
    operation: "RELEASE",
    adminName: admin.displayName,
    adminPhone: admin.phoneE164,
    timestamp: new Date().toISOString(),
  });
  lockReadCache = undefined;
}
