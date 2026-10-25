//
//  AccountNotice.swift
//  Notices about the owner's account (e.g. domain renewals) shown in the activity center.
//

import Foundation

struct AccountNotice: Identifiable, Equatable {
    let id: String
    let kind: String
    let title: String
    let body: String
    let createdAt: Date?
}
