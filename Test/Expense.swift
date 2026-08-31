//
//  Expense.swift
//
//  Model for tenant bookkeeping in tenants/{tenantId}/expenses. Tracks
//  business expenses for income-tax deduction purposes.
//

import Foundation

enum ExpenseCategory: String, CaseIterable, Identifiable {
    case supplies
    case equipment
    case softwareSubscriptions = "software_subscriptions"
    case advertisingMarketing = "advertising_marketing"
    case travel
    case meals
    case rentUtilities = "rent_utilities"
    case insurance
    case professionalServices = "professional_services"
    case contractLabor = "contract_labor"
    case vehicleMileage = "vehicle_mileage"
    case educationTraining = "education_training"
    case other

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .supplies: return "Supplies"
        case .equipment: return "Equipment"
        case .softwareSubscriptions: return "Software & Subscriptions"
        case .advertisingMarketing: return "Advertising & Marketing"
        case .travel: return "Travel"
        case .meals: return "Meals"
        case .rentUtilities: return "Rent & Utilities"
        case .insurance: return "Insurance"
        case .professionalServices: return "Professional Services"
        case .contractLabor: return "Contract Labor"
        case .vehicleMileage: return "Vehicle & Mileage"
        case .educationTraining: return "Education & Training"
        case .other: return "Other"
        }
    }
}

struct Expense: Identifiable {
    var id: String
    var amountCents: Int
    var currency: String
    var category: ExpenseCategory
    var vendor: String
    var date: Date
    var note: String?
    var receiptImageUrl: String?
    var receiptStoragePath: String?
    var source: String
    var createdByUid: String?
    var createdAt: Date
    var updatedAt: Date?

    var amount: Double { Double(amountCents) / 100 }
}

/// A single row in the Expenses report: either a saved `Expense` document, or a
/// virtual, read-only row synthesized from live Stripe Connect fee data.
struct ExpenseReportRow: Identifiable {
    var id: String
    var amountCents: Int
    var categoryDisplayName: String
    var vendor: String
    var date: Date
    var note: String?
    var receiptImageUrl: String?
    var sourceLabel: String
    var isVirtual: Bool
    var underlyingExpense: Expense?

    var amount: Double { Double(amountCents) / 100 }

    init(expense: Expense) {
        self.id = expense.id
        self.amountCents = expense.amountCents
        self.categoryDisplayName = expense.category.displayName
        self.vendor = expense.vendor
        self.date = expense.date
        self.note = expense.note
        self.receiptImageUrl = expense.receiptImageUrl
        self.sourceLabel = "Manual"
        self.isVirtual = false
        self.underlyingExpense = expense
    }

    init(stripeFeeId: String, amountCents: Int, date: Date, note: String?) {
        self.id = "stripe-fee-\(stripeFeeId)"
        self.amountCents = amountCents
        self.categoryDisplayName = "Payment Processing Fees"
        self.vendor = "Stripe"
        self.date = date
        self.note = note
        self.receiptImageUrl = nil
        self.sourceLabel = "Stripe (auto)"
        self.isVirtual = true
        self.underlyingExpense = nil
    }
}
