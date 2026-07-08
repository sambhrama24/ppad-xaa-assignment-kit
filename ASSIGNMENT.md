# PPAD Engineering Test: Agent Identity with Cross App Access (XAA)

Thank you for taking the time to work on this with us. We are excited to see how
you think.

This is a three-working-day assignment. The scope is designed so that the core
is reachable comfortably within that time.

We care far more about clear reasoning and defensible decisions than a long
feature list. If you find yourself adding surface area, stop and go deeper
instead.

## Ground rules

- Use AI agents freely. We use them too. The expectation is that you fully
  understand everything you submit and can walk us through and justify any part
  of it, in code and in prose, live.
- If something is ambiguous, make a call, write down your assumption, and keep
  going. Knowing what to assume is part of what we are testing.
- Please ask questions. We would much rather you reach out than guess in silence.
  How you engage with us is part of the evaluation.

## Background

PPAD, short for Persistent Protection After Download, is Digify's service for
sharing files that remain encrypted and tracked after they leave the sender's
control. A file is encrypted, shared with named recipients on an allow list, and
every view is tracked so the owner can see who opened it. Access is managed by
adding and revoking recipients.

Cross App Access, or XAA, is Okta's protocol for allowing an enterprise identity
provider to govern when an AI agent may act on a user's behalf across
applications. It is built on the Identity Assertion JWT Authorization Grant, or
ID-JAG, an OAuth extension currently under IETF standardization. XAA is also
positioned as an enterprise-standard path for connecting to MCP servers.

The short version: the identity provider issues a signed assertion stating that a
specific agent is acting for a specific human. The resource application validates
that assertion before serving data.

The problem we want you to think about is this: as customers point AI agents at
their document workflows, "who opened this file" stops being only a person and
may become an agent acting for a person. PPAD needs to govern that access and,
critically, attribute it correctly. We want to know not just that a file was
read, but which agent read it and on whose behalf.

This assignment asks you to reason about how XAA composes with PPAD's existing
access model, and to prove a thin slice of that model works.

## PPAD's access model today (the part that matters)

You do not need to know PPAD's internals — only enough to reason about the
composition. The kit's stub models exactly this, and `INTEGRATION-NOTE.md` maps
it to a production service:

- **Allow list.** Access to a protected file is an allow list of **human
  recipients**, keyed on the user's id (`user_id`). A recipient is `active` or
  `revoked`.
- **Sharing modes.** `explicit` (named recipients) or `public` (anyone with the
  link — "link mode"). The stub models these two.
- **Reads are gated server-side.** Decryption happens **client-side**, so a "read"
  is really the viewer obtaining a decryption license, granted only if the
  recipient is currently allowed. The stub models a read as license issuance — it
  never returns plaintext.
- **Audit is a single-actor event log.** Each event records one actor
  (`user_id`) plus a JSON payload. There is no second "acting agent" column.

The crux: **PPAD's allow list is keyed on a human `user_id`. An ID-JAG assertion
identifies the acting agent by its `client_id`, which has no home in that model
today.** Closing that gap is the heart of this test.

## What we provide

This kit is your substrate — you should not have to fight Okta's admin console or
stand up a live identity provider. See `README.md` to run it. It contains:

- A **PPAD-like stub** exposing the relevant surface: file metadata, list access,
  a governed read (license issuance), audit log, and recipient revoke/restore.
  The stub enforces PPAD's **human** allow list; it does not gate on the agent.
- A **second resource app (App B)** — deliberately minimal (read-only, one file),
  on its own audience — so you can demonstrate the **cross-app** part of XAA: one
  IdP, two apps, and tokens that are bound to a single app. `npm start` boots both
  (PPAD on `:4010`, App B on `:4011`).
- A small set of **sample protected files** with known owners and allow lists
  (`ppad-stub/seed.json`), including an active recipient, an unshared user, a
  revoked recipient, and a public file.
- A **local fake IdP**: a token mint, the matching **JWKS** for offline signature
  validation, and **pre-issued sample ID-JAG tokens** (valid and a full set of
  invalid ones). Claim-by-claim provenance is in `identity-fixtures/claims.md`.
- A **contract-test harness** that runs against your service.
- An **integration note** mapping the stub to a production service's shape.

Standing up a live Okta org and minting your own tokens is a stretch goal, not a
requirement.

---

# Part 1: Research and decisions

This is the heart of the test. We are not looking for a literature review of XAA.
We are looking for decisions you can defend.

Keep it tight — about **2-3 pages, or a short deck**. There is no minimum; we
would rather read two sharp pages than six padded ones. Spend most of your space
on the composition decision (question 1); a few paragraphs each on questions 2
and 3 is plenty. If you are past three pages, you are probably explaining XAA to
us instead of making calls. Address the following three questions directly.

## 1. Composition

XAA governs whether an agent may act on behalf of a user. PPAD's allow list
governs whether a recipient may open a file. These two models do not map
one-to-one. Make a clear call:

- **Where does the agent live?** PPAD's allow list is keyed on a human `user_id`;
  the assertion's agent is a `client_id`. Does the agent ride entirely on its
  human principal's access (inheritance — the `client_id` appears only in the
  audit trail), or is the agent governed by a separate policy keyed on
  `client_id` (an independent agent allow list you introduce)?
- **Revocation.** PPAD enforces the recipient allow list server-side, so when the
  human is revoked the agent necessarily loses access too — you cannot grant an
  agent more than its principal currently has. Given that: what, if anything,
  does your layer still decide about revocation, and what happens in the
  **in-flight window** where the assertion is still valid but the human was just
  revoked?
- **Attribution.** PPAD's audit event has a single actor field. How should the
  agent identity appear in the per-file audit trail, distinct from the human it
  acted for, given that constraint?

There is no single correct answer. We want to see that you notice the mismatch,
choose a model, and explain what your choice wins and what it costs.

## 2. Adopt or wait

XAA is an Early Access protocol built on an IETF draft. Weigh adopting it now
against building a thinner agent-identity layer ourselves, or waiting for the
standard and ecosystem to mature. Factor in PPAD's actual position: a small
company with enterprise buyers who are starting to ask about agent governance.

We are watching whether you weigh standards maturity, customer demand,
interoperability, security posture, and engineering cost — rather than adopting a
new protocol simply because the announcement had big names attached to it.

## 3. Where XAA does not help

Be honest about the boundary. Where does XAA genuinely improve PPAD's posture, and
where does it do nothing? Connect this to a realistic threat model for a
document-protection product. For example, distinguish between identity
attribution, access authorization, auditability, data exfiltration, compromised
agents, malicious users, and misuse after a legitimate read.

---

# Part 2: Prototype

Build a thin but working slice that proves the access-composition model you argued
for in Part 1. Narrow and correct beats broad and shaky.

The prototype should:

1. Accept an agent identity assertion using the provided sample tokens.
2. **Validate the assertion properly**: issuer, audience (for the **target**
   resource app), expiry, and signature against the provided JWKS. A robust
   validator also pins the algorithm (reject `alg:none`) and rejects an unknown
   key id.
3. Cleanly **deny callers presenting an invalid, expired, or wrong-audience
   assertion**. These callers must never reach the stub or be served a license.
4. Map the agent identity to PPAD's access model according to the composition
   rule you chose in Part 1. Note that `client_id` is the spec-required agent
   identifier; `act` is optional and not normatively processed (see `claims.md`).
5. Perform one **governed read** against the target resource's stub (PPAD or App
   B), succeeding only when the agent-plus-principal is authorized for that file.
6. Emit an **audit record attributing the read to both** the agent and the human
   principal — working within the stub's single-actor event shape.
7. **Honor the cross-app boundary.** Your tool is told which resource it is acting
   on (`ppad` or `appb`); validate the assertion's audience against *that* resource
   and **reject** a token minted for the other app. A PPAD-scoped token must not
   open an App B file, and vice versa.

Validate inputs and return **structured errors**. Do not throw raw exceptions to
the caller. Endpoints, issuer, audience, JWKS location, and the stub service key
must come from config or environment variables — the issuer / audience / JWKS
values are in `identity-fixtures/issuer-config.json`; the stub base URL and
service key are your service's own config. Do not hardcode them.

## Interface

Expose this as an **MCP tool** (preferred) or a small HTTP service. Either way,
satisfy the contract the harness expects (full shape in `README.md`):

- MCP tool `ppad_read_protected_file`, arguments `{ assertion, resource, fileId }`
  (`resource` is `"ppad"` or `"appb"`, default `"ppad"`).
- Returns a normalized result `{ outcome, code, file_id, audit_event_id? }`,
  where `outcome` is `granted` | `denied` | `rejected` (`rejected` means the
  assertion failed validation — including being scoped to the wrong app — and the
  stub was never called).

MCP is preferred because that is where this class of integration is heading.

## Tests we expect

At minimum:

- Access decision: authorized agent-principal pair succeeds; an unauthorized pair
  is denied; a revoked principal is denied.
- Assertion validation failure: an expired assertion is rejected, or a
  wrong-audience assertion is rejected.
- Cross-app: a token scoped to PPAD is rejected against App B (and vice versa).

The kit ships fresh-mintable tokens for every case (`npm run mint`), including
`expired`, `wrong-audience`, `invalid-signature`, `unknown-kid`, `alg-none`, and
`valid-alice-appb` (the App B-scoped token).

## Optional stretch

Do not start these until the core is solid.

- Mint a real assertion against a live Okta Integrator Free Plan org instead of
  using the provided sample tokens.
- Support revocation that immediately blocks an in-flight read (the stub's
  `recipients/:id/revoke` endpoint lets you test this).
- Distinguish `public` (link-mode) from `explicit` (restricted) sharing in the
  agent access decision.

---

# Deliverables

Submit a single archive containing:

- `src/` — your service / MCP tool (built against this kit, in your own layout).
- `config/` — your configuration.
- `tests/` — your tests.
- `README.md` — how to run it, how to point an MCP client or the contract-test
  harness at it, one example call and response, your assumptions, and any
  important trade-offs or limitations.
- Your Part 1 write-up, inside the repo or as a separate document or deck.

You do not need to resubmit this kit — just your service and write-up, plus
whatever config the harness needs to reach your tool.

---

# Defense session

After you submit, we will spend about thirty minutes together. Treat the document
and prototype as your ticket into the conversation rather than the finish line.
The defense session is where much of the signal is for us. We will ask you to
justify your decisions live, including:

- why you composed the XAA and PPAD access models the way you did
- why you would adopt XAA now, build something thinner, or wait
- what your token validation does and does not prove
- where XAA falls short
- what you would change if this moved from prototype to production

Come ready to defend your calls and to change your mind out loud if we find a
hole. That is a good outcome, not a bad one.

---

# How we evaluate

In rough order of weight:

1. **Access-composition decision.** Did you see the mismatch between XAA's
   delegation model and PPAD's recipient model, and make a clear, defensible call
   about which model governs where?
2. **Live defense.** Can you justify and pressure-test your reasoning under
   questioning?
3. **Validation and attribution in the prototype.** Is the assertion validated
   correctly? Is the access decision enforced consistently? Is the audit trail
   honestly attributed to both agent and principal?
4. **Threat-model honesty.** Did you represent what XAA does and does not do
   without overselling it?
5. **Code quality, tests, and README clarity.** Is the implementation
   understandable, focused, testable, and easy to run?
6. **Communication throughout.** Did you ask useful questions, state assumptions
   clearly, and engage with ambiguity in a practical way?

Most of the weight is on judgment, not output. That is deliberate.

---

# Suggested shape for the three days

Guidance, not a requirement.

- **Day 1** — Read the XAA and ID-JAG primary sources, run the kit, work through
  the stub and the sample tokens (`README.md`, `claims.md`, `INTEGRATION-NOTE.md`),
  and draft your composition decision.
- **Day 2** — Build and test the prototype slice. Let what you learn while
  building it sharpen or revise your Part 1 reasoning.
- **Day 3** — Tighten the write-up, finish tests and README, and prepare to
  defend your calls.

---

# References

- Okta, Cross App Access overview: https://www.okta.com/identity-101/cross-app-access-securing-ai-agent-and-app-to-app-connections/
- Okta Developer, building XAA agent-to-app connections: https://developer.okta.com/blog/2025/09/03/cross-app-access
- Okta Developer, XAA-enabled resource app and testing: https://developer.okta.com/blog/2026/02/17/xaa-resource-app
- ID-JAG draft (IETF): https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/
- ID-JAG explained, Descope: https://www.descope.com/learn/post/id-jag-cross-app-access
- XAA open sandbox: https://xaa.dev
- This kit: `README.md`, `identity-fixtures/claims.md`, `INTEGRATION-NOTE.md`
