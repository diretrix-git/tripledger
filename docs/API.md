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
| `POST` | `/auth/register` | Public | Register a new user account; sets HTTP-only refresh cookie & returns access token |
| `POST` | `/auth/login` | Public | Authenticate with email/password; returns access token & user profile |
| `POST` | `/auth/refresh` | Cookie / Token | Rotate refresh token and issue new short-lived access token |
| `POST` | `/auth/logout` | Authenticated | Clear refresh token hash and expire HTTP-only cookie |
| `GET` | `/auth/me` | Authenticated | Get current authenticated user profile and cross-trip balance summary |
| `PATCH` | `/auth/me` | Authenticated | Update user profile (name, phone) |

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
| `PATCH` | `/trips/:tripId` | Organizer | Update trip metadata, dates, budget, or status (`PLANNING`, `ACTIVE`, `REVIEW`, `CLOSED`) |
| `POST` | `/trips/join/:inviteCode` | Authenticated | Join a trip via invite code (or link to an existing guest participant slot) |
| `PATCH` | `/trips/:tripId/checklist` | Organizer | Update Forgotten Expense Protection checklist items before closing trip |
| `POST` | `/trips/:tripId/close` | Organizer | Verify checklist completion, check pending expenses, and finalize/close trip |

---

## 5. Participant & Family Endpoints (`/api/v1/trips/:tripId/...`)

| Method | Endpoint | Minimum Role | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/trips/:tripId/participants` | Organizer | Add a guest or linked participant (with `role`, `memberType`, `familyId`, `defaultWeight`) |
| `PATCH` | `/trips/:tripId/participants/:participantId` | Organizer | Update participant details, role, weight, family assignment, or link a registered user |
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
