import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import {
  EXPENSE_CATEGORY_LABELS,
  formatPaisaToNPR,
  paisaToNprNumber,
  PAYMENT_METHOD_LABELS,
  type ExpenseRecord,
  type FamilyBalanceSummary,
  type IndividualBalanceSummary,
  type SettlementRecord,
  type SettlementSuggestion,
  type TripSummaryEntity,
} from '@tripledger/shared';

interface ExportReportData {
  trip: TripSummaryEntity;
  totalApprovedExpensePaisa: number;
  totalPackageExpensePaisa: number;
  totalAdditionalExpensePaisa: number;
  individualBalances: IndividualBalanceSummary[];
  familyBalances: FamilyBalanceSummary[];
  expenses: ExpenseRecord[];
  settlements: SettlementRecord[];
  individualSettlementSuggestions: SettlementSuggestion[];
  familySettlementSuggestions: SettlementSuggestion[];
  participantNameMap: Map<string, string>;
}

/**
 * Generates and downloads a formatted PDF Trip Financial Statement.
 */
export function exportTripReportToPDF(data: ExportReportData): void {
  const doc = new jsPDF();
  const { trip } = data;

  // Header
  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42);
  doc.text(`TripLedger — ${trip.name}`, 14, 20);

  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  doc.text(
    `Mode: ${trip.mode === 'FAMILY' ? 'Family Mode' : 'Friends Mode'} | Status: ${trip.status} | Generated: ${new Date().toLocaleDateString()}`,
    14,
    27
  );
  doc.text(
    `Total Approved Expenditure: ${formatPaisaToNPR(data.totalApprovedExpensePaisa, { showDecimalsIfZero: true })}`,
    14,
    33
  );

  let currentY = 40;

  // Section 1: Family Balances (if Family Mode)
  if (trip.mode === 'FAMILY' && data.familyBalances.length > 0) {
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text('Family-Level Financial Summary', 14, currentY);

    autoTable(doc, {
      startY: currentY + 3,
      head: [['Family Group', 'Representative', 'Members', 'Total Paid', 'Total Share', 'Outstanding Balance']],
      body: data.familyBalances.map((f) => [
        f.familyName,
        f.representativeName ?? '-',
        String(f.memberCount),
        formatPaisaToNPR(f.totalPaidPaisa),
        formatPaisaToNPR(f.totalSharePaisa),
        formatPaisaToNPR(f.outstandingBalancePaisa, { showSign: true }),
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [15, 23, 42] },
    });

    currentY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
  }

  // Section 2: Individual Participant Balances
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text('Individual Participant Balances', 14, currentY);

  autoTable(doc, {
    startY: currentY + 3,
    head: [['Participant', 'Group', 'Total Paid', 'Expense Share', 'Net Settled', 'Outstanding']],
    body: data.individualBalances.map((b) => [
      b.participantName,
      b.familyName ?? 'Individual',
      formatPaisaToNPR(b.totalPaidPaisa),
      formatPaisaToNPR(b.totalSharePaisa),
      formatPaisaToNPR(b.settlementsSentPaisa - b.settlementsReceivedPaisa, { showSign: true }),
      formatPaisaToNPR(b.outstandingBalancePaisa, { showSign: true }),
    ]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: [37, 99, 235] },
  });

  currentY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;

  // Section 3: Recommended Settlements
  const suggestions =
    trip.mode === 'FAMILY' && data.familySettlementSuggestions.length > 0
      ? data.familySettlementSuggestions
      : data.individualSettlementSuggestions;

  if (suggestions.length > 0) {
    doc.setFontSize(12);
    doc.text('Recommended Settlement Transfers', 14, currentY);

    autoTable(doc, {
      startY: currentY + 3,
      head: [['From (Debtor)', 'To (Creditor)', 'Amount to Pay']],
      body: suggestions.map((s) => [
        s.fromFamilyName ? `${s.fromFamilyName} (${s.fromParticipantName})` : s.fromParticipantName,
        s.toFamilyName ? `${s.toFamilyName} (${s.toParticipantName})` : s.toParticipantName,
        formatPaisaToNPR(s.amountPaisa, { showDecimalsIfZero: true }),
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [5, 150, 105] },
    });

    currentY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
  }

  // Section 4: Expense History
  if (data.expenses.length > 0) {
    doc.setFontSize(12);
    doc.text('Approved Expense Ledger', 14, currentY);

    autoTable(doc, {
      startY: currentY + 3,
      head: [['Date', 'Title', 'Category', 'Split', 'Paid By', 'Amount']],
      body: data.expenses
        .filter((e) => e.approvalStatus === 'APPROVED')
        .map((e) => [
          new Date(e.incurredAt).toLocaleDateString(),
          e.isPackage ? `[PKG] ${e.title}` : e.title,
          EXPENSE_CATEGORY_LABELS[e.category] ?? e.category,
          e.splitMethod,
          e.payments
            .map(
              (p) =>
                `${data.participantNameMap.get(p.participantId) ?? 'Member'} (${formatPaisaToNPR(p.amountPaisa)})`
            )
            .join(', '),
          formatPaisaToNPR(e.amountPaisa),
        ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [51, 65, 85] },
    });
  }

  const safeFilename = trip.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  doc.save(`tripledger-${safeFilename}-report.pdf`);
}

/**
 * Generates and downloads a multi-sheet Excel (.xlsx) workbook containing:
 * - Sheet 1: Individual Balances
 * - Sheet 2: Family Balances (if applicable)
 * - Sheet 3: Expenses & Multi-Payer Breakdown
 * - Sheet 4: Settlements & Suggestions
 */
export function exportTripReportToExcel(data: ExportReportData): void {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Individual Balances
  const indivRows = data.individualBalances.map((b) => ({
    Participant: b.participantName,
    Family: b.familyName ?? 'Individual',
    Role: b.role,
    'Member Type': b.memberType,
    'Total Paid (NPR)': paisaToNprNumber(b.totalPaidPaisa),
    'Total Expense Share (NPR)': paisaToNprNumber(b.totalSharePaisa),
    'Net Expense Balance (NPR)': paisaToNprNumber(b.netExpenseBalancePaisa),
    'Settlements Sent (NPR)': paisaToNprNumber(b.settlementsSentPaisa),
    'Settlements Received (NPR)': paisaToNprNumber(b.settlementsReceivedPaisa),
    'Outstanding Balance (NPR)': paisaToNprNumber(b.outstandingBalancePaisa),
    Status: b.status,
  }));
  const wsIndiv = XLSX.utils.json_to_sheet(indivRows);
  XLSX.utils.book_append_sheet(wb, wsIndiv, 'Individual Balances');

  // Sheet 2: Family Balances
  if (data.familyBalances.length > 0) {
    const famRows = data.familyBalances.map((f) => ({
      'Family Group': f.familyName,
      Representative: f.representativeName ?? '-',
      'Member Count': f.memberCount,
      'Total Paid (NPR)': paisaToNprNumber(f.totalPaidPaisa),
      'Total Share (NPR)': paisaToNprNumber(f.totalSharePaisa),
      'Outstanding Balance (NPR)': paisaToNprNumber(f.outstandingBalancePaisa),
      Status: f.status,
    }));
    const wsFam = XLSX.utils.json_to_sheet(famRows);
    XLSX.utils.book_append_sheet(wb, wsFam, 'Family Balances');
  }

  // Sheet 3: Expenses
  const expRows = data.expenses.map((e) => ({
    Date: new Date(e.incurredAt).toLocaleDateString(),
    Title: e.title,
    Category: EXPENSE_CATEGORY_LABELS[e.category] ?? e.category,
    'Package Expense': e.isPackage ? 'Yes' : 'No',
    'Split Method': e.splitMethod,
    'Payment Method': PAYMENT_METHOD_LABELS[e.paymentMethod] ?? e.paymentMethod,
    'Status': e.approvalStatus,
    'Amount (NPR)': paisaToNprNumber(e.amountPaisa),
    Payers: e.payments
      .map(
        (p) =>
          `${data.participantNameMap.get(p.participantId) ?? p.participantId}: NPR ${paisaToNprNumber(p.amountPaisa)}`
      )
      .join('; '),
  }));
  const wsExp = XLSX.utils.json_to_sheet(expRows);
  XLSX.utils.book_append_sheet(wb, wsExp, 'Expenses');

  // Sheet 4: Settlements
  const settlementRows = data.settlements.map((s) => ({
    Date: new Date(s.settledAt).toLocaleDateString(),
    Mode: s.settlementMode,
    From: data.participantNameMap.get(s.fromParticipantId) ?? s.fromParticipantId,
    To: data.participantNameMap.get(s.toParticipantId) ?? s.toParticipantId,
    'Amount (NPR)': paisaToNprNumber(s.amountPaisa),
    Method: PAYMENT_METHOD_LABELS[s.paymentMethod] ?? s.paymentMethod,
    Status: s.status,
    Note: s.referenceNote ?? '',
  }));
  const wsSettle = XLSX.utils.json_to_sheet(settlementRows);
  XLSX.utils.book_append_sheet(wb, wsSettle, 'Settlements');

  const safeFilename = data.trip.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  XLSX.writeFile(wb, `tripledger-${safeFilename}-ledger.xlsx`);
}
