# TripLedger

> **Every rupee. Every person. Accounted for.**

TripLedger is a production-grade, mobile-first Progressive Web Application (PWA) designed for group trips, friends' outings, and multi-family vacations in Nepal. Built around an integer-paisa financial calculation engine, TripLedger eliminates manual spreadsheet reconciliation, forgotten trip expenses, and awkward settlement conversations.

---

## Core Vision & Operating Modes

TripLedger supports two distinct operating modes powered by a unified, invariant-checked financial ledger engine:

1. **Friends Mode** — Individual-centric expense tracking for road trips, college outings, treks, and shared meals. Supports guest participants (no mandatory account creation), multiple payers on a single expense, equal/custom/selective splitting, and minimum-transfer settlement suggestions.
2. **Family Mode** — Hierarchical group and individual tracking for multi-family vacations, pilgrimages, and family gatherings. Supports family groups with designated representatives, adult/child/dependent members, per-person vs. per-family vs. weighted splitting, fixed per-person resort/travel packages, hybrid payment workflows (organizer default payer + contributor submissions and approvals), and reconciled individual + family-level settlement views.

---

## Current Project Status

> **Current Phase:** Phase 0 (Architecture & Planning) & Phase 1 (Project Foundation)
> See [docs/DEVELOPMENT-ROADMAP.md](./docs/DEVELOPMENT-ROADMAP.md) for live progress and completed milestones.

### Implemented Milestones
- [x] Phase 0: System Architecture, Database Schema Design, Financial Engine Specification, API Specification, and Development Roadmap.
- [x] Phase 1: Monorepo Foundation (Frontend + Backend + Shared Domain + Financial Engine Core & Invariant Tests).
- [ ] Phase 2: Authentication, RBAC Authorization & Guest Participant Linking.
- [ ] Phase 3: Trip Management (Friends & Family Modes) & Forgotten Expense Protection Checklist.
- [ ] Phase 4: Expense Engine, Multiple Payers & Splitting Strategies.
- [ ] Phase 5: Family Mode Groups, Packages, Approval Workflow & Dual-Level Balances.
- [ ] Phase 6: Settlement Optimization Engine, Partial Settlements & Confirmation Workflow.
- [ ] Phase 7: Analytics, PDF/Excel Exports & Read-Only Shareable Trip Summaries.
- [ ] Phase 8: Installable PWA, Service Worker & Offline Expense Queue with Idempotent Sync.
- [ ] Phase 9: Comprehensive Unit, Integration, Financial Invariant & Playwright E2E QA.

---

## Technology Stack

| Layer | Technologies |
| :--- | :--- |
| **Frontend** | React 18, Vite, TypeScript, Tailwind CSS, shadcn/ui patterns, React Router v6, TanStack Query v5, Zustand, React Hook Form, Zod |
| **Backend** | Node.js, Express.js, TypeScript, Mongoose (MongoDB), Helmet, Express Rate Limit, Cookie Parser |
| **Shared / Domain** | Pure TypeScript Financial Calculation Engine (`@tripledger/shared`), Zod Validation Schemas, Integer Paisa Currency Utilities |
| **Database** | MongoDB 7.0 (Normalized collections with strict trip-level isolation and audit logging) |
| **Authentication** | JWT Access + HTTP-Only Refresh Token Rotation, bcrypt password hashing, Role-Based Access Control (Organizer, Contributor, Family Representative, Participant) |
| **PWA & Offline** | `vite-plugin-pwa`, Workbox Service Worker, IndexedDB Offline Expense Queue with `clientMutationId` idempotency |
| **Testing** | Vitest, React Testing Library, Supertest, `mongodb-memory-server`, Playwright E2E |

---

## Repository Structure

```text
tripledger/
├── packages/
│   └── shared/                 # Pure TypeScript financial engine, Zod schemas, NPR paisa utilities
├── server/                     # Express + TypeScript REST API & Mongoose models
├── client/                     # React + Vite + Tailwind mobile-first PWA
├── e2e/                        # Playwright end-to-end test suites
├── docs/
│   ├── ARCHITECTURE.md         # System architecture, security & PWA offline sync design
│   ├── DATABASE.md             # Normalized MongoDB schemas, indexes & ER diagrams
│   ├── FINANCIAL-LOGIC.md      # Integer paisa math, splitting rules, invariants & debt simplification
│   ├── API.md                  # REST API endpoint specifications & RBAC matrix
│   └── DEVELOPMENT-ROADMAP.md  # Phase-by-phase checklist & architectural decision log
├── .env.example                # Environment variable template
└── CONTRIBUTING.md             # Commit conventions, testing requirements & workflow
```

---

## Environment Setup & Installation

### Prerequisites
- **Node.js** `>= 20.x` (v24 recommended)
- **npm** `>= 10.x`
- **MongoDB** `>= 7.0` (Local service or MongoDB Atlas URI; tests and local fallback also support `mongodb-memory-server`)

### 1. Clone the Repository
```bash
git clone https://github.com/diretrix-git/tripledger.git
cd tripledger
```

### 2. Configure Environment Variables
```bash
cp .env.example .env
```
Update `.env` with your MongoDB connection string and JWT secrets.

### 3. Install Dependencies
```bash
npm install
```

### 4. Development Commands
*(Available starting in Phase 1)*
```bash
# Run shared package build, backend API, and frontend Vite dev server concurrently
npm run dev

# Run backend only
npm run dev:server

# Run frontend only
npm run dev:client

# Typecheck all workspaces
npm run typecheck

# Run unit & integration test suites (including financial invariants)
npm test

# Run Playwright E2E tests
npm run test:e2e

# Production build
npm run build
```

---

## Documentation Index

- [System Architecture](./docs/ARCHITECTURE.md)
- [Database Schema & ER Diagram](./docs/DATABASE.md)
- [Financial Calculation Engine & Invariants](./docs/FINANCIAL-LOGIC.md)
- [REST API Reference](./docs/API.md)
- [Development Roadmap & Decision Log](./docs/DEVELOPMENT-ROADMAP.md)
- [Contributing Guidelines](./CONTRIBUTING.md)
