# TripLedger — Financial Calculation Engine Specification

## 1. Fundamental Representation: Integer Paisa

Floating-point numbers (`IEEE 754`) cannot accurately represent decimal fractions (`0.1 + 0.2 !== 0.3`). In TripLedger:
- **Internal Unit:** Every monetary value is represented as an integer in **paisa** (`1 NPR = 100 paisa`).
- **Conversion Boundaries:**
  - User input in NPR (e.g., `NPR 3,450.50`) is parsed via `nprToPaisa("3450.50") -> 345050`.
  - Stored and calculated values are strictly safe integers (`Number.isSafeInteger(val)`).
  - Presentation uses `formatPaisaToNPR(345050) -> "NPR 3,450.50"` (or `"NPR 3,450"` when `.00` is omitted in compact views).

---

## 2. Deterministic Remainder Distribution (No Lost Paisa)

When dividing `amountPaisa` across $N$ shares (either equally or proportionally by weights), integer division produces a remainder:

$$R = \text{amountPaisa} - \sum_{i=1}^{N} \lfloor s_i \rfloor, \quad 0 \le R < N$$

TripLedger uses the **Deterministic Largest-Remainder / Canonical Tie-Breaking Algorithm**:
1. Compute the exact rational quota $q_i$ for each participant $i$.
2. Assign the integer floor $\lfloor q_i \rfloor$ to each participant.
3. Compute the fractional remainder $f_i = q_i - \lfloor q_i \rfloor$ (using integer numerator comparisons so no float inaccuracy occurs).
4. Sort participants by:
   - Descending fractional remainder $f_i$, then
   - Canonical participant sort key (`participantId` lexicographical order) for deterministic tie-breaking.
5. Distribute $+1\text{ paisa}$ to each of the first $R$ participants in that sorted order.

**Guarantee:** $\sum_{i=1}^{N} \text{sharePaisa}_i === \text{amountPaisa}$ under all inputs.

---

## 3. Expense Splitting Strategies

Every expense independently specifies its `splitMethod`:

### 3.1 `EQUAL` (Per-Person Equal Split)
Splits `amountPaisa` equally among all active (or selected) participants $P = \{p_1, \dots, p_k\}$:
- Base share: $\lfloor \text{amountPaisa} / k \rfloor$
- Remainder: $\text{amountPaisa} \pmod k$ distributed +1 paisa each to the first $R$ participants sorted by `participantId`.

### 3.2 `SELECTIVE` (Selective Participant Equal Split)
Identical math to `EQUAL`, restricted to the explicit non-empty subset of included `participantIds`. Excluded participants receive `0` share.

### 3.3 `CUSTOM` (Exact Custom Amounts)
Each included participant is assigned an explicit `customAmountPaisa`.
- **Validation Rule:** $\sum \text{customAmountPaisa}_i === \text{amountPaisa}$. If the sum differs by even 1 paisa, the engine rejects the split with a clear validation error showing the exact difference.

### 3.4 `WEIGHTED` (Configurable Weight Split)
Each included participant $i$ has a non-negative rational weight $w_i > 0$ (defaults to `participant.defaultWeight`, overridable per expense).
- Total weight $W = \sum w_i$ (scaled to integer basis points `weight * 10000` to avoid floats).
- Exact quota $q_i = \frac{\text{amountPaisa} \times W_i}{W}$.
- Floor shares + Largest Remainder with canonical `participantId` tie-breaking.

### 3.5 `PER_FAMILY` (Family-Level Equal or Weighted Allocation -> Individual Shares)
To maintain a single unified ledger where **family balances are always the exact sum of their members' individual balances** (preventing dual-ledger reconciliation bugs):
1. First, `amountPaisa` is divided across the participating families $F = \{f_1, \dots, f_m\}$ (equally or by family share).
2. Next, each family's allocated amount $A_{f_j}$ is deterministically distributed across the active participating members of family $f_j$ (using the same canonical remainder rule).
3. If an individual participant has no `familyId` (an ungrouped individual in a Family Mode trip), they are treated as a 1-person family unit if included.
4. **Result:** Summing the `ExpenseShares` of all members in family $f_j$ equals $A_{f_j}$ to the exact paisa, and summing all shares across the expense equals `amountPaisa`.

### 3.6 `PACKAGE` (Fixed Per-Person / Unit Package)
Designed for resort packages, bus seats, or fixed tour rates:
- Given `ratePerPersonPaisa` and a list of $k$ included `participantIds`:
- Each included participant receives `sharePaisa = ratePerPersonPaisa`.
- Total `amountPaisa = ratePerPersonPaisa * k`.

---

## 4. Balance Calculation Model

For any trip, only **active (`!isDeleted`) and approved (`approvalStatus === 'APPROVED'`)** expenses and **confirmed (`status === 'CONFIRMED' && !isDeleted`)** settlements affect confirmed balances. (An optional preview flag allows viewing projected balances including `PENDING_APPROVAL` or `PENDING_CONFIRMATION` expenses).

### 4.1 Pre-Settlement Net Balance (Per Participant $p$)

$$\text{totalPaidPaisa}(p) = \sum_{e \in \text{ApprovedExpenses}} \text{payment}(e, p)$$

$$\text{totalSharePaisa}(p) = \sum_{e \in \text{ApprovedExpenses}} \text{share}(e, p)$$

$$\text{netExpenseBalancePaisa}(p) = \text{totalPaidPaisa}(p) - \text{totalSharePaisa}(p)$$

### 4.2 Post-Settlement Outstanding Balance (Per Participant $p$)
When participant $p$ sends a confirmed settlement to someone else, $p$ is paying down their debt (so their balance moves toward zero / increases by the payment sent). When $p$ receives a confirmed settlement, $p$ is being reimbursed (so their receivable decreases toward zero):

$$\text{settlementsSentPaisa}(p) = \sum_{s \in \text{ConfirmedSettlements}, \text{from}=p} s.\text{amountPaisa}$$

$$\text{settlementsReceivedPaisa}(p) = \sum_{s \in \text{ConfirmedSettlements}, \text{to}=p} s.\text{amountPaisa}$$

$$\text{outstandingBalancePaisa}(p) = \text{netExpenseBalancePaisa}(p) + \text{settlementsSentPaisa}(p) - \text{settlementsReceivedPaisa}(p)$$

- **$\text{outstandingBalancePaisa}(p) > 0$:** Participant $p$ is still owed money (Creditor).
- **$\text{outstandingBalancePaisa}(p) < 0$:** Participant $p$ still owes money (Debtor).
- **$\text{outstandingBalancePaisa}(p) === 0$:** Participant $p$ is completely settled.

### 4.3 Family-Level Balance Aggregation
For any Family $F$ with member set $M_F$:

$$\text{familyPaidPaisa}(F) = \sum_{p \in M_F} \text{totalPaidPaisa}(p)$$

$$\text{familySharePaisa}(F) = \sum_{p \in M_F} \text{totalSharePaisa}(p)$$

$$\text{familyOutstandingBalancePaisa}(F) = \sum_{p \in M_F} \text{outstandingBalancePaisa}(p)$$

Because family balances are strictly defined as the algebraic sum of their members' balances:
- Intra-family payments or intra-family shares automatically cancel out at the family aggregate level.
- Family-level balances and individual member balances **always reconcile to the exact paisa**.

---

## 5. Minimum-Transfer Settlement Optimization Algorithm

Given a vector of outstanding balances $\{b_1, b_2, \dots, b_n\}$ where $\sum_{i=1}^{n} b_i = 0$:
1. Partition entities (either Individual Participants or Families, depending on the requested settlement view) into:
   - **Debtors:** $D = \{ i \mid b_i < 0 \}$ with debt magnitude $d_i = -b_i > 0$.
   - **Creditors:** $C = \{ j \mid b_j > 0 \}$ with credit magnitude $c_j = b_j > 0$.
2. At each step:
   - Sort $D$ descending by $d_i$ (tie-break by canonical ID).
   - Sort $C$ descending by $c_j$ (tie-break by canonical ID).
   - If an exact match $d_i === c_j$ exists, pair $(i \to j)$ for amount $d_i$ first (reduces total transfer count by settling two parties in one transaction).
   - Otherwise, pair the largest debtor $i^*$ with the largest creditor $j^*$ for transfer amount $t = \min(d_{i^*}, c_{j^*})$.
   - Emit suggested transfer: `from: i*, to: j*, amountPaisa: t`.
   - Update $d_{i^*} \leftarrow d_{i^*} - t$ and $c_{j^*} \leftarrow c_{j^*} - t$, removing whichever reaches `0`.
3. In **Family Settlement View**, each family's net balance $B_F = \sum_{p \in M_F} b_p$ is settled via the family's designated `representativeId` (or primary adult member if no representative is assigned yet).

---

## 6. Mandatory Financial Invariants

The `verifyLedgerInvariants(ledger)` function asserts all 8 invariants:
1. **Payment Completeness:** For every approved expense $e$, $\sum \text{payments}(e) === e.\text{amountPaisa}$.
2. **Share Completeness:** For every approved expense $e$, $\sum \text{shares}(e) === e.\text{amountPaisa}$.
3. **Zero-Sum Pre-Settlement Balances:** $\sum_{p \in \text{Participants}} \text{netExpenseBalancePaisa}(p) === 0$.
4. **Zero-Sum Post-Settlement Balances:** $\sum_{p \in \text{Participants}} \text{outstandingBalancePaisa}(p) === 0$.
5. **Individual-to-Family Reconciliation:** $\sum_{F \in \text{Families}} \text{familyOutstandingBalancePaisa}(F) + \sum_{u \in \text{Ungrouped}} \text{outstandingBalancePaisa}(u) === 0$, and for each family $F$, $B_F === \sum_{p \in M_F} b_p$.
6. **Settlement Isolation:** Recording, confirming, or rejecting a settlement never mutates any `Expense`, `ExpensePayment`, or `ExpenseShare` record.
7. **Expense Edit Recalculation:** Updating an expense's amount, payers, or split strategy atomically replaces its payments/shares and preserves all zero-sum invariants.
8. **Partial Settlement Accuracy:** A confirmed partial settlement of $k$ paisa from $A$ to $B$ increases $A$'s outstanding balance by $+k$, decreases $B$'s outstanding balance by $-k$, and the remaining suggested settlement transfers sum to the exact remaining debt.
