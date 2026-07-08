/** Shapes shared across the stub. Field names mirror PPAD where practical. */

export type SharingMode = "explicit" | "public";
export type FileStatus = "pending" | "active" | "revoked" | "deleted";
export type RecipientStatus = "active" | "revoked";

export interface Recipient {
  user_id: string;
  email: string;
  status: RecipientStatus;
  addition_method: string;
  added_at: string;
  added_by: string;
  removed_at?: string;
}

export interface ProtectedFile {
  file_id: string;
  name: string;
  owner_user_id: string;
  sharing_mode: SharingMode;
  file_status: FileStatus;
  recipients: Recipient[];
}

export interface SeedUser {
  user_id: string;
  idp_sub: string;
  email: string;
  name: string;
  status: string;
}

/**
 * Audit event. The model exposes a SINGLE actor field (`user_id`) plus a JSON
 * `event_payload`. Because there is only one actor column, agent attribution has
 * to live inside `event_payload` — that modelling choice is part of what the
 * assignment is testing.
 */
export interface AuditEvent {
  event_id: string;
  event_type: "read_granted" | "read_denied";
  event_version: string;
  occurred_time: string;
  created_time: string;
  workspace_id: string;
  resource_type: "file";
  resource_id: string;
  /** The human principal — the single actor field. May be null if unresolved. */
  user_id: string | null;
  /** Correlation id for the read (we map the assertion jti here). */
  correlation_id: string | null;
  event_payload: Record<string, unknown>;
}

/** Body the candidate's service POSTs to the governed read endpoint. */
export interface ReadRequest {
  principal?: { user_id?: string; email?: string };
  agent?: { client_id?: string; name?: string };
  assertion?: { iss?: string; jti?: string };
  reason?: string;
}
