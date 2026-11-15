# TripLedger — Development Roadmap & Engineering Log

## Current Status
- **Active Phase:** Phase 6 & 7 Backend Complete -> Building Complete Frontend PWA, Offline Queue & Exports (Phases 7-8)
- **Last Updated:** 2026-11-15

---

## Architectural Decision Records (ADRs)

### ADR-001: NPM Workspaces Monorepo (`@tripledger/shared`, `server`, `client`)
- **Context:** Rule 5 & 6 require that financial business logic never live inside UI components or API controllers, while both the backend API and the offline-capable PWA frontend need deterministic expense splitting and validation.
- **Decision:** Extract all financial calculation strategies, invariant checks, currency conversion utilities, and Zod validation schemas into `packages/shared` (`@tripledger/shared`).
- **Consequence:** Zero duplication between client and server; 100% unit-testable pure TypeScript financial engine.

### ADR-002: Integer Paisa Representation & Canonical Largest-Remainder Rounding
- **Context:** Floating-point arithmetic causes rounding drift (`NPR 100 / 3 * 3 = 99.99`).
- **Decision:** Store and calculate all monetary values as integer paisa (`1 NPR = 100 paisa`). Distribute division remainders deterministically using the Largest Remainder method with canonical `participantId` tie-breaking.
- **Consequence:** `sum(shares) === expense.amountPaisa` and `sum(balances) === 0` hold universally without losing a single paisa.

### ADR-003: Single Unified Ledger for Individual & Family Modes
- **Context:** Family Mode requires both individual member balances and family-level aggregate balances that always reconcile.
- **Decision:** Even when an expense is split `PER_FAMILY`, the engine allocates the family share and immediately distributes it deterministically across that family's participating members in `ExpenseShares`. Family balances are computed strictly as the sum of member balances.
- **Consequence:** Individual and family settlement views are mathematically guaranteed to reconcile.

### ADR-004: MongoDB Connection Strategy for Local Development & Automated Testing
- **Context:** On the local Windows machine, MongoDB Server 7.0 is installed (`C:\Program Files\MongoDB\Server\7.0\bin\mongod.exe`) with the Windows Service stopped by default (requires admin privileges to start the service).
- **Decision:** Support standard `MONGODB_URI` connection out-of-the-box, can spawn a local `mongod` instance pointing to an excluded `.data/mongodb` directory during local runs, and use `mongodb-memory-server` for isolated, deterministic integration tests.

---

## Phase-by-Phase Checklist

### Phase 0 — Project Planning & Documentation
- [x] Inspect workspace, Node/npm versions, MongoDB installation, and GitHub CLI authentication.
- [x] Design monorepo architecture and folder structure (`docs/ARCHITECTURE.md`).
- [x] Design normalized 9-collection MongoDB schema and ER diagram (`docs/DATABASE.md`).
- [x] Specify integer-paisa financial calculation model and 8 invariants (`docs/FINANCIAL-LOGIC.md`).
- [x] Specify REST API contracts and RBAC matrix (`docs/API.md`).
- [x] Create root `.gitignore`, `.env.example`, `README.md`, and `CONTRIBUTING.md`.
- [x] Initialize Git repository, create public GitHub repository `tripledger`, and push initial documentation commit.

### Phase 1 — Project Foundation & Financial Calculation Engine
- [x] Configure root `package.json` workspaces and `tsconfig.base.json`.
- [x] Implement `@tripledger/shared`:
  - [x] NPR <-> integer paisa currency utilities.
  - [x] Equal, Selective, Custom, Weighted, Per-Family, and Fixed Package splitting strategies.
  - [x] Multi-payer contribution validator.
  - [x] Individual and Family balance calculator.
  - [x] Minimum-transfer settlement optimization algorithm & partial settlement handler.
  - [x] Automated financial invariant verifier (`verifyLedgerInvariants`).
  - [x] Comprehensive Vitest unit test suite covering all 8 mandatory financial invariants.
- [x] Initialize `@tripledger/server` foundation (Express, TypeScript, Mongoose models, security middleware, error handling).
- [x] Initialize `@tripledger/client` foundation (React, Vite, TypeScript, Tailwind CSS, design system tokens).

### Phase 2 — Authentication, Users & RBAC
- [x] Implement user registration, login, refresh token rotation, logout, and profile endpoints.
- [x] Implement JWT authentication middleware and trip-scoped RBAC authorization (`ORGANIZER`, `CONTRIBUTOR`, `FAMILY_REP`, `PARTICIPANT`).
- [x] Support guest participants (`userId: null`) and optional account linking via invite code/email.
- [x] Build frontend authentication screens (Login, Register) and protected route guards.
- [x] Write Supertest integration tests for Auth and RBAC enforcement.

### Phase 3 — Trip Management & Forgotten Expense Protection
- [x] Implement Friends Mode and Family Mode trip creation, status lifecycle (`PLANNING`, `ACTIVE`, `REVIEW`, `CLOSED`), and budget tracking.
- [x] Implement guest participant management and invite code joining.
- [x] Implement Forgotten Expense Protection checklist (10 trip categories, pending/estimated expense verification, pre-close review).
- [x] Build Dashboard, Friends Trips, Family Trips, and Trip Creation API flows.
- [x] Write integration tests for trip lifecycle and participant management.

### Phase 4 — Expense Engine & Multiple Payers
- [x] Implement expense creation, editing, soft-deletion, and categorization.
- [x] Support single payer and multiple contributors (`ExpensePayments`) per expense.
- [x] Support Equal, Custom, and Selective splitting in Friends Mode.
- [x] Support estimated/pending expenses (`isEstimated: true`, `PENDING_CONFIRMATION`) and resolution.
- [x] Build expense REST endpoints and idempotency verification.
- [x] Write integration tests for expense creation, multi-payer validation, editing recalculation, and soft deletion.

### Phase 5 — Family Mode (Groups, Representatives, Packages & Approval Workflow)
- [x] Implement Family group CRUD, member assignment (`ADULT`, `CHILD`, `DEPENDENT`), configurable weights, and Representative assignment.
- [x] Implement `PER_FAMILY`, `WEIGHTED`, and fixed per-person `PACKAGE` expense splitting.
- [x] Implement hybrid family payment workflow (Organizer default payer, Contributor submissions, Organizer approval/rejection).
- [x] Build Family Mode ledger calculations (package vs. additional expenses, reconciled family + individual balances).
- [x] Write integration tests for Family Mode workflows, package expenses, and family/individual balance reconciliation.

### Phase 6 — Settlements Engine & Workflow
- [x] Implement Individual and Family-level settlement views and minimum-transfer suggestions.
- [x] Implement partial and full settlement reporting (`PENDING`, `REPORTED`, `CONFIRMED`, `REJECTED`).
- [x] Ensure only `CONFIRMED` settlements reduce confirmed outstanding balances while preserving original expenses.
- [x] Write integration tests verifying partial settlements, confirmation workflow, and zero-sum post-settlement invariants.

### Phase 7 — Reporting, Exports & Shareable Summaries
- [x] Implement trip financial summary, category breakdown, contribution breakdown, and activity audit log endpoints.
- [x] Implement sanitized read-only public share link (`/shared/:shareToken`) that strips private user details.
- [x] Write tests verifying report accuracy and privacy sanitization on public share endpoints.

### Phase 8 — PWA & Offline Expense Queue
- [ ] Configure `vite-plugin-pwa`, Web App Manifest, icons, and Workbox service worker shell caching.
- [ ] Implement offline expense-entry queue with client-generated UUID (`clientMutationId`).
- [ ] Implement automatic background/online synchronization and server-side idempotency deduplication.
- [ ] Build Offline Status Indicator, Queued Expenses drawer, and manual sync trigger.
- [ ] Write tests verifying idempotent offline expense synchronization without duplicates.

### Phase 9 — End-to-End Quality Assurance & Final Verification
- [ ] Run complete Vitest unit and Supertest integration test suites.
- [ ] Run Playwright E2E test suite verifying Friends Mode, Family Mode, Multi-payer, Settlements, and Offline Queue.
- [ ] Perform security audit (headers, rate limits, secret exclusion, RBAC checks) and production build verification.
- [ ] Finalize `README.md` and `docs/DEVELOPMENT-ROADMAP.md`.

---

## Known Issues & Risks Log
- *None currently open.*
