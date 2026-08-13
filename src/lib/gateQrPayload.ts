export type QrMatchableRunner = Readonly<{
  rowIndex: number;
  name: string;
  phone: string;
  participantId?: string;
}>;

function normalizeLookupValue(value: string): string {
  return value.trim().replace(/^'/, "").toLocaleLowerCase("en-US");
}

function normalizePhoneDigits(value: string): string {
  let digits = value.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.startsWith("20")) digits = digits.slice(2).replace(/^0+/, "");
  return digits;
}

export function qrPayloadCandidates(decodedText: string): string[] {
  const raw = decodedText.trim();
  const candidates = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" || typeof value === "number") {
      const normalized = String(value).trim();
      if (normalized) candidates.add(normalized);
    }
  };

  add(raw);

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const object = parsed as Record<string, unknown>;
      for (const key of [
        "id",
        "participantId",
        "phone",
        "contact",
        "username",
        "handle",
        "name",
      ]) {
        add(object[key]);
      }
    }
  } catch {
    // Non-JSON tickets continue through URL and raw-text parsing.
  }

  try {
    const url = new URL(raw);
    for (const key of [
      "id",
      "participantId",
      "phone",
      "contact",
      "username",
      "handle",
      "ticket",
    ]) {
      add(url.searchParams.get(key));
    }
    for (const segment of url.pathname.split("/").filter(Boolean)) {
      add(decodeURIComponent(segment));
    }
  } catch {
    // Raw phone, handle, ID, and name payloads remain valid candidates.
  }

  return [...candidates];
}

export function findRunnerFromQrPayload<T extends QrMatchableRunner>(
  roster: readonly T[],
  payload: string,
): T | undefined {
  const candidates = qrPayloadCandidates(payload);
  const exactMatch = roster.find((runner) => {
    const identifiers = [
      runner.participantId ?? "",
      runner.phone,
      runner.name,
      String(runner.rowIndex),
    ];

    return candidates.some((candidate) => {
      const lookup = normalizeLookupValue(candidate);
      const lookupPhone = normalizePhoneDigits(candidate);
      return identifiers.some((identifier) => {
        const normalizedIdentifier = normalizeLookupValue(identifier);
        const identifierPhone = normalizePhoneDigits(identifier);
        return (
          normalizedIdentifier === lookup ||
          (lookupPhone.length > 0 && identifierPhone === lookupPhone)
        );
      });
    });
  });

  if (exactMatch) return exactMatch;

  const rawLookup = normalizeLookupValue(payload);
  if (!rawLookup || rawLookup.length < 2) return undefined;
  const partialMatches = roster.filter((runner) =>
    [runner.name, runner.phone, runner.participantId ?? ""].some((value) =>
      normalizeLookupValue(value).includes(rawLookup),
    ),
  );
  return partialMatches.length === 1 ? partialMatches[0] : undefined;
}
