//
//  TestApp.swift
//  Test
//
//  Created by jilianking on 1/13/26.
//

import SwiftUI
import FirebaseCore  // Add this import

@main
struct TestApp: App {
    init() {
        // Initialize Firebase when app launches
        FirebaseApp.configure()
    }
    
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
