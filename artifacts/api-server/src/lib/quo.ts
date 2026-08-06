/**
 * Thin client for the Quo (formerly OpenPhone) public API.
 *
 * Auth is a workspace-scoped API key sent in the Authorization header
 * (no "Bearer " prefix — Quo expects the raw key).
 */
const QUO_BASE_URL = "https://api.quo.com/v1";

export class QuoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "QuoError";
  }
}

/**
 * Every call is made with a specific company's workspace key. There is no
 * shared fallback: a company that has not connected Quo simply cannot make
 * Quo calls, which keeps one tenant's key from ever serving another's request.
 */
async function quoRequest<T>(
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!apiKey) {
    throw new QuoError("This company has not connected a Quo account", 503);
  }
  const res = await fetch(`${QUO_BASE_URL}${path}`, {
    ...init,
    headers: {
      // Quo expects the raw key, not a Bearer token.
      Authorization: apiKey,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new QuoError(
      `Quo API ${init.method ?? "GET"} ${path} failed (${res.status}): ${body.slice(0, 300)}`,
      res.status,
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// --- Types -----------------------------------------------------------------

export type QuoPhoneNumber = {
  id: string;
  name: string | null;
  number: string;
};

export type QuoCall = {
  id: string;
  phoneNumberId: string;
  direction: "incoming" | "outgoing";
  status: string;
  participants: string[];
  createdAt: string;
  answeredAt?: string | null;
  completedAt?: string | null;
  duration?: number | null;
  userId?: string | null;
};

export type QuoTranscriptDialogue = {
  content: string;
  start: number;
  end: number;
  identifier: string | null;
  userId?: string | null;
};

export type QuoTranscript = {
  callId: string;
  createdAt: string;
  dialogue: QuoTranscriptDialogue[];
  duration: number;
  status: string;
};

export type QuoSummary = {
  callId: string;
  summary?: string[] | string | null;
  nextSteps?: string[] | null;
  status?: string;
};

export type QuoWebhookRecord = {
  id: string;
  key: string;
  url: string;
  events: string[];
  status: string;
  resourceIds: string[];
  label?: string | null;
};

// --- Endpoints -------------------------------------------------------------

export async function listPhoneNumbers(
  apiKey: string,
): Promise<QuoPhoneNumber[]> {
  const res = await quoRequest<{ data: QuoPhoneNumber[] }>(
    apiKey,
    "/phone-numbers",
  );
  return res.data ?? [];
}

export async function getCall(
  apiKey: string,
  callId: string,
): Promise<QuoCall | null> {
  try {
    const res = await quoRequest<{ data: QuoCall }>(apiKey, `/calls/${callId}`);
    return res.data ?? null;
  } catch (err) {
    if (err instanceof QuoError && err.status === 404) return null;
    throw err;
  }
}

export async function getTranscript(
  apiKey: string,
  callId: string,
): Promise<QuoTranscript | null> {
  try {
    const res = await quoRequest<{ data: QuoTranscript }>(
      apiKey,
      `/call-transcripts/${callId}`,
    );
    return res.data ?? null;
  } catch (err) {
    if (err instanceof QuoError && err.status === 404) return null;
    throw err;
  }
}

export async function getSummary(
  apiKey: string,
  callId: string,
): Promise<QuoSummary | null> {
  try {
    const res = await quoRequest<{ data: QuoSummary }>(
      apiKey,
      `/call-summaries/${callId}`,
    );
    return res.data ?? null;
  } catch (err) {
    if (err instanceof QuoError && err.status === 404) return null;
    throw err;
  }
}

export async function listConversations(
  apiKey: string,
  phoneNumberIds: string[],
  maxResults = 50,
): Promise<
  Array<{
    id: string;
    phoneNumberId: string;
    participants: string[];
    lastActivityAt: string | null;
  }>
> {
  const params = new URLSearchParams();
  params.set("maxResults", String(maxResults));
  for (const id of phoneNumberIds) params.append("phoneNumbers", id);
  const res = await quoRequest<{
    data: Array<{
      id: string;
      phoneNumberId: string;
      participants: string[];
      lastActivityAt: string | null;
    }>;
  }>(apiKey, `/conversations?${params.toString()}`);
  return res.data ?? [];
}

/**
 * Quo's call list requires both a Quo number and the other participant, so
 * calls are enumerated per conversation.
 */
export async function listCallsWithParticipant(
  apiKey: string,
  phoneNumberId: string,
  participant: string,
  maxResults = 10,
): Promise<QuoCall[]> {
  const params = new URLSearchParams({
    phoneNumberId,
    participants: participant,
    maxResults: String(maxResults),
  });
  const res = await quoRequest<{ data: QuoCall[] }>(
    apiKey,
    `/calls?${params.toString()}`,
  );
  return res.data ?? [];
}

export async function listWebhooks(
  apiKey: string,
): Promise<QuoWebhookRecord[]> {
  const res = await quoRequest<{ data: QuoWebhookRecord[] }>(
    apiKey,
    "/webhooks",
  );
  return res.data ?? [];
}

export async function createCallWebhook(
  apiKey: string,
  url: string,
  resourceIds: string[],
  label: string,
): Promise<QuoWebhookRecord> {
  const res = await quoRequest<{ data: QuoWebhookRecord }>(
    apiKey,
    "/webhooks/calls",
    {
      method: "POST",
      body: JSON.stringify({
        url,
        label,
        resourceIds,
        status: "enabled",
        events: ["call.ringing", "call.completed", "call.recording.completed"],
      }),
    },
  );
  return res.data;
}

export async function createTranscriptWebhook(
  apiKey: string,
  url: string,
  resourceIds: string[],
  label: string,
): Promise<QuoWebhookRecord> {
  const res = await quoRequest<{ data: QuoWebhookRecord }>(
    apiKey,
    "/webhooks/call-transcripts",
    {
      method: "POST",
      body: JSON.stringify({
        url,
        label,
        resourceIds,
        status: "enabled",
        events: ["call.transcript.completed"],
      }),
    },
  );
  return res.data;
}

export async function createSummaryWebhook(
  apiKey: string,
  url: string,
  resourceIds: string[],
  label: string,
): Promise<QuoWebhookRecord> {
  const res = await quoRequest<{ data: QuoWebhookRecord }>(
    apiKey,
    "/webhooks/call-summaries",
    {
      method: "POST",
      body: JSON.stringify({
        url,
        label,
        resourceIds,
        status: "enabled",
        events: ["call.summary.completed"],
      }),
    },
  );
  return res.data;
}

/**
 * Quo only accepts E.164 (`^\+[1-9]\d{1,14}$`). Numbers captured from calls
 * already arrive that way, but hand-typed ones do not — returns null when the
 * input cannot be read as a phone number rather than guessing.
 */
export function toE164(raw: string, defaultCountryCode = "1"): string | null {
  const trimmed = raw.trim();
  if (/^\+[1-9]\d{1,14}$/.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/\D/g, "");
  const candidate =
    digits.length === 10
      ? `+${defaultCountryCode}${digits}`
      : digits.length === 11 && digits.startsWith("1")
        ? `+${digits}`
        : digits.length >= 8 && digits.length <= 15
          ? `+${digits}`
          : null;
  // The assembled candidate must itself be valid E.164 — a leading zero
  // (e.g. "00000000" → "+00000000") is not a dialable country code.
  return candidate && /^\+[1-9]\d{1,14}$/.test(candidate) ? candidate : null;
}

export type QuoSentMessage = {
  id: string;
  status: string;
  to: string[];
  from: string;
  createdAt: string;
};

/**
 * Sends an SMS from one of the workspace's own numbers.
 *
 * `from` must be a number that belongs to this workspace in E.164 form — Quo
 * rejects anything else, which also means a company can only ever text from a
 * line they actually own.
 */
export async function sendMessage(
  apiKey: string,
  input: { from: string; to: string; content: string },
): Promise<QuoSentMessage> {
  const res = await quoRequest<{ data: QuoSentMessage }>(apiKey, "/messages", {
    method: "POST",
    body: JSON.stringify({
      from: input.from,
      to: [input.to],
      content: input.content,
    }),
  });
  return res.data;
}

export async function deleteWebhook(apiKey: string, id: string): Promise<void> {
  try {
    await quoRequest<void>(apiKey, `/webhooks/${id}`, { method: "DELETE" });
  } catch (err) {
    // A webhook already removed on Quo's side is not an error for us.
    if (err instanceof QuoError && err.status === 404) return;
    throw err;
  }
}
