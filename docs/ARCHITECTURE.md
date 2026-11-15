# TripLedger — System Architecture

## 1. Architectural Overview

TripLedger is built as a modular TypeScript monorepo using npm workspaces (`packages/shared`, `server`, `client`). This architecture guarantees a single source of truth for financial calculations, domain invariants, and validation schemas across both the Node.js/Express API and the offline-capable React PWA.

```mermaid
flowchart TD
    subgraph Client["Client PWA (React + Vite + TypeScript)"]
        UI["Mobile-First UI (Tailwind + shadcn patterns)"]
        State["TanStack Query + Zustand Store"]
        OfflineQueue["IndexedDB Offline Expense Queue"]
        SW["Workbox Service Worker (App Shell + API Cache)"]
    end

    subgraph Shared["@tripledger/shared (Pure TypeScript Domain)"]
        FinanceEngine["Financial Calculation & Settlement Engine"]
        ZodSchemas["Zod Validation Contracts"]
        CurrencyUtils["Integer Paisa / NPR Formatter"]
    end

    subgraph Server["Backend API (Node.js + Express + TypeScript)"]
        SecurityMW["Security Layer (Helmet, CORS, Rate Limit, JWT Auth)"]
        RBAC["Trip-Scoped RBAC Middleware"]
        Controllers["REST Controllers"]
        Services["Domain Services & Idempotency Handler"]
        Models["Mongoose Repositories & Models"]
    end

    subgraph Database["MongoDB"]
        Collections[("Normalized Collections\n(Users, Trips, Participants, Families,\nExpenses, ExpensePayments, ExpenseShares,\nSettlements, ActivityLogs)")]
    end

    UI --> State
    State --> OfflineQueue
    UI --> FinanceEngine
    UI --> ZodSchemas
    State -->|REST JSON + HTTP-Only Cookies| SecurityMW
    OfflineQueue -->|Idempotent Sync (clientMutationId)| SecurityMW
    SecurityMW --> RBAC
    RBAC --> Controllers
    Controllers --> ZodSchemas
    Controllers --> Services
    Services --> FinanceEngine
    Services --> Models
    Models --> Collections
```

---

## 2. Monorepo Folder Structure

```text
tripledger/
├── package.json                        # Root workspace scripts & devDependencies
├── tsconfig.base.json                  # Strict shared TypeScript compiler configuration
├── .env.example                        # Environment variable template
├── .gitignore                          # Git exclusion rules
├── README.md                           # Project overview & setup guide
├── CONTRIBUTING.md                     # Engineering rules & commit conventions
├── docs/                               # Architectural & technical documentation
│   ├── ARCHITECTURE.md
│   ├── DATABASE.md
│   ├── FINANCIAL-LOGIC.md
│   ├── API.md
│   └── DEVELOPMENT-ROADMAP.md
├── packages/
│   └── shared/                         # @tripledger/shared workspace
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── constants/              # Roles, categories, statuses, modes
│           ├── currency/               # NPR <-> integer paisa conversion & formatting
│           ├── schemas/                # Shared Zod validation schemas (Auth, Trip, Expense, Settlement)
│           ├── types/                  # Domain TypeScript interfaces
│           └── finance/                # Pure, framework-agnostic Financial Calculation Engine
│               ├── index.ts
│               ├── splitting.ts        # Equal, Custom, Selective, Per-Family, Weighted, Package splits
│               ├── balances.ts         # Individual & Family-level balance ledger aggregation
│               ├── settlements.ts      # Min-transfer debt simplification & partial settlement reconciliation
│               ├── invariants.ts       # Automated financial invariant assertions
│               └── __tests__/          # Comprehensive unit & property tests for financial math
├── server/                             # @tripledger/server workspace
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                    # Entry point & graceful shutdown
│       ├── app.ts                      # Express app setup, security middleware & routes
│       ├── config/                     # Env validation & MongoDB connection (with memory-server test support)
│       ├── middleware/                 # Auth (JWT), Trip RBAC guard, Error handler, Zod validator
│       ├── models/                     # Normalized Mongoose models (9 collections)
│       ├── services/                   # Business services (Auth, Trip, Expense, Settlement, Report, Activity)
│       ├── controllers/                # Express route handlers
│       ├── routes/                     # Versioned API routers (/api/v1/...)
│       ├── utils/                      # AppError, asyncHandler, token helpers, PDF/Excel generators
│       └── __tests__/                  # Supertest API & RBAC integration tests
├── client/                             # @tripledger/client workspace
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts                  # Vite + VitePWA configuration
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api/                        # Axios/fetch client with automatic token refresh
│       ├── components/
│       │   ├── ui/                     # Reusable design system primitives (Button, Dialog, Input, Badge, etc.)
│       │   ├── layout/                 # Mobile bottom nav, responsive sidebar, offline banner
│       │   ├── trips/                  # Trip cards, participant/family selectors, forgotten-expense checklist
│       │   ├── expenses/               # Quick-Add Expense drawer, multi-payer editor, split configurator
│       │   ├── settlements/            # Settlement suggestion cards, partial payment modal, history
│       │   └── reports/                # Category breakdown charts, PDF/Excel export triggers, share view
│       ├── hooks/                      # TanStack Query hooks & offline sync hook
│       ├── pages/                      # Route screens (Dashboard, Friends Trips, Family Trips, Trip Detail, etc.)
│       ├── stores/                     # Auth store & IndexedDB/LocalStorage Offline Expense Queue
│       └── utils/                      # Export & formatting utilities
└── e2e/                                # Playwright E2E test suite
```

---

## 3. Role-Based Access Control (RBAC) Architecture

TripLedger distinguishes between **Platform Identity** (`User`) and **Trip Membership** (`Participant`).
- A trip always has at least one `ORGANIZER` (linked to the creator's `User` account).
- Participants in a trip can be **Guest Participants** (`userId: null`) or **Linked Users** (`userId: ObjectId`).
- Every trip-scoped request runs through the `requireTripRole(allowedRoles)` middleware, which resolves the caller's `Participant` record for that `:tripId` and verifies permissions on the server.

| Capability | Organizer | Contributor | Family Representative | Participant | Public Share Token |
| :--- | :---: | :---: | :---: | :---: | :---: |
| Create / Edit / Close Trip | Yes | No | No | No | No |
| Add / Edit Participants & Families | Yes | No | No | No | No |
| Create Approved Expense Directly | Yes | No | No | No | No |
| Submit Expense / Payment (Pending Approval) | Yes | Yes | Yes | No | No |
| Edit Own Unapproved Expense | Yes | Yes | Yes | No | No |
| Approve / Reject Submitted Expense | Yes | No | No | No | No |
| Report a Settlement Payment | Yes | Yes | Yes (Family) | Yes (Own) | No |
| Confirm / Reject Settlement | Yes | Receiver Only | Receiver Family Rep | Receiver Only | No |
| View Trip Ledger & Balances | Yes | Yes | Yes | Yes | Read-Only Summary |

---

## 4. PWA & Offline Synchronization Strategy

1. **Application Shell & Read Caching:** `vite-plugin-pwa` (Workbox) caches static assets (`index.html`, JS/CSS bundles, fonts, icons) and caches `GET /api/v1/trips/*` responses using a `NetworkFirst` strategy so previously visited trips remain inspectable offline.
2. **Offline Expense Queue:**
   - When `navigator.onLine === false` (or a network timeout occurs during expense creation), the client generates a UUID v4 `clientMutationId` and stores the expense payload in an IndexedDB/persistent queue (`offlineExpenseQueue`).
   - Optimistic UI displays the queued expense in the trip view with a `"Queued Offline"` badge.
   - When connectivity returns (`window.addEventListener('online')`), the sync worker replays queued expenses sequentially to `POST /api/v1/trips/:tripId/expenses`.
3. **Server-Side Idempotency:**
   - The `Expense` collection enforces a unique compound index on `{ tripId: 1, clientMutationId: 1 }` (sparse).
   - If the client retries a request that already succeeded on the server, the server detects the existing `(tripId, clientMutationId)` document and returns `200 OK` with the existing record instead of creating a duplicate expense.

---

## 5. UI/UX Design System Direction

- **Aesthetic Persona:** High-Craft Financial Ledger — clean, crisp, trustworthy, and tailored for quick thumb-driven mobile entry during a trip as well as structured desktop review afterward.
- **Color Palette:**
  - Primary Brand: Deep Himalayan Indigo / Slate (`#0F172A` surface accents, `#2563EB` primary interactive).
  - Semantic Financial Tokens:
    - Positive Balance (To Receive): Emerald (`#059669` text, `#ECFDF5` badge surface).
    - Negative Balance (You Owe): Rose/Crimson (`#E11D48` text, `#FFF1F2` badge surface).
    - Settled / Neutral: Slate (`#475569` text, `#F1F5F9` badge surface).
    - Pending / Unapproved / Offline Queue: Amber (`#D97706` text, `#FFFBEB` badge surface).
- **Typography:**
  - UI & Headings: `Inter` / system geometric sans-serif.
  - Financial Figures: `tabular-nums` (`font-variant-numeric: tabular-nums`) mandatory on every currency display so columns, split rows, and balance tables align to the paisa.
- **Navigation Architecture:**
  - **Mobile (`< 768px`):** Fixed bottom navigation bar with 5 core destinations (*Dashboard*, *Friends*, *Family*, *Balances*, *More/History*) + prominent Quick-Add Expense trigger.
  - **Desktop (`>= 768px`):** Clean left navigation rail (`240px`) with main workspace canvas (`max-width: 1200px`).
