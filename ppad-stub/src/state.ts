/**
 * In-memory store seeded from seed.json. No database — the whole point is a
 * zero-dependency stub. State is process-local and resets on restart (and via
 * reset() in tests). Mutations (revoke/restore, audit appends) live only here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AuditEvent, ProtectedFile, SeedUser } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const seedPath = join(here, "..", "seed.json");

interface Seed {
  workspace_id: string;
  org_id: string;
  users: SeedUser[];
  agents: { client_id: string; name: string; status: string }[];
  files: ProtectedFile[];
}

interface State {
  workspaceId: string;
  orgId: string;
  users: SeedUser[];
  files: Map<string, ProtectedFile>;
  events: AuditEvent[];
}

function load(): State {
  const seed: Seed = JSON.parse(readFileSync(seedPath, "utf8"));
  const files = new Map<string, ProtectedFile>();
  // structuredClone so runtime mutations never touch the on-disk seed shape.
  for (const f of seed.files) files.set(f.file_id, structuredClone(f));
  return {
    workspaceId: seed.workspace_id,
    orgId: seed.org_id,
    users: structuredClone(seed.users),
    files,
    events: [],
  };
}

let state = load();

export const reset = (): void => {
  state = load();
};

export const workspaceId = (): string => state.workspaceId;

export const getFile = (fileId: string): ProtectedFile | undefined => state.files.get(fileId);

export const getUserById = (userId: string): SeedUser | undefined =>
  state.users.find((u) => u.user_id === userId);

export const getUserByEmail = (email: string): SeedUser | undefined =>
  state.users.find((u) => u.email.toLowerCase() === email.toLowerCase());

export const getRecipient = (file: ProtectedFile, userId: string) =>
  file.recipients.find((r) => r.user_id === userId);

export const setRecipientStatus = (
  fileId: string,
  userId: string,
  status: "active" | "revoked",
  at: string,
): { ok: true } | { ok: false; reason: "file_not_found" | "recipient_not_found" } => {
  const file = state.files.get(fileId);
  if (!file) return { ok: false, reason: "file_not_found" };
  const recipient = getRecipient(file, userId);
  if (!recipient) return { ok: false, reason: "recipient_not_found" };
  recipient.status = status;
  if (status === "revoked") recipient.removed_at = at;
  else delete recipient.removed_at;
  return { ok: true };
};

export const addEvent = (event: AuditEvent): void => {
  state.events.push(event);
};

export const listEvents = (fileId: string): AuditEvent[] =>
  state.events.filter((e) => e.resource_id === fileId).slice().reverse();
