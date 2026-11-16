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
| `POST` | `/auth/verify-email` | Public (Token + Rate-Limited) | Verify account email ownership with single-use 30-minute `{ token }`. Marks `emailVerified: true` atomically without touching any `Participant` records. |
| `POST` | `/auth/resend-verification` | Authenticated (Rate-Limited) | Rotate and resend the authenticated user's email verification link (invalidating previous unredeemed tokens). |
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
| `GET` | `/trips/:tripId` | Participant | Get full trip details, participants, families, checklist, and financial summary |
| `PATCH` | `/trips/:tripId` | Organizer | Update trip metadata, dates, budget, `inviteEnabled`, `inviteExpiresAt`, or status (`PLANNING`, `ACTIVE`, `REVIEW`, `CLOSED`) |
| `POST` | `/trips/join/:inviteCode` | Authenticated (Rate-Limited) | Join a trip as low-privilege `PARTICIPANT` (`DEFAULT_OPEN_INVITE_ROLE`) via an enabled, unexpired invite code on a non-closed trip. Rejects closed trips (`403 TRIP_CLOSED`), disabled/expired invites, guest-slot claiming (`guestParticipantId`), deactivated participant reactivation, or email matching. |
| `PATCH` | `/trips/:tripId/checklist` | Organizer | Update Forgotten Expense Protection checklist items before closing trip |
| `POST` | `/trips/:tripId/close` | Organizer | Verify checklist completion, check pending expenses, disable open invite joining (`inviteEnabled: false`), and finalize/close trip |

---

## 5. Participant & Family Endpoints (`/api/v1/trips/:tripId/...`)

| Method | Endpoint | Minimum Role | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/trips/:tripId/participants` | Organizer | Create an unlinked guest participant (`userId: null` always; never auto-links existing accounts by email) |
| `PATCH` | `/trips/:tripId/participants/:participantId` | Organizer | Update participant details, role, weight, family assignment, or active status (blocks changing email on linked participants and demoting/deactivating the sole active `ORGANIZER`) |
| `DELETE` | `/trips/:tripId/participants/:participantId` | Organizer | Deactivate/remove participant (blocked if participant has active financial records) |
| `POST` | `/trips/:tripId/families` | Organizer | Create a family group in Family Mode and optionally assign representative |
| `PATCH` | `/trips/:tripId/families/:familyId` | Organizer | Update family name, representative (`representativeId`), or default weight |
| `DELETE` | `/trips/:tripId/families/:familyId` | Organizer | Remove an empty family group |

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
| `POST` | `/trips/:tripId/settlements` | Participant | Record a full or partial settlement reimbursement |
| `PATCH` | `/trips/:tripId/settlements/:settlementId/status` | Organizer / Receiver | Confirm or reject a reported settlement |

---

## 8. Reporting & Public Share Endpoints (`/api/v1/trips/:tripId/reports` & `/api/v1/shared`)

| Method | Endpoint | Minimum Role | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/trips/:tripId/reports/summary` | Participant | Comprehensive analytical breakdown (by category, payer contributions, packages vs additional, individual & family net matrix) |
| `GET` | `/trips/:tripId/activity` | Participant | Paginated audit trail from `ActivityLogs` |
| `GET` | `/shared/:shareToken` | Public (Read-Only) | Sanitized read-only trip financial summary for sharing with non-registered participants (strips emails, phones, and user IDs) |
