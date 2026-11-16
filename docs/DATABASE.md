# TripLedger — Database Architecture

## 1. Core Database Principles

1. **Normalized Financial Collections:** Expenses, payments (`ExpensePayments`), obligations (`ExpenseShares`), and reimbursements (`Settlements`) are stored in dedicated collections. Settlements never mutate or masquerade as expenses.
2. **Integer Paisa Storage:** Every monetary field (`amountPaisa`, `budgetPaisa`, `paidPaisa`, `sharePaisa`, `packageRatePaisa`) is stored as a signed/unsigned 64-bit safe integer in **paisa** (`NPR 1 = 100 paisa`). Schema validators reject non-integer or negative values.
3. **Trip-Level Isolation:** Every trip resource (`Participant`, `Family`, `Expense`, `ExpensePayment`, `ExpenseShare`, `Settlement`, `ActivityLog`) carries an indexed `tripId` reference. All queries filter by `tripId`.
4. **Historical Preservation & Soft Reversal:** Financial records (`Expense`, `Settlement`) are never hard-deleted once active. Cancelled or superseded expenses are marked `isDeleted: true` with `deletedAt` and `deletedBy` metadata, and excluded from active balance calculations while remaining visible in audit logs.

---

## 2. Entity-Relationship Diagram

```mermaid
erDiagram
    USER ||--o{ TRIP : "creates (organizer)"
    USER ||--o{ PARTICIPANT : "optionally linked to"
    TRIP ||--|{ PARTICIPANT : "has members"
    TRIP ||--o{ FAMILY : "has family groups (Family Mode)"
    FAMILY ||--|{ PARTICIPANT : "groups members"
    PARTICIPANT ||--o| FAMILY : "representative of"
    TRIP ||--o{ EXPENSE : "records"
    EXPENSE ||--|{ EXPENSE_PAYMENT : "funded by (1..N payers)"
    EXPENSE ||--|{ EXPENSE_SHARE : "split across (1..N participants)"
    PARTICIPANT ||--o{ EXPENSE_PAYMENT : "pays"
    PARTICIPANT ||--o{ EXPENSE_SHARE : "owes share"
    TRIP ||--o{ SETTLEMENT : "tracks reimbursements"
    PARTICIPANT ||--o{ SETTLEMENT : "sender (fromParticipantId)"
    PARTICIPANT ||--o{ SETTLEMENT : "receiver (toParticipantId)"
    FAMILY ||--o{ SETTLEMENT : "optional family settlement context"
    TRIP ||--o{ ACTIVITY_LOG : "audits actions"
```

---

## 3. Collection Schemas & Indexes

### 3.1 `Users` (`users`)
Stores registered platform accounts. Note that trip participants do not need a `User` document unless they register or link their account.
- `_id`: `ObjectId`
- `name`: `String` (required, trimmed)
- `email`: `String` (required, unique, lowercase, indexed)
- `emailVerified`: `Boolean` (default: `false`; legacy unverified users remain `false`)
- `emailVerifiedAt`: `Date` (nullable)
- `emailVerificationTokenHash`: `String` (`select: false`, nullable, 64-char SHA-256 hex digest)
- `emailVerificationExpiresAt`: `Date` (`select: false`, nullable)
- `emailVerificationLastSentAt`: `Date` (`select: false`, nullable — tracks last successful verification email send for atomic 60-second cooldown)
- `emailVerificationResendWindowStart`: `Date` (`select: false`, nullable — start of 15-minute successful resend quota window)
- `emailVerificationResendCount`: `Number` (`select: false`, default: `0` — successful resend count in active window; rolled back on delivery failure)
- `passwordHash`: `String` (required, `select: false`)
- `phone`: `String` (optional)
- `defaultCurrency`: `String` (default: `'NPR'`)
- `refreshTokenHash`: `String` (optional, `select: false`)
- `createdAt`, `updatedAt`: `Date`

**Indexes:** `{ email: 1 }` (unique), `{ emailVerificationTokenHash: 1 }` (`emailVerificationTokenHash_partial_unique` — unique when `$type: 'string' && $gt: ''`)

### 3.2 `Trips` (`trips`)
Represents a Friends Mode or Family Mode trip container.
- `_id`: `ObjectId`
- `name`: `String` (required, trimmed)
- `description`: `String` (optional)
- `mode`: `Enum ['FRIENDS', 'FAMILY']` (required, immutable after creation)
- `status`: `Enum ['PLANNING', 'ACTIVE', 'REVIEW', 'CLOSED']` (default: `'ACTIVE'`)
- `currency`: `String` (default: `'NPR'`)
- `budgetPaisa`: `Number` (integer `>= 0`, optional)
- `startDate`: `Date` (optional)
- `endDate`: `Date` (optional)
- `createdBy`: `ObjectId` (ref: `'User'`, required)
- `inviteCode`: `String` (unique, indexed)
- `inviteEnabled`: `Boolean` (default: `true`)
- `inviteExpiresAt`: `Date` (nullable, optional)
- `inviteCodeRotatedAt`: `Date` (nullable, optional)
- `defaultInviteRole`: `Enum ['PARTICIPANT']` (default: `'PARTICIPANT'`, immutable — open invite-code joins never default to `CONTRIBUTOR` or privileged roles)
- `shareToken`: `String` (unique, indexed, for read-only public summary sharing)
- `shareEnabled`: `Boolean` (default: `true`)
- `checklist`: Array of `{ category: String, label: String, checked: Boolean, notApplicable: Boolean, verifiedAt: Date }` (Forgotten Expense Protection checklist state)
- `closedAt`: `Date` (optional)
- `organizerLockVersion`: `Number` (default: `0` — incremented inside serialized organizer-mutation transactions to create a WiredTiger write conflict on `Trip` and prevent snapshot-isolation write skew)
- `organizerMutationLock`: `{ owner: String | null, expiresAt: Date | null }` (short-TTL MongoDB lease used only when running against non-production standalone MongoDB without replica-set transactions)
- `createdAt`, `updatedAt`: `Date`

**Indexes:** `{ createdBy: 1, status: 1 }`, `{ inviteCode: 1 }`, `{ shareToken: 1 }`

### 3.3 `Families` (`families`)
Used in `FAMILY` mode trips (and optionally available if organizing sub-groups) to group participants into family units with a designated representative.
- `_id`: `ObjectId`
- `tripId`: `ObjectId` (ref: `'Trip'`, required, indexed)
- `name`: `String` (required, e.g., `"Sharma Family"`)
- `representativeId`: `ObjectId` (ref: `'Participant'`, optional until members are created)
- `defaultWeight`: `Number` (default: `1`, `> 0`)
- `notes`: `String` (optional)
- `createdAt`, `updatedAt`: `Date`

**Indexes:** `{ tripId: 1, name: 1 }` (unique per trip)

### 3.4 `Participants` (`participants`)
Represents an individual person in a trip (either a guest managed by the organizer or a linked registered user).
- `_id`: `ObjectId`
- `tripId`: `ObjectId` (ref: `'Trip'`, required, indexed)
- `userId`: `ObjectId` (ref: `'User'`, nullable/optional — supports Guest Participants)
- `familyId`: `ObjectId` (ref: `'Family'`, nullable/optional)
- `name`: `String` (required, trimmed)
- `email`: `String` (optional, lowercase)
- `phone`: `String` (optional)
- `role`: `Enum ['ORGANIZER', 'CONTRIBUTOR', 'FAMILY_REP', 'PARTICIPANT']` (default: `'PARTICIPANT'`)
- `memberType`: `Enum ['ADULT', 'CHILD', 'DEPENDENT']` (default: `'ADULT'`)
- `defaultWeight`: `Number` (default: `1.0`, `>= 0` — configurable weight for weighted splitting; never hardcoded by age)
- `isActive`: `Boolean` (default: `true`)
- `createdAt`, `updatedAt`: `Date`

**Indexes:** `{ tripId: 1, isActive: 1 }`, `{ tripId: 1, userId: 1 }` (`tripId_1_userId_partial_unique` — unique when `userId` is `$type: 'objectId'`, allowing multiple guest rows per trip while preventing duplicate user memberships across active and deactivated slots), `{ tripId: 1, familyId: 1 }`

### 3.4a `ParticipantInvites` (`participantinvites`)
Stores organizer-issued, participant-scoped, single-use claim invitations. Raw claim secrets are never stored in MongoDB (only SHA-256 digests).
- `_id`: `ObjectId`
- `tripId`: `ObjectId` (ref: `'Trip'`, required, immutable, indexed)
- `participantId`: `ObjectId` (ref: `'Participant'`, required, immutable, indexed)
- `invitedByUserId`: `ObjectId` (ref: `'User'`, required, immutable)
- `invitedByParticipantId`: `ObjectId` (ref: `'Participant'`, required, immutable)
- `tokenHash`: `String` (`select: false`, required, immutable, 64-char SHA-256 hex digest)
- `intendedEmail`: `String` (nullable, lowercase, immutable — required whenever `grantedRole` is `ORGANIZER` or `FAMILY_REP`)
- `grantedRole`: `Enum ['ORGANIZER', 'CONTRIBUTOR', 'FAMILY_REP', 'PARTICIPANT']` (required, immutable)
- `requireVerifiedEmail`: `Boolean` (required, immutable — enforced `true` for privileged roles and any email-bound invite)
- `expiresAt`: `Date` (required, immutable — must be a valid future timestamp on creation)
- `usedAt`: `Date` (nullable; set together with `usedByUserId`)
- `usedByUserId`: `ObjectId` (ref: `'User'`, nullable)
- `revokedAt`: `Date` (nullable; mutually exclusive with `usedAt`)
- `revokedByParticipantId`: `ObjectId` (ref: `'Participant'`, nullable)
- `createdAt`, `updatedAt`: `Date`

**Indexes:** `{ tokenHash: 1 }` (`tokenHash_unique` — unique), `{ participantId: 1, usedAt: 1, revokedAt: 1 }`, `{ intendedEmail: 1, usedAt: 1, revokedAt: 1, expiresAt: 1 }` (`intendedEmail_pending_idx`), `{ tripId: 1, participantId: 1, createdAt: -1 }`

### 3.5 `Expenses` (`expenses`)
Stores the master expense header. Individual payments and participant shares are stored in `ExpensePayments` and `ExpenseShares`.
- `_id`: `ObjectId`
- `tripId`: `ObjectId` (ref: `'Trip'`, required, indexed)
- `title`: `String` (required, trimmed)
- `description`: `String` (optional)
- `category`: `Enum ['TRANSPORTATION', 'FUEL', 'ACCOMMODATION', 'FOOD_DRINKS', 'SNACKS_WATER', 'PARKING_TOLLS', 'ENTRY_FEES', 'ACTIVITIES', 'PACKAGE', 'SHOPPING', 'MISCELLANEOUS']`
- `amountPaisa`: `Number` (integer `> 0`, required)
- `isEstimated`: `Boolean` (default: `false` — supports Forgotten Expense Protection pending estimated expenses)
- `isPackage`: `Boolean` (default: `false` — identifies fixed per-person/package expenses in Family Mode)
- `packageConfig`: `{ ratePerUnitPaisa: Number, unitCount: Number }` (optional metadata when `isPackage === true`)
- `splitMethod`: `Enum ['EQUAL', 'CUSTOM', 'SELECTIVE', 'PER_FAMILY', 'WEIGHTED', 'PACKAGE']`
- `paymentMethod`: `Enum ['CASH', 'ESEWA', 'KHALTI', 'FONEPAY', 'BANK_TRANSFER', 'CARD', 'OTHER']` (default: `'CASH'`)
- `approvalStatus`: `Enum ['APPROVED', 'PENDING_APPROVAL', 'PENDING_CONFIRMATION', 'REJECTED']` (default: `'APPROVED'` when created by Organizer, `'PENDING_APPROVAL'` when submitted by Contributor, `'PENDING_CONFIRMATION'` when created as an estimated placeholder)
- `incurredAt`: `Date` (default: `Date.now`)
- `createdByParticipantId`: `ObjectId` (ref: `'Participant'`, required)
- `approvedByParticipantId`: `ObjectId` (ref: `'Participant'`, optional)
- `clientMutationId`: `String` (optional — UUID for offline PWA idempotency)
- `isDeleted`: `Boolean` (default: `false`)
- `deletedAt`: `Date` (optional)
- `createdAt`, `updatedAt`: `Date`

**Indexes:**
- `{ tripId: 1, isDeleted: 1, incurredAt: -1 }`
- `{ tripId: 1, clientMutationId: 1 }` (unique, sparse — prevents duplicate offline sync creation)

### 3.6 `ExpensePayments` (`expense_payments`)
Records who actually paid money toward an expense (supports single payer or multiple contributors per expense).
- `_id`: `ObjectId`
- `tripId`: `ObjectId` (ref: `'Trip'`, required, indexed)
- `expenseId`: `ObjectId` (ref: `'Expense'`, required, indexed)
- `participantId`: `ObjectId` (ref: `'Participant'`, required)
- `amountPaisa`: `Number` (integer `> 0`, required)
- `paymentMethod`: `Enum ['CASH', 'ESEWA', 'KHALTI', 'FONEPAY', 'BANK_TRANSFER', 'CARD', 'OTHER']`
- `paidAt`: `Date` (default: `Date.now`)
- `notes`: `String` (optional)

**Indexes:** `{ expenseId: 1 }`, `{ tripId: 1, participantId: 1 }`

### 3.7 `ExpenseShares` (`expense_shares`)
Records the exact integer paisa obligation assigned to each participant for an expense.
- `_id`: `ObjectId`
- `tripId`: `ObjectId` (ref: `'Trip'`, required, indexed)
- `expenseId`: `ObjectId` (ref: `'Expense'`, required, indexed)
- `participantId`: `ObjectId` (ref: `'Participant'`, required)
- `familyId`: `ObjectId` (ref: `'Family'`, optional — captured for audit clarity)
- `sharePaisa`: `Number` (integer `>= 0`, required)
- `weightUsed`: `Number` (optional — records weight or custom parameter used during calculation)

**Indexes:** `{ expenseId: 1 }`, `{ tripId: 1, participantId: 1 }`

### 3.8 `Settlements` (`settlements`)
Records direct reimbursements between participants (or family representatives). Never treated as an expense.
- `_id`: `ObjectId`
- `tripId`: `ObjectId` (ref: `'Trip'`, required, indexed)
- `settlementMode`: `Enum ['INDIVIDUAL', 'FAMILY']` (default: `'INDIVIDUAL'`)
- `fromParticipantId`: `ObjectId` (ref: `'Participant'`, required — sender/payer of reimbursement)
- `toParticipantId`: `ObjectId` (ref: `'Participant'`, required — receiver of reimbursement)
- `fromFamilyId`: `ObjectId` (ref: `'Family'`, optional)
- `toFamilyId`: `ObjectId` (ref: `'Family'`, optional)
- `amountPaisa`: `Number` (integer `> 0`, required)
- `paymentMethod`: `Enum ['CASH', 'ESEWA', 'KHALTI', 'FONEPAY', 'BANK_TRANSFER', 'CARD', 'OTHER']`
- `status`: `Enum ['PENDING', 'REPORTED', 'CONFIRMED', 'REJECTED']` (default: `'REPORTED'`)
- `referenceNote`: `String` (optional)
- `settledAt`: `Date` (default: `Date.now`)
- `reportedByParticipantId`: `ObjectId` (ref: `'Participant'`, required)
- `confirmedByParticipantId`: `ObjectId` (ref: `'Participant'`, optional)
- `confirmedAt`: `Date` (optional)
- `isDeleted`: `Boolean` (default: `false`)
- `createdAt`, `updatedAt`: `Date`

**Indexes:** `{ tripId: 1, status: 1, isDeleted: 1 }`, `{ tripId: 1, fromParticipantId: 1 }`, `{ tripId: 1, toParticipantId: 1 }`

### 3.9 `ActivityLogs` (`activity_logs`)
Immutable audit trail of important financial and structural actions within a trip.
- `_id`: `ObjectId`
- `tripId`: `ObjectId` (ref: `'Trip'`, required, indexed)
- `actorUserId`: `ObjectId` (ref: `'User'`, optional)
- `actorParticipantId`: `ObjectId` (ref: `'Participant'`, optional)
- `actorName`: `String` (required)
- `actionType`: `String` (e.g., `'TRIP_CREATED'`, `'EXPENSE_ADDED'`, `'EXPENSE_EDITED'`, `'EXPENSE_APPROVED'`, `'SETTLEMENT_REPORTED'`, `'SETTLEMENT_CONFIRMED'`, `'TRIP_CLOSED'`)
- `entityType`: `Enum ['TRIP', 'PARTICIPANT', 'PARTICIPANT_INVITE', 'FAMILY', 'EXPENSE', 'SETTLEMENT']`
- `entityId`: `ObjectId`
- `summary`: `String` (human-readable audit message)
- `metadata`: `Mixed` (JSON snapshot of before/after values in paisa)
- `createdAt`: `Date` (indexed)

### 3.10 `RateLimitBuckets` (`rate_limit_buckets`)
Shared fixed-window HTTP rate-limit counter buckets when `RATE_LIMIT_STORE=mongo` (default in production for multi-instance topologies).
- `_id`: `ObjectId`
- `key`: `String` (required, unique — `<limiter-prefix><client-key>:<windowStartMs>`)
- `hits`: `Number` (default: `0`, integer counter)
- `expiresAt`: `Date` (required — window expiration timestamp for MongoDB TTL cleanup)

**Indexes:** `{ key: 1 }` (unique), `{ expiresAt: 1 }` (TTL with `expireAfterSeconds: 0`)

---

## 4. Database Migrations & Safe Deployment Procedure

### Guarantee Boundaries
- **Database-enforced (MongoDB indexes):** uniqueness of `users.email`, `users.emailVerificationTokenHash_partial_unique`, `trips.inviteCode`, `trips.shareToken`, `participants.tripId_1_userId_partial_unique`, and `participantinvites.tokenHash_unique`. Collections do not currently install MongoDB `$jsonSchema` validators.
- **Application-enforced (`@tripledger/shared` & Mongoose models):** `ParticipantInvite` privileged-role verified-email requirements, expiration checks, SHA-256 hash format checks, immutable policy-field guards on document/query updates, single-use/revocation consistency, `Trip.defaultInviteRole = 'PARTICIPANT'`, and serialized sole-active-linked-organizer enforcement (`role: 'ORGANIZER'`, `isActive: true`, `userId: { $type: 'objectId' }`) via replica-set transactions (with parent `Trip` write-lock serialization) or non-production standalone MongoDB distributed lease + compensating rollback (production fails closed with `503 TRANSACTIONS_UNAVAILABLE` on standalone servers). Direct MongoDB shell/driver writes bypass Mongoose validation and hooks.

### Registered Migration Commands (`migrateParticipantUserIndex`)
All migration CLI runs connect with `autoIndex: false` so read-only audits never create indexes and duplicate/malformed audits execute strictly prior to index DDL. Note that when Mongoose `autoIndex` is disabled in production, application startup (`bootstrap`) only runs `ensureRateLimitIndexes()` for `rate_limit_buckets` and does **not** automatically build `users.emailVerificationTokenHash_partial_unique` or `participants.tripId_1_userId_partial_unique`. Operators must explicitly run the migration and audit commands against target `MONGODB_URI` (committing migration code alone does not modify live databases).

- **Production (requires prior `npm run build`):**
  - Read-only pre-flight audit: `npm run migrate:participant-audit` (`node dist/migrations/migrateParticipantUserIndex.js --audit-only`)
  - Execute migration & default backfill: `npm run migrate:participant-user-index` (`node dist/migrations/migrateParticipantUserIndex.js`)
- **Development (`tsx`):**
  - Read-only pre-flight audit: `npm run migrate:participant-audit:dev`
  - Execute migration & default backfill: `npm run migrate:participant-user-index:dev`

### Required Production Rollout Sequence
1. **Audit (read-only):** Build the server (`npm run build:shared && npm run build:server`) and run `npm run migrate:participant-audit` against the target `MONGODB_URI`. Review `unverifiedUsersCount`, `unlinkedPrivilegedGuestsWithEmailCount`, `unlinkedPrivilegedGuestsCount`, `nonCreatorUnverifiedPrivilegedLinks`, and the read-only index presence flags (`participantsTripUserPartialIndexPresent`, `usersVerificationTokenPartialIndexPresent`, `rateLimitBucketIndexesPresent`, `participantInvitesIndexesPresent`).
2. **Resolve duplicate or malformed records manually:** If a dry/migration run reports duplicate `(tripId, userId)` `Participant` pairs, duplicate non-empty `Users.emailVerificationTokenHash` values, or malformed non-ObjectId `userId` entries, it **aborts before changing indexes** and never automatically deletes or merges rows. Operators must manually inspect and reconcile any `ExpensePayment`, `ExpenseShare`, `Settlement`, `Family.representativeId`, and `ActivityLog` references before removing or consolidating duplicate rows.
3. **Run migration:** Execute `npm run migrate:participant-user-index`. This safely creates `participants.tripId_1_userId_partial_unique`, verifies readiness, drops only the legacy non-unique `tripId_1_userId_1` index, ensures `users.emailVerificationTokenHash_partial_unique`, `rate_limit_buckets`, and `participantinvites` (`tokenHash_unique`, pending email/participant lookup, and trip history) indexes exist (safe with `autoIndex: false`), normalizes empty-string `userId` / `emailVerificationTokenHash` fields to `null`, initializes missing `User.emailVerified: false` (never auto-verifying legacy accounts), and initializes missing `Trip.inviteEnabled: true` / `Trip.defaultInviteRole: 'PARTICIPANT'`.
4. **Verify indexes & state:** Re-run `npm run migrate:participant-audit` and confirm all four index presence booleans report `true` and `tripId_1_userId_1` is absent (repeating the migration is idempotent).
5. **Deploy application code:** Validate environment configuration (`NODE_ENV=production`, `https://` non-loopback `CLIENT_URL`, `EMAIL_PROVIDER=SMTP|WEBHOOK`, `RATE_LIMIT_STORE=mongo`, valid `TRUST_PROXY`, strong `JWT_*_SECRET`s) and start the updated server processes (`npm start`).

*(Phase 3 alignment complete: `TripSummaryEntity.inviteCode` is optional and populated only for `ORGANIZER` responses; guest participant creation is restricted to `PARTICIPANT`, and privileged `ORGANIZER`/`FAMILY_REP` promotions occur exclusively via verified `ParticipantInvite` redemption.)*
