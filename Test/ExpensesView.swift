//
//  ExpensesView.swift
//
//  Expense tracking for tax deductions: a summary + list for the selected date
//  range, merging manually-logged expenses with a live Stripe processing-fees
//  line, plus Add and CSV export actions.
//

import SwiftUI

struct ExpensesView: View {
    @EnvironmentObject var sessionStore: TenantSessionStore
    @StateObject private var viewModel = ExpensesViewModel()
    @State private var showAddExpense: Bool = false
    @State private var expenseToEdit: Expense?
    @State private var shareItem: ShareableCSV?
    var drawerState: DrawerState
    let sectionTitle: String

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    dateRangeCard
                    summaryCard
                    listCard
                }
                .padding(.vertical, 16)
                .padding(.horizontal)
            }
            .appScreenBackground()
            .appNavigationChrome()
            .navigationTitle(sectionTitle)
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { drawerState.isOpen = true }) {
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: { showAddExpense = true }) {
                        Image(systemName: "plus")
                            .foregroundStyle(AppDesign.textPrimary)
                    }
                }
            }
            .refreshable {
                await viewModel.refresh(sessionStore: sessionStore)
            }
            .task {
                await viewModel.loadData(sessionStore: sessionStore)
            }
            .sheet(isPresented: $showAddExpense) {
                AddEditExpenseView(viewModel: viewModel, expense: nil) { savedDate in
                    showAddExpense = false
                    widenRangeIfNeeded(for: savedDate)
                    Task { await viewModel.refresh(sessionStore: sessionStore) }
                }
            }
            .sheet(item: $expenseToEdit) { expense in
                AddEditExpenseView(viewModel: viewModel, expense: expense) { savedDate in
                    expenseToEdit = nil
                    widenRangeIfNeeded(for: savedDate)
                    Task { await viewModel.refresh(sessionStore: sessionStore) }
                }
            }
            .sheet(item: $shareItem) { item in
                ReceiptShareSheet(items: [item.fileURL])
            }
        }
    }

    private var dateRangeCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Date range").font(.subheadline).foregroundStyle(AppDesign.textSecondary)
            HStack {
                DatePicker("From", selection: $viewModel.rangeStart, displayedComponents: .date)
                    .labelsHidden()
                Text("–")
                DatePicker("To", selection: $viewModel.rangeEnd, displayedComponents: .date)
                    .labelsHidden()
                Spacer()
                Button("Apply") {
                    Task { await viewModel.refresh(sessionStore: sessionStore) }
                }
            }
        }
        .padding()
        .background(AppDesign.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var summaryCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Total deductible").font(.headline)
                Spacer()
                Text(formatCurrency(Double(viewModel.totalCents) / 100))
                    .font(.title2.bold())
            }
            if !viewModel.totalsByCategory.isEmpty {
                Divider()
                ForEach(viewModel.totalsByCategory, id: \.category) { entry in
                    HStack {
                        Text(entry.category).font(.caption).foregroundStyle(AppDesign.textSecondary)
                        Spacer()
                        Text(formatCurrency(Double(entry.cents) / 100)).font(.caption)
                    }
                }
            }
            Button {
                exportCSV()
            } label: {
                Label("Export CSV", systemImage: "square.and.arrow.up")
            }
            .disabled(viewModel.rows.isEmpty)
            .padding(.top, 4)
        }
        .padding()
        .background(AppDesign.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var listCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            if viewModel.isLoading {
                ProgressView().frame(maxWidth: .infinity).padding()
            } else if viewModel.rows.isEmpty {
                Text("No expenses logged for this range.")
                    .font(.subheadline)
                    .foregroundStyle(AppDesign.textSecondary)
                    .padding()
            } else {
                ForEach(viewModel.rows) { row in
                    rowView(row)
                    Divider()
                }
            }
        }
        .background(AppDesign.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func rowView(_ row: ExpenseReportRow) -> some View {
        Button {
            guard !row.isVirtual, let expense = row.underlyingExpense else { return }
            expenseToEdit = expense
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.vendor.isEmpty ? row.categoryDisplayName : row.vendor)
                        .font(.subheadline).foregroundStyle(AppDesign.textPrimary)
                    Text("\(row.categoryDisplayName) · \(row.sourceLabel)")
                        .font(.caption).foregroundStyle(AppDesign.textSecondary)
                }
                Spacer()
                Text(formatCurrency(row.amount)).font(.subheadline)
            }
            .padding()
        }
        .buttonStyle(.plain)
        .disabled(row.isVirtual)
    }

    /// A saved expense's date can predate the visible range (e.g. an old receipt scanned
    /// today) — without this it would save successfully but silently vanish from the list.
    private func widenRangeIfNeeded(for date: Date) {
        if date < viewModel.rangeStart { viewModel.rangeStart = date }
        if date > viewModel.rangeEnd { viewModel.rangeEnd = date }
    }

    private func exportCSV() {
        let csv = viewModel.exportCSV()
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("expenses-\(UUID().uuidString).csv")
        do {
            try csv.write(to: url, atomically: true, encoding: .utf8)
            shareItem = ShareableCSV(fileURL: url)
        } catch {
            // Nothing user-actionable to do beyond letting the sheet not appear.
        }
    }

    private func formatCurrency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: value)) ?? "$0.00"
    }
}

private struct ShareableCSV: Identifiable {
    let id = UUID()
    let fileURL: URL
}
