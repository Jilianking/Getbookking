//
//  Item.swift
//  signingtest
//
//  Created by jilian king on 3/18/26.
//

import Foundation
import SwiftData

@Model
final class Item {
    var timestamp: Date
    
    init(timestamp: Date) {
        self.timestamp = timestamp
    }
}
