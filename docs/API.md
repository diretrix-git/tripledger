# TripLedger — REST API Specification

Base URL: `/api/v1`

## 1. Response Envelope & Error Format

### Success Response
```json
{
  "success": true,
  "data": { ... },
  "meta": { "timestamp": "2026-11-15T09:30:00.000Z" }
}
```

### Error Response
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Total recorded payments (NPR 4,500.00) must equal expense amount (NPR 5,000.00)",
    "details": []
  }
}
```

---

## 2. Authentication & Profile Endpoints (`/api/v1/auth`)

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/auth/register` | Public (Rate-Limited) | Register a new unverified user account (`emailVerified: false`), send email verification token, set HTTP-only refresh cookie & return access token. Returns `409 EMAIL_EXISTS` on duplicate email. On email delivery failure (`503 EMAIL_DELIVERY_FAILED`), preserves the unverified account and hashed token so the user can log in and resend verification. |
| `POST` | `/auth/login` | Public (Rate-Limited) | Authenticate with email/password (permitted for unverified accounts); returns access token & `AuthUserEntity` (`emailVerified`, `emailVerifiedAt`). Never auto-links guest participants. |
| `POST` | `/auth/verify-email` | Public (Token + Rate-Limited) | Verify account email ownership with single-use 30-minute `{ token }`. Marks `emailVerified: true` atomically without touching any `Participant` records and returns `{ verified, userId, emailVerified, emailVerifiedAt }`. |
| `POST` | `/auth/resend-verification` | Authenticated (Cooldown + Rate-Limited) | Rotate and resend the authenticated user's email verification link (invalidating previous unredeemed tokens). Enforces an atomic 60-second per-account cooldown (`429 VERIFICATION_RESEND_COOLDOWN` with `Retry-After`) and 5-per-15-minute send quota (`429 RATE_LIMITED`), without counting provider `503` failures against either limit. Returns `{ sent: false, alreadyVerified: true }` when already verified. |
| `POST` | `/auth/refresh` | Cookie / Token | Rotate refresh token and issue new short-lived access token with updated `AuthUserEntity`. |
| `POST` | `/auth/logout` | Authenticated | Clear refresh token hash and expire HTTP-only cookie |
| `GET` | `/auth/me` | Authenticated | Get current authenticated user profile (`emailVerified`, `emailVerifiedAt`, currency) |
| `PATCH` | `/auth/me` | Authenticated | Update user profile (`name`, `phone`). Account `email` is immutable. |

---

## 3. Dashboard & Cross-Trip Endpoints (`/api/v1/dashboard`)

| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/dashboard/summary` | Authenticated | Aggregate active trips, total expenditure, money owed to user, money user owes, and recent activity feed |

---

## 4. Trip Management Endpoints (`/api/v1/trips`)

| Method | Endpoint | Minimum Role | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/trips` | Authenticated | Create a new trip (`FRIENDS` or `FAMILY` mode) and auto-enroll creator as `ORGANIZER` |
| `GET` | `/trips` | Authenticated | List trips where the user is a participant (filterable by `mode`, `status`) |
| `GET` | `/trips/:tripId` | Participant | Get full trip details, participants, families, checklist, and financial summary (`inviteCode` is included only for `ORGANIZER` callers) |
| `PATCH` | `/trips/:tripId` | Organizer | Update trip metadata, dates, budget, `inviteEnabled`, `inviteExpiresAt`, or status (`PLANNING`, `ACTIVE`, `REVIEW`, `CLOSED`); executes serialized against live trip state with atomic `ActivityLog` writes and standalone rollback |
| `POST` | `/trips/join/:inviteCode` | Authenticated (Rate-Limited) | Join a trip as low-privilege `PARTICIPANT` (`DEFAULT_OPEN_INVITE_ROLE`) via an enabled, unexpired invite code on a non-closed trip inside the serialized trip lock with atomic `ActivityLog` persistence. Rejects closed trips (`403 TRIP_CLOSED`), disabled/expired invites, guest-slot claiming (`guestParticipantId`), deactivated participant reactivation, or email matching. |
| `GET` | `/trips/invites/pending` | Verified Email | List active unexpired email-bound participant invitations matching the authenticated user's verified email address (no raw tokens exposed; excludes legacy/mismatched `FAMILY_REP` invites lacking a matching non-null `familyId`) |
| `POST` | `/trips/invites/claim` | Authenticated (Rate-Limited) | Redeem a single-use participant invitation token inside the serialized trip lock with atomic `ActivityLog` persistence and standalone rollback (reverting `usedAt`/`usedByUserId`, participant linkage/role, and family state). Privileged roles (`ORGANIZER`, `FAMILY_REP`) and email-bound invites strictly require verified email ownership matching `intendedEmail`, preserve the sole-linked-organizer and no-reassignment invariants, and reject `FAMILY_REP` invites lacking a matching non-null `familyId` with `409 INVITE_FAMILY_MISMATCH` without burning `usedAt`. |
| `PATCH` | `/trips/:tripId/checklist` | Organizer | Update Forgotten Expense Protection checklist items before closing trip |
| `POST` | `/trips/:tripId/close` | Organizer | Verify checklist completion, check pending expenses, disable open invite joining (`inviteEnabled: false`), and finalize/close trip |

---

## 5. Participant & Family Endpoints (`/api/v1/trips/:tripId/...`)

| Method | Endpoint | Minimum Role | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/trips/:tripId/participants` | Organizer | Create an unlinked guest participant (`userId: null`, strictly restricted to `role: PARTICIPANT`; never auto-links existing accounts by email); executes serialized against live trip and family state with atomic `ActivityLog` persistence |
| `GET` | `/trips/:tripId/invites` | Organizer | List redacted participant invitations issued for the trip (never returns `tokenHash` or `rawToken`) |
| `POST` | `/trips/:tripId/participants/:participantId/invites` | Organizer | Issue a single-use participant claim/promotion invitation inside the serialized trip lock with atomic `ActivityLog` persistence before external email dispatch (`FAMILY_REP` requires an eligible non-null `familyId`; privileged `ORGANIZER`/`FAMILY_REP` requires `intendedEmail` verified on redemption; `rawToken`/`claimUrl` are returned only on success). Issuing an invite revokes any prior pending invitation on that participant slot before delivery (`ActivityLog` failures roll back the creation and restore the superseded invite); if external email delivery subsequently fails (`503 EMAIL_DELIVERY_FAILED`), the newly created invitation is fail-closed revoked (+ best-effort `PARTICIPANT_INVITE_REVOKED` log), and previously superseded invitations are **not** automatically restored—callers must issue a fresh invitation. |
| `POST` | `/trips/:tripId/invites/:inviteId/revoke` | Organizer | Revoke a pending unredeemed participant invitation inside the serialized trip lock with atomic `ActivityLog` persistence and standalone revocation rollback |
| `PATCH` | `/trips/:tripId/participants/:participantId` | Organizer | Update participant details, non-privileged roles (`PARTICIPANT` / `CONTRIBUTOR` for linked users), demotions, weight, family assignment, or active status inside the serialized trip lock with atomic `ActivityLog` persistence (blocks direct promotion to `ORGANIZER`/`FAMILY_REP`, blocks elevating unlinked guests above `PARTICIPANT`, blocks reactivating privileged roles directly, clears `Family.representativeId` and revokes pending `FAMILY_REP` invites on demotion/deactivation/family-move, blocks changing email on linked participants, and preserves sole-linked-organizer invariant) |
| `DELETE` | `/trips/:tripId/participants/:participantId` | Organizer | Remove participant inside the serialized trip lock with atomic `ActivityLog` persistence (blocked if participant has active financial records; clears any `Family.representativeId` references and revokes pending invites) |
| `POST` | `/trips/:tripId/families` | Organizer | Create a family group in `FAMILY` Mode trips inside the serialized trip lock and optionally designate an active representative (does not auto-promote `FAMILY_REP`; rejects legacy ungrouped `FAMILY_REP` candidates with `409 PARTICIPANT_FAMILY_REP_CONFLICT`; revokes stale pending `FAMILY_REP` invites when re-homing across families) |
| `PATCH` | `/trips/:tripId/families/:familyId` | Organizer | Update family name (pre-checking duplicate names with `409 FAMILY_EXISTS` before mutations), designated representative (`representativeId` — demoting replaced `FAMILY_REP` roles and revoking stale cross-family `FAMILY_REP` invites while preserving valid same-family pending invites and never auto-promoting the new representative), or default weight atomically with `ActivityLog` |
| `DELETE` | `/trips/:tripId/families/:familyId` | Organizer | Remove a family group inside the serialized trip lock, unassign members, demote `FAMILY_REP` members to `PARTICIPANT`, revoke pending `FAMILY_REP` invites, and persist `ActivityLog` atomically |

---

## 6. Expense & Package Endpoints (`/api/v1/trips/:tripId/expenses`)

| Method | Endpoint | Minimum Role | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/trips/:tripId/expenses` | Participant | List expenses with payments and shares (filterable by category, status, payer, package) |
| `POST` | `/trips/:tripId/expenses` | Contributor / Organizer | Create an expense (or fixed package / estimated placeholder). Supports `clientMutationId` idempotency for offline PWA sync |
| `POST` | `/trips/:tripId/expenses/batch-sync` | Contributor / Organizer | Synchronize an array of offline-queued expenses idempotently |
| `PATCH` | `/trips/:tripId/expenses/:expenseId` | Organizer (or Creator if unapproved) | Edit expense amount, payers, split method, or resolve an estimated amount |
| `POST` | `/trips/:tripId/expenses/:expenseId/approve` | Organizer | Approve or reject a contributor-submitted expense or confirm an estimated expense |
| `DELETE` | `/trips/:tripId/expenses/:expenseId` | Organizer | Soft-delete (`isDeleted: true`) an expense and record reversal in `ActivityLogs` |

---

## 7. Balances & Settlement Endpoints (`/api/v1/trips/:tripId/settlements`)

| Method | Endpoint | Minimum Role | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/trips/:tripId/balances` | Participant | Compute real-time ledger: individual balances, family balances, and optimized settlement suggestions (both Individual & Family views) |
| `GET` | `/trips/:tripId/settlements` | Participant | List all recorded settlements (`PENDING`, `REPORTED`, `CONFIRMED`, `REJECTED`) |
| `POST` | `/trips/:tripId/settlements` | Participant | Record a full or partial settlement reimbursement inside the serialized trip lock against live trip, active actor (`userId`), sender, receiver, and validated family references (`REPORTED` or directly `CONFIRMED` by live Organizer/Receiver; `FAMILY` settlements restricted to `FAMILY` mode; `ActivityLog` persisted atomically) |
| `PATCH` | `/trips/:tripId/settlements/:settlementId/status` | Organizer / Receiver / Designated Family Rep | Confirm or reject a `REPORTED` settlement on an open trip (`409 INVALID_SETTLEMENT_TRANSITION` if already `CONFIRMED`/`REJECTED`; `FAMILY_REP` requires `FAMILY` mode, verified active account linkage, `toFamily.representativeId === actor`, and active receiver in `toFamily`) |

---

## 8. Reporting & Public Share Endpoints (`/api/v1/trips/:tripId/reports` & `/api/v1/shared`)

| Method | Endpoint | Minimum Role | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/trips/:tripId/reports/summary` | Participant | Comprehensive analytical breakdown (by category, payer contributions, packages vs additional, individual & family net matrix) |
| `GET` | `/trips/:tripId/activity` | Participant | Paginated audit trail from `ActivityLogs` |
| `GET` | `/shared/:shareToken` | Public (Read-Only) | Sanitized read-only trip financial summary for sharing with non-registered participants (strips emails, phones, and user IDs) |
