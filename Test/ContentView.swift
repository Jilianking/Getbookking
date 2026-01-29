//
//  ContentView.swift
//  Test
import SwiftUI

struct ContentView: View {
    @State private var counter = 0

    var body: some View {
        VStack(spacing: 16) {
            Text("Booking App")
                .font(.title)
            Text("Counter: \(counter)")
            Button("Increment") { counter += 1 }
        }
        .padding()
    }
}

#Preview {
    ContentView()
}

