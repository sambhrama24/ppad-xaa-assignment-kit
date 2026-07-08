/** Builds audit events that attribute a read to BOTH the agent and the principal. */
import { randomUUID } from "node:crypto";
import type { AuditEvent, ReadRequest } from "./types";

interface BuildArgs {
  type: AuditEvent["event_type"];
  fileId: string;
  workspaceId: string;
  body: ReadRequest;
  decision: "granted" | "denied";
  denyReason?: string;
  resolvedUserId: string | null;
}

export function buildEvent(args: BuildArgs): AuditEvent {
  const now = new Date().toISOString();
  const { body } = args;
  return {
    event_id: `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    event_type: args.type,
    event_version: "1.0",
    occurred_time: now,
    created_time: now,
    workspace_id: args.workspaceId,
    resource_type: "file",
    resource_id: args.fileId,
    // Single actor field == the human principal.
    user_id: args.resolvedUserId,
    correlation_id: body.assertion?.jti ?? null,
    event_payload: {
      decision: args.decision,
      ...(args.denyReason ? { deny_reason: args.denyReason } : {}),
      // Agent attribution has nowhere else to go but the payload.
      actor: {
        agent_client_id: body.agent?.client_id ?? null,
        agent_name: body.agent?.name ?? null,
      },
      on_behalf_of: {
        user_id: body.principal?.user_id ?? null,
        email: body.principal?.email ?? null,
      },
      assertion: {
        iss: body.assertion?.iss ?? null,
        jti: body.assertion?.jti ?? null,
      },
      reason: body.reason ?? null,
    },
  };
}
