# Contributing to TripLedger

Thank you for contributing to **TripLedger**. Because TripLedger handles multi-party financial calculations and settlements, we enforce strict engineering, testing, and commit standards.

---

## 1. Core Engineering Principles

1. **Integer Paisa Everywhere:** Never use floating-point numbers for currency storage or calculation. All amounts are stored and calculated in integer paisa (`NPR 1.00 = 100 paisa`). Convert to NPR strictly at the presentation/input boundary.
2. **Financial Logic Isolation:** Never place financial splitting, balance aggregation, or settlement calculation logic inside React components or Express controllers. All financial logic lives in `packages/shared/src/finance/` and is consumed by both backend and frontend.
3. **Strict Financial Separation:**
   - **Expenses** record total cost and metadata.
   - **ExpensePayments** record who paid toward an expense.
   - **ExpenseShares** record who owes how much for an expense.
   - **Settlements** record direct reimbursements between participants. Never model a settlement as a negative expense.
4. **No Silent Rounding Loss:** Every splitting strategy must deterministically distribute any remainder paisa so that `sum(shares) === expense.amountPaisa` and `sum(payments) === expense.amountPaisa`.

---

## 2. Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <short imperative description>
```

### Allowed Types
- `feat`: A complete, verified new feature or milestone
- `fix`: A bug fix
- `test`: Adding or updating automated tests
- `docs`: Documentation changes
- `refactor`: Code restructuring without changing external behavior
- `chore`: Build scripts, dependencies, or tooling configuration

### Allowed Scopes
- `shared`, `finance`, `auth`, `trips`, `participants`, `family`, `expenses`, `payments`, `splitting`, `settlement`, `reports`, `pwa`, `ui`, `docs`, `repo`

### Commit Granularity Rules
- Commit only when a feature or milestone is **complete, typechecked, and verified by tests**.
- Never commit broken builds, failing tests, or `.env` secrets.
- Always update `docs/DEVELOPMENT-ROADMAP.md` when completing a milestone.

---

## 3. Pre-Commit Verification Checklist

Before creating any commit, run:

```bash
npm run typecheck
npm run lint
npm test
git status
git diff --staged
```
