//
//  Service.swift
//  Test
//
//  Created by jilianking on 1/13/26.
//

import Foundation

struct Service: Codable, Identifiable {
    var id: String
    var name: String
    var description: String?
    var price: Double?
    var duration: Int? // in minutes
    
    init(id: String = UUID().uuidString, name: String, description: String? = nil, price: Double? = nil, duration: Int? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.price = price
        self.duration = duration
    }
}


