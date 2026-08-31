const ACK_EVENT = "book-my-cleaning:website-lead-alert-ack";

function storageKey(companyId: number | string): string {
  return `website-lead-alert-ack:${companyId}`;
}

export function websiteLeadAckStorageKey(companyId: number | string): string {
  return storageKey(companyId);
}

function readIds(companyId: number | string): Set<number> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey(companyId));
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(ids)
        ? ids.filter((id): id is number => Number.isInteger(id))
        : [],
    );
  } catch {
    return new Set();
  }
}

function writeIds(companyId: number | string, ids: Set<number>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey(companyId), JSON.stringify([...ids]));
  window.dispatchEvent(new CustomEvent(ACK_EVENT));
}

export function acknowledgedWebsiteLeadIds(
  companyId: number | string,
): Set<number> {
  return readIds(companyId);
}

export function acknowledgeWebsiteLeads(
  companyId: number | string,
  leadIds: Iterable<number>,
): void {
  const ids = readIds(companyId);
  for (const id of leadIds) ids.add(id);
  writeIds(companyId, ids);
}

export function websiteLeadAckEvent(): string {
  return ACK_EVENT;
}
