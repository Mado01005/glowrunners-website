"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

type DepositStatus = "PENDING" | "VERIFIED";
type SettlementStatus = "UNPAID" | "FULLY_CLEARED";

type PostRunEvent = Readonly<{
  id: string;
  title: string;
  runDate: string;
  totalCost: number;
  depositAmount: number;
  paymentInstructions: string;
  capacity: number | null;
  createdAt: string;
  createdByAdmin?: string;
}>;

type Participant = Readonly<{
  id: string;
  eventId: string;
  fullName: string;
  phoneNumber: string;
  depositStatus: DepositStatus;
  depositPaid: number;
  paymentProofUrl: string;
  remainingBalance: number;
  settlementStatus: SettlementStatus;
  updatedByAdmin: string;
  createdAt: string;
  updatedAt: string;
}>;

type ApiObject = Record<string, unknown>;
type ViewMode = "ledger" | "settlement";

const EGP_FORMATTER = new Intl.NumberFormat("en-EG", {
  style: "currency",
  currency: "EGP",
  currencyDisplay: "narrowSymbol",
  maximumFractionDigits: 2,
});

const DATE_FORMATTER = new Intl.DateTimeFormat("en-EG", {
  dateStyle: "medium",
  timeZone: "Africa/Cairo",
});

const EMPTY_EVENT_FORM = {
  title: "",
  runDate: "",
  totalCost: "",
  depositAmount: "",
  capacity: "",
  paymentInstructions: "",
};

const EMPTY_PARTICIPANT_FORM = {
  fullName: "",
  phoneNumber: "",
};

function isObject(value: unknown): value is ApiObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readError(payload: unknown, fallback: string) {
  return isObject(payload) && typeof payload.error === "string"
    ? payload.error
    : fallback;
}

function formatMoney(value: number) {
  return EGP_FORMATTER.format(Number.isFinite(value) ? Math.max(0, value) : 0);
}

function formatEventDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : DATE_FORMATTER.format(date);
}

function whatsappPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  const withoutCountryCode = digits.replace(/^20/, "").replace(/^0+/, "");
  return withoutCountryCode ? `20${withoutCountryCode}` : "";
}

function whatsappLink(phone: string, message: string) {
  return `https://wa.me/${whatsappPhone(phone)}?text=${encodeURIComponent(message)}`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function apiRequest(
  input: string,
  init?: RequestInit,
): Promise<{ response: Response; payload: unknown }> {
  const response = await fetch(input, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
  });
  const payload = await readJson(response);

  if (response.status === 403 && typeof window !== "undefined") {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/admin/login?next=${encodeURIComponent(next)}`);
  }

  return { response, payload };
}

async function compressProofImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose an image file.");
  }

  if (file.size > 5 * 1024 * 1024) {
    throw new Error("Payment proof must be 5 MB or smaller.");
  }

  const sourceUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () =>
        reject(new Error("This image could not be opened on this device."));
      candidate.src = sourceUrl;
    });

    let maxEdge = 1800;
    let quality = 0.86;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Image processing is unavailable in this browser.");
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", quality);
      });

      if (blob && (blob.size <= 1_500_000 || attempt === 7)) {
        if (blob.size > 4_500_000) {
          throw new Error(
            "This screenshot is too large after compression. Crop it and try again.",
          );
        }

        return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, {
          type: "image/jpeg",
          lastModified: Date.now(),
        });
      }

      if (quality > 0.58) {
        quality -= 0.07;
      } else {
        maxEdge = Math.max(720, Math.round(maxEdge * 0.82));
      }
    }

    throw new Error("The payment proof could not be compressed.");
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

    const focusFirstControl = () => {
      const firstControl =
        dialog?.querySelector<HTMLElement>("[data-modal-autofocus]") ??
        dialog?.querySelector<HTMLElement>(focusableSelector) ??
        dialog;
      firstControl?.focus();
    };

    focusFirstControl();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab" || !dialog) {
        return;
      }

      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector),
      );

      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = controls[0];
      const last = controls[controls.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/85 p-3 sm:items-center"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) {
          onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="max-h-[94svh] w-full max-w-md overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-950 p-4 text-white shadow-2xl outline-none"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="min-w-0 text-lg font-black">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 shrink-0 rounded-xl border border-zinc-700 px-4 text-sm font-black"
            aria-label={`Close ${title}`}
          >
            Close
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function PostRunEventsDashboard() {
  const [events, setEvents] = useState<PostRunEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [eventForm, setEventForm] = useState(EMPTY_EVENT_FORM);
  const [participantForm, setParticipantForm] = useState(
    EMPTY_PARTICIPANT_FORM,
  );
  const [depositDrafts, setDepositDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("ledger");
  const [isEventModalOpen, setIsEventModalOpen] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const participantsRequestIdRef = useRef(0);
  const activeOperationRef = useRef(false);
  const [isLoadingEvents, setIsLoadingEvents] = useState(true);
  const [isLoadingParticipants, setIsLoadingParticipants] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "success" | "error" | "idle";
    message: string;
  }>({
    tone: "idle",
    message: "Loading post-run events…",
  });

  const selectedEvent =
    events.find((event) => event.id === selectedEventId) ?? null;
  const isAnyBusy = busyKey.length > 0;

  const loadEvents = useCallback(async () => {
    setIsLoadingEvents(true);

    try {
      const { response, payload } = await apiRequest("/api/events");

      if (
        !response.ok ||
        !isObject(payload) ||
        !Array.isArray(payload.events)
      ) {
        throw new Error(readError(payload, "Events could not be loaded."));
      }

      const nextEvents = payload.events as PostRunEvent[];
      setEvents(nextEvents);
      setSelectedEventId((current) => {
        if (nextEvents.some((event) => event.id === current)) {
          return current;
        }
        return nextEvents[0]?.id ?? "";
      });
      setNotice({
        tone: "idle",
        message:
          nextEvents.length > 0
            ? "Event ledger is ready."
            : "Create the first post-run event to begin.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Events could not be loaded.",
      });
    } finally {
      setIsLoadingEvents(false);
    }
  }, []);

  const loadParticipants = useCallback(async (eventId: string) => {
    const requestId = participantsRequestIdRef.current + 1;
    participantsRequestIdRef.current = requestId;
    setParticipants([]);
    setDepositDrafts({});

    if (!eventId) {
      setIsLoadingParticipants(false);
      return;
    }

    setIsLoadingParticipants(true);
    setNotice({
      tone: "idle",
      message: "Loading participant ledger…",
    });

    try {
      const { response, payload } = await apiRequest(
        `/api/events/${encodeURIComponent(eventId)}/participants`,
      );

      if (
        !response.ok ||
        !isObject(payload) ||
        !Array.isArray(payload.participants)
      ) {
        throw new Error(readError(payload, "Participants could not be loaded."));
      }

      const nextParticipants = payload.participants as Participant[];

      if (participantsRequestIdRef.current !== requestId) {
        return;
      }

      setParticipants(nextParticipants);
      setDepositDrafts(
        Object.fromEntries(
          nextParticipants.map((participant) => [
            participant.id,
            String(participant.depositPaid),
          ]),
        ),
      );
      setNotice({
        tone: "idle",
        message:
          nextParticipants.length > 0
            ? "Participant ledger is ready."
            : "No participants are registered for this event yet.",
      });
    } catch (error) {
      if (participantsRequestIdRef.current !== requestId) {
        return;
      }

      setParticipants([]);
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Participants could not be loaded.",
      });
    } finally {
      if (participantsRequestIdRef.current === requestId) {
        setIsLoadingParticipants(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    void loadParticipants(selectedEventId);
  }, [loadParticipants, selectedEventId]);

  const totals = useMemo(() => {
    if (!selectedEvent) {
      return { expected: 0, deposits: 0, pending: 0 };
    }

    return participants.reduce(
      (summary, participant) => ({
        expected: summary.expected + selectedEvent.totalCost,
        deposits:
          summary.deposits +
          (participant.depositStatus === "VERIFIED"
            ? participant.depositPaid
            : 0),
        pending: summary.pending + participant.remainingBalance,
      }),
      { expected: 0, deposits: 0, pending: 0 },
    );
  }, [participants, selectedEvent]);

  const visibleParticipants = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    const matching = normalizedSearch
      ? participants.filter((participant) =>
          [
            participant.fullName,
            participant.phoneNumber,
            participant.depositStatus,
            participant.settlementStatus,
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedSearch),
        )
      : participants;

    return viewMode === "settlement"
      ? [...matching].sort((left, right) => {
          if (left.settlementStatus !== right.settlementStatus) {
            return left.settlementStatus === "UNPAID" ? -1 : 1;
          }
          return left.fullName.localeCompare(right.fullName);
        })
      : matching;
  }, [participants, search, viewMode]);

  const createEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (activeOperationRef.current || isLoadingEvents) {
      return;
    }

    activeOperationRef.current = true;
    setBusyKey("create-event");

    try {
      const { response, payload } = await apiRequest("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: eventForm.title,
          runDate: eventForm.runDate,
          totalCost: Number(eventForm.totalCost),
          depositAmount: Number(eventForm.depositAmount),
          capacity: eventForm.capacity ? Number(eventForm.capacity) : null,
          paymentInstructions: eventForm.paymentInstructions,
        }),
      });

      if (!response.ok || !isObject(payload) || !isObject(payload.event)) {
        throw new Error(readError(payload, "The event could not be created."));
      }

      const created = payload.event as PostRunEvent;
      setEvents((current) => [created, ...current]);
      setParticipants([]);
      setDepositDrafts({});
      setSearch("");
      setSelectedEventId(created.id);
      setEventForm(EMPTY_EVENT_FORM);
      setIsEventModalOpen(false);
      setNotice({
        tone: "success",
        message: `${created.title} was created.`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The event could not be created.",
      });
    } finally {
      activeOperationRef.current = false;
      setBusyKey("");
    }
  };

  const addParticipant = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!selectedEvent || isLoadingParticipants) {
      return;
    }

    if (activeOperationRef.current) {
      return;
    }

    activeOperationRef.current = true;
    setBusyKey("add-participant");

    try {
      const { response, payload } = await apiRequest(
        `/api/events/${encodeURIComponent(selectedEvent.id)}/participants`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(participantForm),
        },
      );

      if (
        !response.ok ||
        !isObject(payload) ||
        !isObject(payload.participant)
      ) {
        throw new Error(
          readError(payload, "The participant could not be added."),
        );
      }

      const created = payload.participant as Participant;
      setParticipants((current) => [created, ...current]);
      setDepositDrafts((current) => ({
        ...current,
        [created.id]: String(created.depositPaid),
      }));
      setParticipantForm(EMPTY_PARTICIPANT_FORM);
      setNotice({
        tone: "success",
        message: `${created.fullName} was added to ${selectedEvent.title}.`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The participant could not be added.",
      });
    } finally {
      activeOperationRef.current = false;
      setBusyKey("");
    }
  };

  const updateParticipant = useCallback(
    async (
      participant: Participant,
      patch: Partial<
        Pick<
          Participant,
          | "depositStatus"
          | "depositPaid"
          | "paymentProofUrl"
          | "settlementStatus"
        >
      >,
      busyAction: string,
    ) => {
      if (!selectedEvent) {
        return;
      }

      if (activeOperationRef.current) {
        return;
      }

      activeOperationRef.current = true;
      const previous = participant;
      const optimistic: Participant = {
        ...participant,
        ...patch,
        remainingBalance:
          patch.settlementStatus === "FULLY_CLEARED"
            ? 0
            : Math.max(
                0,
                selectedEvent.totalCost -
                  (patch.depositPaid ?? participant.depositPaid),
              ),
        updatedAt: new Date().toISOString(),
      };

      setBusyKey(`${busyAction}:${participant.id}`);
      setParticipants((current) =>
        current.map((candidate) =>
          candidate.id === participant.id ? optimistic : candidate,
        ),
      );

      try {
        const { response, payload } = await apiRequest(
          `/api/events/${encodeURIComponent(
            selectedEvent.id,
          )}/participants/${encodeURIComponent(participant.id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          },
        );

        if (
          !response.ok ||
          !isObject(payload) ||
          !isObject(payload.participant)
        ) {
          throw new Error(
            readError(payload, "The participant could not be updated."),
          );
        }

        const updated = payload.participant as Participant;
        setParticipants((current) =>
          current.map((candidate) =>
            candidate.id === participant.id ? updated : candidate,
          ),
        );
        setDepositDrafts((current) => ({
          ...current,
          [participant.id]: String(updated.depositPaid),
        }));
        setNotice({
          tone: "success",
          message:
            updated.settlementStatus === "FULLY_CLEARED"
              ? `${updated.fullName} is fully cleared.`
              : `${updated.fullName}'s ledger was updated.`,
        });
      } catch (error) {
        setParticipants((current) =>
          current.map((candidate) =>
            candidate.id === participant.id ? previous : candidate,
          ),
        );
        setNotice({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "The participant could not be updated.",
        });
      } finally {
        activeOperationRef.current = false;
        setBusyKey("");
      }
    },
    [selectedEvent],
  );

  const uploadProof = async (
    participant: Participant,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    if (activeOperationRef.current) {
      return;
    }

    activeOperationRef.current = true;
    setBusyKey(`proof:${participant.id}`);

    try {
      const compressed = await compressProofImage(file);
      const formData = new FormData();
      formData.set("file", compressed);
      formData.set("eventId", participant.eventId);
      formData.set("participantId", participant.id);

      const { response, payload } = await apiRequest("/api/upload-proof", {
        method: "POST",
        body: formData,
      });

      if (
        !response.ok ||
        !isObject(payload) ||
        !isObject(payload.participant)
      ) {
        throw new Error(readError(payload, "Payment proof upload failed."));
      }

      const updated = payload.participant as Participant;
      setParticipants((current) =>
        current.map((candidate) =>
          candidate.id === participant.id ? updated : candidate,
        ),
      );
      setDepositDrafts((current) => ({
        ...current,
        [participant.id]: String(updated.depositPaid),
      }));
      setNotice({
        tone: "success",
        message: `${updated.fullName}'s payment proof was saved.`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Payment proof upload failed.",
      });
    } finally {
      activeOperationRef.current = false;
      setBusyKey("");
    }
  };

  const logout = async () => {
    if (activeOperationRef.current) {
      return;
    }

    activeOperationRef.current = true;
    setBusyKey("logout");

    try {
      const { response, payload } = await apiRequest("/api/auth/session", {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(readError(payload, "Sign out failed."));
      }

      window.location.assign("/admin/login");
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not sign out. Check the connection and retry.",
      });
      activeOperationRef.current = false;
      setBusyKey("");
    }
  };

  const noticeClass =
    notice.tone === "success"
      ? "border-emerald-700 bg-emerald-950/60 text-emerald-200"
      : notice.tone === "error"
        ? "border-red-800 bg-red-950/60 text-red-200"
        : "border-zinc-800 bg-zinc-950 text-zinc-300";

  return (
    <main className="flex min-h-screen w-full flex-col items-center justify-start overflow-x-hidden bg-black px-4 py-4 text-white">
      <div className="box-border flex w-full max-w-md min-w-0 flex-col gap-4">
        <header className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-fuchsia-400">
              GlowRunners Admin
            </p>
            <h1 className="mt-1 break-words text-2xl font-black leading-tight">
              Post-Run Events
            </h1>
            <p className="mt-1 text-sm font-semibold text-zinc-400">
              Deposits, proof, and Friday clearance.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            disabled={isAnyBusy}
            className="min-h-11 shrink-0 rounded-xl border border-zinc-700 px-3 text-xs font-black text-zinc-200 disabled:opacity-50"
          >
            Sign out
          </button>
        </header>

        <nav className="grid min-w-0 grid-cols-2 gap-2" aria-label="Admin areas">
          <a
            href="/admin"
            className="flex min-h-11 min-w-0 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-center text-xs font-black"
          >
            Gate Control
          </a>
          <button
            type="button"
            onClick={() => setIsEventModalOpen(true)}
            disabled={isAnyBusy || isLoadingEvents}
            className="min-h-11 min-w-0 rounded-xl bg-fuchsia-500 px-3 text-xs font-black text-white disabled:opacity-50"
          >
            + New Event
          </button>
        </nav>

        <div
          className={`min-h-12 rounded-xl border p-3 text-sm font-bold ${noticeClass}`}
          role={notice.tone === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {notice.message}
        </div>

        {isLoadingEvents ? (
          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-5 text-sm font-bold text-zinc-400">
            Loading events…
          </section>
        ) : events.length === 0 ? (
          <section className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-950 p-6 text-center">
            <h2 className="text-lg font-black">No post-run events yet</h2>
            <p className="mt-2 text-sm font-semibold text-zinc-400">
              Create Horse Riding, Kayaking, Padel, Breakfast, or any Friday
              activity.
            </p>
            <button
              type="button"
              onClick={() => setIsEventModalOpen(true)}
              disabled={isAnyBusy || isLoadingEvents}
              className="mt-4 min-h-12 w-full rounded-xl bg-white px-4 font-black text-black disabled:opacity-50"
            >
              Create first event
            </button>
          </section>
        ) : (
          <>
            <section
              className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950 p-3"
              aria-label="Choose an event"
            >
              <label
                htmlFor="event-selector"
                className="text-[11px] font-black uppercase tracking-wide text-zinc-500"
              >
                Active ledger
              </label>
              <select
                id="event-selector"
                value={selectedEventId}
                disabled={isAnyBusy}
                onChange={(event) => {
                  setSearch("");
                  setParticipants([]);
                  setDepositDrafts({});
                  setNotice({
                    tone: "idle",
                    message: "Loading participant ledger…",
                  });
                  setSelectedEventId(event.target.value);
                }}
                className="mt-2 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-black text-white outline-none focus:border-fuchsia-400 disabled:opacity-50"
              >
                {events.map((event) => (
                  <option value={event.id} key={event.id}>
                    {event.title} · {formatEventDate(event.runDate)}
                  </option>
                ))}
              </select>
            </section>

            {selectedEvent ? (
              <>
                <section className="min-w-0 rounded-2xl border border-fuchsia-900/70 bg-gradient-to-b from-fuchsia-950/60 to-zinc-950 p-4">
                  <h2 className="break-words text-xl font-black">
                    {selectedEvent.title}
                  </h2>
                  <p className="mt-1 text-sm font-bold text-fuchsia-200">
                    {formatEventDate(selectedEvent.runDate)}
                  </p>
                  <div className="mt-3 grid min-w-0 grid-cols-3 gap-2">
                    <div className="min-w-0 rounded-xl bg-black/55 p-2">
                      <p className="text-[9px] font-black uppercase tracking-wide text-zinc-500">
                        Total
                      </p>
                      <p className="mt-1 break-words text-xs font-black text-white">
                        {formatMoney(selectedEvent.totalCost)}
                      </p>
                    </div>
                    <div className="min-w-0 rounded-xl bg-black/55 p-2">
                      <p className="text-[9px] font-black uppercase tracking-wide text-zinc-500">
                        Deposit
                      </p>
                      <p className="mt-1 break-words text-xs font-black text-white">
                        {formatMoney(selectedEvent.depositAmount)}
                      </p>
                    </div>
                    <div className="min-w-0 rounded-xl bg-black/55 p-2">
                      <p className="text-[9px] font-black uppercase tracking-wide text-zinc-500">
                        Capacity
                      </p>
                      <p className="mt-1 break-words text-xs font-black text-white">
                        {participants.length}/
                        {selectedEvent.capacity ?? "∞"}
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 whitespace-pre-wrap break-words rounded-xl border border-zinc-800 bg-black/40 p-3 text-xs font-semibold text-zinc-300">
                    {selectedEvent.paymentInstructions}
                  </p>
                </section>

                <section
                  className="grid min-w-0 grid-cols-3 gap-2"
                  aria-label="Financial overview"
                >
                  {[
                    ["Expected", totals.expected, "text-white"],
                    ["Deposits", totals.deposits, "text-emerald-300"],
                    ["Balance", totals.pending, "text-amber-300"],
                  ].map(([label, value, color]) => (
                    <div
                      className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950 p-2.5"
                      key={String(label)}
                    >
                      <p className="break-words text-[9px] font-black uppercase tracking-wide text-zinc-500">
                        {String(label)}
                      </p>
                      <p
                        className={`mt-1 break-words text-xs font-black tabular-nums sm:text-sm ${String(
                          color,
                        )}`}
                      >
                        {formatMoney(Number(value))}
                      </p>
                    </div>
                  ))}
                </section>

                <form
                  onSubmit={addParticipant}
                  className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-sm font-black uppercase tracking-wide">
                        Add participant
                      </h2>
                      <p className="mt-1 text-xs font-semibold text-zinc-500">
                        Name and WhatsApp number.
                      </p>
                    </div>
                    <span className="shrink-0 text-xs font-black text-zinc-400">
                      {participants.length} joined
                    </span>
                  </div>
                  <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                    <input
                      type="text"
                      required
                      maxLength={100}
                      autoComplete="name"
                      disabled={isLoadingParticipants || isAnyBusy}
                      placeholder="Participant name"
                      value={participantForm.fullName}
                      onChange={(event) =>
                        setParticipantForm((current) => ({
                          ...current,
                          fullName: event.target.value,
                        }))
                      }
                      className="min-h-12 min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-bold outline-none focus:border-fuchsia-400 disabled:opacity-50"
                    />
                    <input
                      type="tel"
                      required
                      maxLength={24}
                      inputMode="tel"
                      autoComplete="tel"
                      disabled={isLoadingParticipants || isAnyBusy}
                      placeholder="WhatsApp phone"
                      value={participantForm.phoneNumber}
                      onChange={(event) =>
                        setParticipantForm((current) => ({
                          ...current,
                          phoneNumber: event.target.value,
                        }))
                      }
                      className="min-h-12 min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-bold outline-none focus:border-fuchsia-400 disabled:opacity-50"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={
                      isAnyBusy ||
                      isLoadingParticipants ||
                      (selectedEvent.capacity !== null &&
                        participants.length >= selectedEvent.capacity)
                    }
                    className="mt-2 min-h-12 w-full rounded-xl bg-white px-4 font-black text-black disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busyKey === "add-participant"
                      ? "Adding…"
                      : selectedEvent.capacity !== null &&
                          participants.length >= selectedEvent.capacity
                        ? "Capacity reached"
                        : "Add participant"}
                  </button>
                </form>

                <section className="min-w-0">
                  <div className="grid min-w-0 grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setViewMode("ledger")}
                      aria-pressed={viewMode === "ledger"}
                      className={`min-h-12 min-w-0 rounded-xl px-3 text-sm font-black ${
                        viewMode === "ledger"
                          ? "bg-white text-black"
                          : "border border-zinc-700 bg-zinc-950 text-zinc-300"
                      }`}
                    >
                      Full Ledger
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode("settlement")}
                      aria-pressed={viewMode === "settlement"}
                      className={`min-h-12 min-w-0 rounded-xl px-3 text-sm font-black ${
                        viewMode === "settlement"
                          ? "bg-amber-300 text-black"
                          : "border border-zinc-700 bg-zinc-950 text-zinc-300"
                      }`}
                    >
                      Friday Mode
                    </button>
                  </div>
                  <label className="sr-only" htmlFor="participant-search">
                    Search participants
                  </label>
                  <input
                    id="participant-search"
                    type="search"
                    inputMode="search"
                    enterKeyHint="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={
                      viewMode === "settlement"
                        ? "Find someone to clear…"
                        : "Search name, phone, or status…"
                    }
                    className="mt-2 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-zinc-950 px-4 text-base font-bold outline-none placeholder:text-zinc-600 focus:border-white"
                  />
                </section>

                {isLoadingParticipants ? (
                  <p className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm font-bold text-zinc-400">
                    Loading participant ledger…
                  </p>
                ) : visibleParticipants.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-zinc-700 bg-zinc-950 p-5 text-center text-sm font-bold text-zinc-400">
                    {participants.length === 0
                      ? "No participants have been added."
                      : "No participants match this search."}
                  </p>
                ) : (
                  <div className="flex min-w-0 flex-col gap-3">
                    {visibleParticipants.map((participant) => {
                      const isCleared =
                        participant.settlementStatus === "FULLY_CLEARED";
                      const isBusy = busyKey.endsWith(`:${participant.id}`);
                      const depositRequest = `Hi ${participant.fullName}! You are registered for ${selectedEvent.title} on ${formatEventDate(
                        selectedEvent.runDate,
                      )}. Total cost: ${formatMoney(
                        selectedEvent.totalCost,
                      )}. Required deposit: ${formatMoney(
                        selectedEvent.depositAmount,
                      )}. Payment instructions: ${selectedEvent.paymentInstructions}`;
                      const balanceReminder = `Hi ${participant.fullName}! Your ${formatMoney(
                        participant.depositPaid,
                      )} deposit for ${selectedEvent.title} is confirmed. Your remaining balance due on Friday is ${formatMoney(
                        participant.remainingBalance,
                      )}.`;
                      const finalReceipt = `Hi ${participant.fullName}! Your payment for ${selectedEvent.title} is fully cleared. Remaining balance: 0 EGP. Thank you from GlowRunners!`;

                      return (
                        <article
                          key={participant.id}
                          className={`min-w-0 rounded-2xl border p-4 ${
                            isCleared
                              ? "border-emerald-800 bg-emerald-950/30"
                              : viewMode === "settlement"
                                ? "border-amber-700 bg-amber-950/25"
                                : "border-zinc-800 bg-zinc-950"
                          }`}
                        >
                          <div className="flex min-w-0 items-start justify-between gap-3">
                            <div className="min-w-0">
                              <h3 className="truncate text-base font-black">
                                {participant.fullName}
                              </h3>
                              <a
                                href={`tel:+${whatsappPhone(
                                  participant.phoneNumber,
                                )}`}
                                className="mt-1 inline-flex min-h-11 max-w-full items-center truncate text-sm font-bold tabular-nums text-zinc-400"
                              >
                                +{whatsappPhone(participant.phoneNumber)}
                              </a>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              <span
                                className={`rounded-full px-2.5 py-1 text-[10px] font-black ${
                                  isCleared
                                    ? "bg-emerald-900 text-emerald-200"
                                    : "bg-amber-950 text-amber-200"
                                }`}
                              >
                                {isCleared ? "FULLY CLEARED" : "BALANCE DUE"}
                              </span>
                              <span
                                className={`rounded-full px-2.5 py-1 text-[10px] font-black ${
                                  participant.depositStatus === "VERIFIED"
                                    ? "bg-sky-950 text-sky-200"
                                    : "bg-zinc-900 text-zinc-400"
                                }`}
                              >
                                DEPOSIT {participant.depositStatus}
                              </span>
                            </div>
                          </div>

                          <div className="mt-3 grid min-w-0 grid-cols-3 gap-2">
                            <div className="min-w-0 rounded-lg bg-black/55 p-2">
                              <p className="text-[9px] font-black uppercase text-zinc-500">
                                Deposit
                              </p>
                              <p className="mt-1 break-words text-xs font-black text-emerald-300">
                                {formatMoney(participant.depositPaid)}
                              </p>
                            </div>
                            <div className="min-w-0 rounded-lg bg-black/55 p-2">
                              <p className="text-[9px] font-black uppercase text-zinc-500">
                                Remaining
                              </p>
                              <p className="mt-1 break-words text-xs font-black text-amber-300">
                                {formatMoney(participant.remainingBalance)}
                              </p>
                            </div>
                            <div className="min-w-0 rounded-lg bg-black/55 p-2">
                              <p className="text-[9px] font-black uppercase text-zinc-500">
                                Proof
                              </p>
                              <p className="mt-1 truncate text-xs font-black text-white">
                                {participant.paymentProofUrl ? "Attached" : "None"}
                              </p>
                            </div>
                          </div>

                          {viewMode === "settlement" ? (
                            <button
                              type="button"
                              disabled={isCleared || isAnyBusy}
                              onClick={() =>
                                void updateParticipant(
                                  participant,
                                  { settlementStatus: "FULLY_CLEARED" },
                                  "clear",
                                )
                              }
                              className="mt-3 min-h-14 w-full rounded-xl bg-amber-300 px-4 text-base font-black text-black disabled:bg-emerald-900 disabled:text-emerald-200"
                            >
                              {isCleared
                                ? "✓ Fully Cleared · 0 EGP"
                                : isBusy
                                  ? "Clearing…"
                                  : `Clear Remaining · ${formatMoney(
                                      participant.remainingBalance,
                                    )}`}
                            </button>
                          ) : (
                            <>
                              <div className="mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
                                <label className="min-w-0">
                                  <span className="sr-only">
                                    Deposit paid by {participant.fullName}
                                  </span>
                                  <input
                                    type="number"
                                    inputMode="decimal"
                                    min="0"
                                    max={selectedEvent.totalCost}
                                    step="0.01"
                                    disabled={isAnyBusy || isCleared}
                                    value={
                                      depositDrafts[participant.id] ??
                                      String(participant.depositPaid)
                                    }
                                    onChange={(event) =>
                                      setDepositDrafts((current) => ({
                                        ...current,
                                        [participant.id]:
                                          event.target.value,
                                      }))
                                    }
                                    className="min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-black outline-none focus:border-emerald-400 disabled:opacity-50"
                                  />
                                </label>
                                <button
                                  type="button"
                                  disabled={isAnyBusy || isCleared}
                                  onClick={() =>
                                    void updateParticipant(
                                      participant,
                                      {
                                        depositPaid: Number(
                                          depositDrafts[participant.id] ?? 0,
                                        ),
                                        depositStatus: "VERIFIED",
                                      },
                                      "deposit",
                                    )
                                  }
                                  className="min-h-12 shrink-0 rounded-xl bg-emerald-400 px-3 text-xs font-black text-black disabled:opacity-50"
                                >
                                  {participant.depositStatus === "VERIFIED"
                                    ? "Update deposit"
                                    : "Verify deposit"}
                                </button>
                              </div>
                              {participant.depositStatus === "VERIFIED" &&
                              !isCleared ? (
                                <button
                                  type="button"
                                  disabled={isAnyBusy}
                                  onClick={() =>
                                    void updateParticipant(
                                      participant,
                                      { depositStatus: "PENDING" },
                                      "deposit",
                                    )
                                  }
                                  className="mt-2 min-h-11 w-full rounded-xl border border-zinc-700 px-3 text-xs font-black text-zinc-300 disabled:opacity-50"
                                >
                                  Mark deposit pending
                                </button>
                              ) : null}

                              <div className="mt-2 grid min-w-0 grid-cols-2 gap-2">
                                <label className="flex min-h-12 min-w-0 cursor-pointer items-center justify-center rounded-xl border border-zinc-700 px-3 text-center text-xs font-black">
                                  {busyKey === `proof:${participant.id}`
                                    ? "Compressing…"
                                    : participant.paymentProofUrl
                                      ? "Replace proof"
                                      : "Upload proof"}
                                  <input
                                    type="file"
                                    accept="image/jpeg,image/png,image/webp"
                                    className="sr-only"
                                    disabled={isAnyBusy}
                                    onChange={(event) =>
                                      void uploadProof(participant, event)
                                    }
                                  />
                                </label>
                                {participant.paymentProofUrl ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setLightboxUrl(
                                        participant.paymentProofUrl,
                                      )
                                    }
                                    className="min-h-12 min-w-0 rounded-xl border border-fuchsia-700 bg-fuchsia-950/40 px-3 text-xs font-black text-fuchsia-200"
                                  >
                                    View screenshot
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    disabled
                                    className="min-h-12 min-w-0 rounded-xl border border-zinc-800 px-3 text-xs font-black text-zinc-600"
                                  >
                                    No screenshot
                                  </button>
                                )}
                              </div>
                            </>
                          )}

                          <div className="mt-3 grid min-w-0 grid-cols-3 gap-2">
                            {participant.depositStatus === "PENDING" &&
                            !isCleared ? (
                              <a
                                href={whatsappLink(
                                  participant.phoneNumber,
                                  depositRequest,
                                )}
                                target="_blank"
                                rel="noreferrer"
                                className="flex min-h-11 min-w-0 items-center justify-center rounded-xl border border-zinc-700 px-2 text-center text-[10px] font-black"
                              >
                                Deposit Request
                              </a>
                            ) : (
                              <button
                                type="button"
                                disabled
                                title={
                                  isCleared
                                    ? "The participant is fully cleared."
                                    : "The deposit has already been received."
                                }
                                className="min-h-11 min-w-0 rounded-xl border border-zinc-800 px-2 text-[10px] font-black text-zinc-600"
                              >
                                {isCleared ? "Cleared" : "Deposit Received"}
                              </button>
                            )}
                            {participant.depositStatus === "VERIFIED" &&
                            !isCleared ? (
                              <a
                                href={whatsappLink(
                                  participant.phoneNumber,
                                  balanceReminder,
                                )}
                                target="_blank"
                                rel="noreferrer"
                                className="flex min-h-11 min-w-0 items-center justify-center rounded-xl border border-zinc-700 px-2 text-center text-[10px] font-black"
                              >
                                Balance Reminder
                              </a>
                            ) : (
                              <button
                                type="button"
                                disabled
                                title={
                                  isCleared
                                    ? "The participant is fully cleared."
                                    : "Verify the deposit before sending a receipt."
                                }
                                className="min-h-11 min-w-0 rounded-xl border border-zinc-800 px-2 text-[10px] font-black text-zinc-600"
                              >
                                {isCleared ? "Cleared" : "Verify First"}
                              </button>
                            )}
                            {isCleared ? (
                              <a
                                href={whatsappLink(
                                  participant.phoneNumber,
                                  finalReceipt,
                                )}
                                target="_blank"
                                rel="noreferrer"
                                className="flex min-h-11 min-w-0 items-center justify-center rounded-xl border border-emerald-800 px-2 text-center text-[10px] font-black text-emerald-300"
                              >
                                Final Receipt
                              </a>
                            ) : (
                              <button
                                type="button"
                                disabled
                                title="Clear the remaining balance before sending a final receipt."
                                className="min-h-11 min-w-0 rounded-xl border border-zinc-800 px-2 text-[10px] font-black text-zinc-600"
                              >
                                Clear First
                              </button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </>
            ) : null}
          </>
        )}
      </div>

      {isEventModalOpen ? (
        <ModalShell
          title="Create post-run event"
          onClose={() => setIsEventModalOpen(false)}
        >
          <form onSubmit={createEvent} className="mt-4 flex flex-col gap-3">
            <label className="text-xs font-black uppercase tracking-wide text-zinc-400">
              Event title
              <input
                type="text"
                required
                maxLength={100}
                data-modal-autofocus
                value={eventForm.title}
                onChange={(event) =>
                  setEventForm((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                placeholder="Post-Run Kayaking"
                className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-bold normal-case tracking-normal text-white outline-none focus:border-fuchsia-400"
              />
            </label>
            <label className="text-xs font-black uppercase tracking-wide text-zinc-400">
              Associated date
              <input
                type="date"
                required
                value={eventForm.runDate}
                onChange={(event) =>
                  setEventForm((current) => ({
                    ...current,
                    runDate: event.target.value,
                  }))
                }
                className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-bold normal-case tracking-normal text-white outline-none focus:border-fuchsia-400"
              />
            </label>
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <label className="min-w-0 text-xs font-black uppercase tracking-wide text-zinc-400">
                Total cost
                <input
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={eventForm.totalCost}
                  onChange={(event) =>
                    setEventForm((current) => ({
                      ...current,
                      totalCost: event.target.value,
                    }))
                  }
                  className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-black normal-case tracking-normal text-white outline-none focus:border-fuchsia-400"
                />
              </label>
              <label className="min-w-0 text-xs font-black uppercase tracking-wide text-zinc-400">
                Deposit
                <input
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={eventForm.depositAmount}
                  onChange={(event) =>
                    setEventForm((current) => ({
                      ...current,
                      depositAmount: event.target.value,
                    }))
                  }
                  className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-black normal-case tracking-normal text-white outline-none focus:border-fuchsia-400"
                />
              </label>
            </div>
            <p className="rounded-xl bg-zinc-900 p-3 text-sm font-bold text-zinc-300">
              Starting balance per participant:{" "}
              <span className="text-amber-300">
                {formatMoney(
                  Math.max(
                    0,
                    Number(eventForm.totalCost || 0) -
                      Number(eventForm.depositAmount || 0),
                  ),
                )}
              </span>
            </p>
            <label className="text-xs font-black uppercase tracking-wide text-zinc-400">
              Max capacity (optional)
              <input
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={eventForm.capacity}
                onChange={(event) =>
                  setEventForm((current) => ({
                    ...current,
                    capacity: event.target.value,
                  }))
                }
                className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-black normal-case tracking-normal text-white outline-none focus:border-fuchsia-400"
              />
            </label>
            <label className="text-xs font-black uppercase tracking-wide text-zinc-400">
              Payment instructions
              <textarea
                required
                maxLength={1000}
                rows={4}
                value={eventForm.paymentInstructions}
                onChange={(event) =>
                  setEventForm((current) => ({
                    ...current,
                    paymentInstructions: event.target.value,
                  }))
                }
                placeholder="InstaPay link or Vodafone Cash number"
                className="mt-1.5 w-full min-w-0 resize-y rounded-xl border border-zinc-700 bg-black p-3 text-base font-bold normal-case tracking-normal text-white outline-none focus:border-fuchsia-400"
              />
            </label>
            <button
              type="submit"
              disabled={isAnyBusy || isLoadingEvents}
              className="min-h-14 w-full rounded-xl bg-fuchsia-500 px-4 text-base font-black text-white disabled:opacity-50"
            >
              {busyKey === "create-event" ? "Creating…" : "Create event"}
            </button>
          </form>
        </ModalShell>
      ) : null}

      {lightboxUrl ? (
        <ModalShell
          title="Payment proof screenshot"
          onClose={() => setLightboxUrl("")}
        >
          <div className="mt-3 max-h-[78svh] overflow-auto rounded-xl border border-zinc-700 bg-black p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightboxUrl}
              alt="Uploaded payment proof"
              className="h-auto w-full rounded-lg object-contain"
            />
          </div>
        </ModalShell>
      ) : null}
    </main>
  );
}
