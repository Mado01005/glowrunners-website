import Link from "next/link";
import {
  findRunnerByPhone,
  getActiveAttendanceSheetName,
  normalizeEgyptianMobilePhone,
  resolveActiveAttendanceSheetName,
  type RunnerLookupResult,
} from "@/lib/googleSheets";
import { TicketQr } from "./TicketQr";

type TicketPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

type TicketErrorProps = {
  title: string;
  message: string;
  actionHref?: string;
  actionLabel?: string;
};

function TicketError({
  title,
  message,
  actionHref = "/#ticket-hub-heading",
  actionLabel = "Return to Ticket Hub",
}: TicketErrorProps) {
  return (
    <main className="ticket-shell">
      <section
        className="ticket-card ticket-error"
        aria-labelledby="ticket-error-title"
        role="alert"
      >
        <p className="ticket-brand">GlowRunners</p>
        <h1 id="ticket-error-title">{title}</h1>
        <p>{message}</p>
        <Link
          href={actionHref}
          className="mt-6 inline-flex min-h-12 items-center justify-center rounded-lg bg-white px-5 py-3 text-sm font-black text-black"
        >
          {actionLabel}
        </Link>
      </section>
    </main>
  );
}

export default async function TicketPage({ searchParams }: TicketPageProps) {
  const params = await searchParams;
  const phone = firstParam(params?.phone)?.trim();
  const normalizedPhone = phone ? normalizeEgyptianMobilePhone(phone) : null;
  let sheetName = getActiveAttendanceSheetName();

  if (!phone) {
    return (
      <TicketError
        title="Missing ticket phone"
        message="Enter the WhatsApp number used during registration to find your ticket."
      />
    );
  }

  if (!normalizedPhone) {
    return (
      <TicketError
        title="Invalid ticket phone"
        message="Enter a valid Egyptian mobile number beginning with 010, 011, 012, or 015."
      />
    );
  }

  let runner: RunnerLookupResult | null = null;

  try {
    sheetName = (await resolveActiveAttendanceSheetName()).sheetName;
    runner = await findRunnerByPhone(sheetName, normalizedPhone);
  } catch {
    return (
      <TicketError
        title="Ticket system warming up"
        message="We could not connect to the attendance sheet. Check your connection and try again."
        actionHref={`/ticket?phone=${encodeURIComponent(normalizedPhone)}`}
        actionLabel="Try again"
      />
    );
  }

  if (!runner) {
    return (
      <TicketError
        title="Ticket not found"
        message={`No runner was found for this phone number in "${sheetName}".`}
      />
    );
  }

  return (
    <main className="ticket-shell">
      <section className="ticket-card" aria-label="GlowRunners QR ticket">
        <p className="ticket-brand">GlowRunners Sunrise Pass</p>
        <h1 className="ticket-name">{runner.fullName}</h1>
        <p className="ticket-meta">{sheetName}</p>

        <div className="qr-frame">
          <TicketQr value={normalizedPhone} />
        </div>

        <p className="ticket-subtitle">
          Screenshot this ticket for check-in! 🌅
        </p>
        <div className="mt-4 rounded-lg border border-white/15 bg-black/30 p-3">
          <p className="text-[11px] font-black uppercase tracking-widest text-zinc-400">
            Manual check-in code
          </p>
          <p className="mt-1 break-all font-mono text-base font-black tracking-wider text-white">
            {normalizedPhone}
          </p>
          <p className="mt-1 text-xs font-semibold leading-5 text-zinc-400">
            Show this code to gate staff if the camera cannot scan the QR.
          </p>
        </div>
      </section>
    </main>
  );
}
