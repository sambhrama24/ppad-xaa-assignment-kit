# Part 1 — Agent identity for PPAD with Cross App Access

> Draft for the take-home. It states the calls I made and why; the prototype in
> this repo implements them. It is intentionally opinionated — I would rather
> defend a clear position than hedge.

## The mismatch, in one paragraph

PPAD authorizes reads with an **allow list keyed on a human `user_id`**. An ID-JAG
assertion authorizes an **agent identified by `client_id`**, acting for a human, and
scoped to one app by its `aud`. The agent's `client_id` has **no home** in PPAD's
model. So there is a real modelling decision — not a wiring exercise — about where
the agent lives, how revocation behaves, and how a single-actor audit log can
honestly name two actors. Everything below is that decision.

---

## 1. Composition (the crux)

### 1a. Where does the agent live? — *Inheritance baseline + a thin agent overlay*

Two clean options exist. **Inheritance:** the agent rides entirely on its human's
access; `client_id` appears only in audit. **Independent policy:** a separate allow
list keyed on `client_id`.

I chose **both, layered**, because they answer different questions:

- **Floor (inheritance, enforced by PPAD):** the human principal — resolved to PPAD's
  `user_id` — must be *currently* allowed. PPAD enforces this server-side, so **an
  agent can never exceed its principal.** This is a security property I get for free
  and refuse to give up.
- **Overlay (a thin `client_id` allow list I introduce):** on top of the floor, an
  agent that is not approved is denied **even when its human is allowed.** This is the
  only place a `client_id` participates in the *decision* rather than just the record.

Why not inheritance alone? Because "any agent Alice happens to be driving may read
everything Alice can read" is exactly the posture enterprise buyers are nervous
about. The overlay gives security teams a governed answer to "which agents may act
here at all," without touching per-file sharing. Why not an independent per-file
agent allow list? Because it doubles the sharing surface owners must manage and
invites the dangerous mistake of granting an agent *more* than its principal. The
overlay is deliberately **coarse (a workspace-level agent roster), and strictly
subtractive** — it can only ever narrow inherited access.

In the prototype this is a config allow list (`APPROVED_AGENTS`). Empty ⇒ pure
inheritance; populated ⇒ the overlay enforces. The one fixture token whose outcome
is "my call," `valid-unapproved-agent` (allowed human, unapproved agent), resolves to
**denied** — which is what makes the overlay real rather than decorative.

**Subject resolution.** The assertion hands me three identifiers for the human:
`sub` (IdP namespace, `00u…`), `aud_sub` (the Resource AS's id for the user), and
`email`. PPAD's allow list is keyed on its own `user_id`, which the draft says is
exactly `aud_sub` ("the Resource AS's identifier for the End-User"). So I key on
**`aud_sub`**, treat **`email`** as a weaker fallback (a resource may store only a
hash), and **reject `sub` as the join key** — binding authorization to the IdP's
namespace would silently break the moment PPAD's and the IdP's id spaces diverged.

**Agent identity.** I key the agent on **`client_id`** — the draft's REQUIRED,
normative agent identifier — and ignore `act` for authorization. `act` is present in
the fixtures but the draft explicitly does not define processing for it (§9.7);
keying access off a non-normative claim would be a latent vulnerability. (The
`missing-act` token succeeds precisely because I never depended on `act`.)

**What this wins / costs.** Wins: minimal new surface; an honest floor that can't be
subverted; a real, auditable agent veto; forward-compatibility (the overlay is where
richer per-agent policy would grow). Costs: one more list for someone to maintain;
by design I *cannot* grant an agent access its principal lacks (I consider that a
feature); a coarse overlay won't express "agent X may read finance docs but not HR"
without extending it — out of scope here, but the natural next step.

### 1b. Revocation and the in-flight window

Because PPAD re-checks the allow list at license issuance, revoking the human
necessarily revokes their agents — I can't grant an agent more than the principal
*currently* has. So the interesting case is the **in-flight window**: the assertion
is still cryptographically valid (short-lived, minutes) but the human was revoked one
second ago.

My position: **a valid assertion authenticates a delegation; it is never a cached
authorization.** Authorization is decided at the moment of the read, against live
state. So the revoke wins the instant the tool calls `/read` — the still-valid
assertion does not buy a grace period. My layer adds nothing that could *widen* this
window (I don't cache decisions), and the prototype demonstrates it: revoke Alice,
the very next read with her still-valid token returns `denied / principal_not_authorized`;
restore, and it grants again.

What my layer *could* still decide, and consciously doesn't: honor an assertion's
short lifetime as a *ceiling* only, never a floor; and, in a fuller build, add a
`jti` replay cache so a captured assertion can't be re-presented within its TTL.
That is a validation hardening, not an authorization decision — noted as a next step.

### 1c. Attribution in a single-actor log

PPAD's audit event has one actor field (`user_id`) plus a JSON payload. To name two
actors honestly I keep the human in the first-class field and put the agent in the
payload — matching the stub's convention rather than inventing a schema:

- `user_id` → the **human principal** (the on-behalf-of subject)
- `event_payload.actor` → the **agent** (`client_id`, name)
- `event_payload.on_behalf_of` → the principal again, explicit
- `correlation_id` → the assertion **`jti`** (ties the audit row to the exact grant)

The key honesty point: a grant and an overlay-denial are *both* attributed. A denial
my overlay makes happens **before** `/read`, so I record it myself via `POST /audit`
(`event_type: read_denied`, `deny_reason: agent_not_approved`) — otherwise "an
unapproved agent tried to act for Alice" would vanish from the trail. If I could
change the schema I'd promote `agent_client_id` to a first-class, indexed column so
"show every read by this agent across all principals" is a cheap query rather than a
JSON scan — the single-actor field is the real production constraint to fix.

---

## 2. Adopt XAA now, build thinner, or wait?

**Recommendation: adopt the *pattern* now, behind our own interface; stay
vendor-neutral; do not hard-commit to draft-04 wire details.**

- **Standards maturity.** ID-JAG is an IETF *draft* and XAA is Early Access. Draft
  claim shapes can still move. That argues against welding our data model to the wire
  format — but not against the underlying idea, which is stable and correct: a signed,
  short-lived, audience-bound assertion of "agent acting for human."
- **Customer demand.** PPAD's enterprise buyers are *starting* to ask about agent
  governance. "We validate a signed delegation assertion from your IdP, enforce it
  against the recipient allow list, and attribute every read to both agent and human"
  is a concrete answer that wins deals now. Waiting silently is the worse risk.
- **Interoperability.** ID-JAG rides the IdP's existing OIDC signing keys (JWKS), so
  the validation is boring, well-understood crypto — the same thing we'd build for any
  homegrown scheme, but with an emerging standard's blessing and Okta/Microsoft/Google
  momentum behind it.
- **Security posture.** Short-lived, audience-bound, signed assertions are strictly
  better than the alternatives an agent would otherwise force on us: long-lived API
  keys or broad per-user OAuth grants.
- **Engineering cost.** The validating side (what a resource app like PPAD needs) is
  small — this prototype is the bulk of it. The expensive half (an IdP that mints
  ID-JAGs, admin policy UI) is Okta's to build, not ours.

**The synthesis:** adopt the resource-side validation now, isolate it behind an
internal `validateDelegationAssertion()` boundary (as this repo does), and treat
"ID-JAG draft-04 via Okta" as one pluggable issuer profile. If the draft changes or a
second IdP appears, we swap the profile, not the access model. This is *adopt the
standard's shape without betting the company on one vendor or one draft revision* —
explicitly **not** "adopt it because the announcement had big names on it."

---

## 3. Where XAA does *not* help

XAA is an **identity-and-authorization-at-the-door** mechanism. Mapped to a
document-protection threat model, it is strong on some threats and silent on others —
and PPAD's entire value proposition lives partly in the "silent" column.

**XAA genuinely improves:**
- **Identity attribution** — we now know *which agent* acted for *which human*, signed
  and non-repudiable, instead of a bare `user_id`.
- **Delegated authorization** — the IdP governs which agents may act, centrally and
  revocably, replacing long-lived keys.
- **Cross-app confinement** — audience binding stops a token minted for PPAD from being
  replayed against App B. Real, and demonstrated.
- **Auditability at the point of access** — a trustworthy who/for-whom on every read.

**XAA does nothing about:**
- **Exfiltration after a legitimate read.** Once a properly authorized agent (or human)
  obtains the decryption license, XAA is done. Screenshotting, copying, re-sharing the
  plaintext is precisely PPAD's *persistent-protection* problem, not XAA's. This is the
  most important boundary to state plainly: **XAA governs the door, PPAD governs what
  happens in the room.**
- **A compromised agent** presenting a still-valid assertion. The signature says the
  IdP vouched for this `client_id`; it says nothing about whether the agent has been
  hijacked or prompt-injected mid-task. Short TTLs shrink the window; they don't close
  it. Behavioural limits (rate, scope, anomaly detection) live outside XAA.
- **Misuse within authority.** An agent legitimately allowed to read a file, that then
  reads *thousands* to train on or leak, is doing nothing XAA can object to. That needs
  volume/rate policy, not identity.
- **Malicious insiders / owners.** XAA doesn't change what a legitimately-allowed human
  may do, and can't protect against an owner who over-shares.
- **`scope` as enforcement.** The fixtures carry `scope: ppad.read`; I treat it as a
  least-privilege *hint*, not a control. Nothing stops a broader scope being minted;
  the real enforcement is PPAD's allow list plus my overlay.

The honest one-liner for the defense: **XAA makes "who opened this file, and for
whom" trustworthy and centrally governable — and that is genuinely valuable — but it
does not extend PPAD's protection past the moment of a legitimate read, which is the
half of the threat model PPAD exists to own.**

---

## Appendix — what the prototype proves, and what it doesn't

- **Proves:** correct ID-JAG validation (sig/JWKS, alg-pin incl. `alg:none`,
  unknown-kid, iss, target-audience, exp/nbf); the `rejected` invariant (bad assertions
  never touch a stub, verified via unchanged audit count); the composition policy
  including an enforcing agent overlay; dual attribution in a single-actor log for both
  grants and overlay-denials; the cross-app boundary both directions; in-flight
  revocation.
- **Does not prove:** anything about the IdP's minting/policy side; replay resistance
  (no `jti` cache yet); public-vs-explicit sharing nuance; a live Okta org. These are
  named next steps, deliberately left out to keep the slice narrow and correct.
