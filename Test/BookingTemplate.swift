//
//  BookingTemplate.swift
//
//  Industry-specific booking templates: form fields + services.
//  All templates are editable after application.
//

import Foundation

enum BookingTemplate: String, CaseIterable, Identifiable {
    case hair = "hair"
    case tattoos = "tattoos"
    case nails = "nails"
    case plumbing = "plumbing"
    case electrical = "electrical"
    case custom = "custom"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .hair: return "Hair Salon"
        case .tattoos: return "Tattoo Studio"
        case .nails: return "Nail Salon"
        case .plumbing: return "Plumbing"
        case .electrical: return "Electrical"
        case .custom: return "Custom / Blank"
        }
    }

    var icon: String {
        switch self {
        case .hair: return "scissors"
        case .tattoos: return "paintbrush.fill"
        case .nails: return "hand.raised.fill"
        case .plumbing: return "drop.fill"
        case .electrical: return "bolt.fill"
        case .custom: return "doc.plaintext"
        }
    }

    var formFields: [FormField] {
        let base = [
            FormField(id: "name", key: "name", label: "Full Name", type: .text, required: true),
            FormField(
                id: "email",
                key: "email",
                label: "Email",
                type: .email,
                required: true,
                placeholder: "example@example.com"
            ),
            FormField(
                id: "phone",
                key: "phone",
                label: "Phone",
                type: .phone,
                required: true,
                placeholder: "(xxx) xxx - xxxx"
            ),
        ]
        switch self {
        case .hair:
            return base + [
                FormField(id: "hair_type", key: "hairType", label: "Hair type / length", type: .text, required: false),
                FormField(id: "style_preference", key: "stylePreference", label: "Style or color preference", type: .text, required: false),
                FormField(id: "notes", key: "notes", label: "Notes", type: .textarea, required: false),
            ]
        case .tattoos:
            return base + [
                FormField(
                    id: "placement",
                    key: "placement",
                    label: "Tattoo placement",
                    type: .select,
                    required: false,
                    options: ["arm", "forearm", "leg", "back", "chest", "foot/ankle", "unsure"]
                ),
                FormField(
                    id: "size",
                    key: "size",
                    label: "Approx size (inches)",
                    type: .select,
                    required: false,
                    options: ["small (1-3\")", "medium (4-6\")", "large (7 - 10\")", "sleeve"]
                ),
                FormField(
                    id: "style",
                    key: "style",
                    label: "Style",
                    type: .select,
                    required: false,
                    options: ["black & grey", "color", "fine line", "traditional", "realism", "unsure"]
                ),
                FormField(
                    id: "description",
                    key: "description",
                    label: "Description",
                    type: .textarea,
                    required: false,
                    placeholder: "Describe your tattoo idea"
                ),
                FormField(id: "referenceImages", key: "referenceImages", label: "Reference images / details", type: .file, required: false),
                FormField(id: "preferredDays", key: "preferredDays", label: "Preferred days", type: .text, required: false),
                FormField(
                    id: "preferredTime",
                    key: "preferredTime",
                    label: "Preferred time of day",
                    type: .select,
                    required: false,
                    options: ["Morning", "Afternoon", "Night", "Flexible"],
                    placeholder: "Select preferred time"
                ),
            ]
        case .nails:
            return base + [
                FormField(id: "nail_type", key: "nailType", label: "Nail type (gel, acrylic, natural)", type: .text, required: false),
                FormField(id: "design", key: "designPreference", label: "Design preference", type: .text, required: false),
                FormField(id: "notes", key: "notes", label: "Notes", type: .textarea, required: false),
            ]
        case .plumbing:
            return base + [
                FormField(id: "address", key: "address", label: "Service address", type: .text, required: false),
                FormField(id: "issue_type", key: "issueType", label: "Issue type (leak, drain, water heater, etc.)", type: .text, required: false),
                FormField(id: "urgency", key: "urgency", label: "Urgency", type: .text, required: false),
                FormField(id: "property_type", key: "propertyType", label: "Property (residential/commercial)", type: .text, required: false),
                FormField(id: "preferred_contact", key: "preferredContact", label: "Preferred contact method", type: .text, required: false),
                FormField(id: "notes", key: "notes", label: "Additional details", type: .textarea, required: false),
                FormField(id: "attachments", key: "attachments", label: "Photos / documents", type: .file, required: false),
            ]
        case .electrical:
            return base + [
                FormField(id: "address", key: "address", label: "Service address", type: .text, required: false),
                FormField(id: "issue_type", key: "issueType", label: "Issue type (wiring, panel, outlet, etc.)", type: .text, required: false),
                FormField(id: "urgency", key: "urgency", label: "Urgency", type: .text, required: false),
                FormField(id: "property_type", key: "propertyType", label: "Property (residential/commercial)", type: .text, required: false),
                FormField(id: "preferred_contact", key: "preferredContact", label: "Preferred contact method", type: .text, required: false),
                FormField(id: "notes", key: "notes", label: "Additional details", type: .textarea, required: false),
                FormField(id: "attachments", key: "attachments", label: "Photos / documents", type: .file, required: false),
            ]
        case .custom:
            return FormField.defaultFields
        }
    }

    var defaultServices: [(name: String, durationMinutes: Int)] {
        switch self {
        case .hair:
            return [
                ("Haircut", 45),
                ("Blowout", 45),
                ("Single process color", 90),
                ("Highlights", 120),
                ("Balayage", 180),
                ("Consultation", 30),
            ]
        case .tattoos:
            return [
                ("Consultation", 30),
                ("Small piece", 60),
                ("Medium piece", 120),
                ("Full session", 240),
            ]
        case .nails:
            return [
                ("Manicure", 45),
                ("Pedicure", 60),
                ("Gel manicure", 60),
                ("Acrylic full set", 90),
                ("Nail art", 30),
            ]
        case .plumbing:
            return [
                ("Leak detection", 60),
                ("Drain cleaning", 60),
                ("Water heater service", 90),
                ("Pipe repair", 90),
                ("Emergency call-out", 60),
            ]
        case .electrical:
            return [
                ("Wiring", 90),
                ("Panel upgrade", 120),
                ("Outlet repair", 60),
                ("Lighting", 60),
                ("Emergency call-out", 60),
            ]
        case .custom:
            return []
        }
    }
}
