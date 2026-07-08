# Design note — Agent identity for PPAD via Cross App Access

PPAD protects files with a per-file **allow list of human recipients**, keyed on a
`user_id`; a "read" is the issuance of a decryption license, granted only if the
recipient is currently allowed. AI agents now open files *on behalf of* users, and
the delegation arrives as an **ID-JAG assertion** (the IETF draft under Okta's Cross
App Access): a signed, short-lived JWT bound to one app, identifying the acting
agent by its OAuth **`client_id`**.

**The core mismatch:** the allow list is keyed on a human `user_id`; the assertion's
agent is a `client_id` with no home in that model. This note records the design
decisions that close that gap, and their trade-offs.

---

## 1. Composition: where the agent lives

Two clean options exist. **Inheritance** — the agent rides entirely on its human's
access; `client_id` appears only in audit. **Independent policy** — a separate
allow list keyed on `client_id`.

This gateway layers both:

- **Floor (inheritance, enforced by PPAD):** the human principal must be *currently*
  allowed, checked server-side at license issuance. An agent can therefore never
  exceed its principal — a property enforced by the resource, not by this layer.
- **Overlay (a thin `client_id` allow list):** an agent not on the approved list is
  denied even when its human is allowed. This is the only place `client_id`
  participates in the *decision* rather than just the record.

Why not inheritance alone? "Any agent the user happens to be driving may read
everything the user can read" is exactly the posture enterprise security teams
object to; the overlay gives them a governed answer to "which agents may act at
all." Why not a per-file agent allow list? It doubles the sharing surface owners
must manage and invites granting an agent *more* than its principal. The overlay is
deliberately coarse (workspace-level) and **strictly subtractive** — it can only
narrow inherited access.

**Subject resolution.** The assertion carries three identifiers for the human:
`sub` (IdP namespace), `aud_sub` (the resource's own id for the user), and `email`.
The allow list is keyed on the resource's own user id, so the join key is
**`aud_sub`**; `email` is a weak fallback (a resource may store only hashes); `sub`
is never used — binding authorization to the IdP's namespace breaks the moment the
two id spaces diverge.

**Agent identity.** The agent is keyed on **`client_id`**, the draft's required,
normative identifier. The `act` claim is not used for authorization: the draft
defines no processing for it, and keying access off a non-normative claim is a
latent vulnerability. `act.name` serves only as a display hint in audit.

**Trade-offs.** Wins: minimal new surface, an honest floor that cannot be
subverted, a real and auditable agent veto, room to grow richer per-agent policy.
Costs: one more list to maintain; no way to grant an agent access its principal
lacks (by design); the coarse overlay cannot express per-category rules like
"agent X may read finance but not HR" without extension.

---

## 2. Revocation and the in-flight window

Because the resource re-checks the allow list at license issuance, revoking the
human necessarily revokes their agents. The interesting case is the **in-flight
window**: an assertion still cryptographically valid while the human was revoked a
second ago.

Position: **a valid assertion authenticates a delegation; it is never a cached
authorization.** Authorization is decided at read time against live state, so the
revocation wins immediately — the still-valid token buys no grace period. This
layer adds nothing that could widen the window (no decision caching), and the
integration tests demonstrate it: revoke → the very next read with the same valid
token is denied → restore → granted again.

Deliberately out of scope here, noted as hardening: a short-TTL `jti` replay cache
so a captured assertion cannot be re-presented within its lifetime. That is a
validation concern, not an authorization decision.

---

## 3. Attribution in a single-actor audit log

The audit event has one actor field (`user_id`) plus a JSON payload. To name two
actors honestly:

- `user_id` → the **human principal** (the on-behalf-of subject)
- `event_payload.actor` → the **agent** (`client_id`, name)
- `event_payload.on_behalf_of` → the principal again, explicit
- `correlation_id` → the assertion **`jti`**, tying the row to the exact grant

Grants and denials are both attributed. An overlay denial happens *before* any
read, so the gateway records it explicitly (`read_denied`, reason
`agent_not_approved`) — otherwise "an unapproved agent attempted access" would
vanish from the trail. In a schema we controlled, `agent_client_id` would be a
first-class indexed column so "every read by this agent, across all principals" is
a cheap query rather than a JSON scan.

---

## 4. Adoption stance: the pattern now, the wire format loosely

ID-JAG is an IETF draft and Cross App Access is Early Access, so the claim shapes
may still move. The underlying idea — a signed, short-lived, audience-bound
assertion of "agent acting for human" — is stable, correct, and strictly better
than the alternatives agents otherwise force (long-lived API keys, broad per-user
OAuth grants).

The stance implemented here: **adopt the resource-side validation now, isolated
behind an internal boundary** (`validateAssertion()`), and treat "ID-JAG draft-04
via a given IdP" as one pluggable issuer profile. If the draft changes or a second
IdP appears, the profile is swapped, not the access model. Validation rides the
IdP's existing OIDC signing keys (JWKS), so the crypto is boring and
well-understood; the expensive half of the protocol (minting, admin policy) lives
with the IdP, not the resource.

---

## 5. Boundaries: what this does and does not protect

This mechanism is identity-and-authorization **at the door**.

It genuinely provides:
- **Attribution** — which agent acted, for which human, signed and non-repudiable.
- **Delegated authorization** — the IdP governs which agents may act, centrally
  and revocably, replacing long-lived credentials.
- **Cross-app confinement** — audience binding stops a token minted for one app
  from being replayed against another.

It does nothing about:
- **Exfiltration after a legitimate read.** Once an authorized caller holds the
  decryption license, this layer is done; copying or re-sharing plaintext is the
  persistent-protection problem, owned elsewhere.
- **A compromised agent** presenting a still-valid assertion. The signature proves
  the IdP vouched for the `client_id`, not that the agent is currently behaving.
  Short TTLs shrink the window; behavioural controls close it.
- **Misuse within authority** — an agent legitimately allowed to read one file that
  reads thousands needs volume/rate policy, not identity.
- **`scope` as enforcement** — treated as a least-privilege hint only; real
  enforcement is the allow list plus the agent overlay.

In one line: this makes "who opened the file, and for whom" trustworthy and
centrally governable; it does not extend protection past the moment of a
legitimate read.

---

## 6. Current limitations / next steps

- No token-exchange leg (the ID-JAG is validated directly).
- No `jti` replay cache.
- The overlay is workspace-coarse; no per-file or per-category agent rules.
- Public (link-mode) files inherit the resource's own behaviour; no separate
  agent policy for non-explicit grants yet.
- Validated against a local IdP fixture, not a live IdP tenant.
