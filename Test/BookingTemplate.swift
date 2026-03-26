//
//  BookingTemplate.swift
//
//  Industry-specific booking templates: form fields + services.
//  All templates are editable after application.
//

import Foundation

enum BookingTemplate: String, CaseIterable, Identifiable {
    case hair = "hair"
    case barber = "barber"
    case tattoos = "tattoos"
    case nails = "nails"
    case petGrooming = "pet_grooming"
    case custom = "custom"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .hair: return "Hair Salon"
        case .barber: return "Barber shop"
        case .tattoos: return "Tattoo Studio"
        case .nails: return "Nail Salon"
        case .petGrooming: return "Pet grooming"
        case .custom: return "Custom / Blank"
        }
    }

    var icon: String {
        switch self {
        case .hair: return "scissors"
        case .barber: return "mustache.fill"
        case .tattoos: return "paintbrush.fill"
        case .nails: return "hand.raised.fill"
        case .petGrooming: return "pawprint.fill"
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
                FormField(
                    id: "visit_type",
                    key: "visitType",
                    label: "Visit type",
                    type: .select,
                    required: false,
                    options: [
                        "Cut only",
                        "Color only",
                        "Cut + color",
                        "Highlights",
                        "Balayage",
                        "Extensions consult",
                        "Other",
                    ]
                ),
                FormField(
                    id: "hair_texture",
                    key: "hairTexture",
                    label: "Hair texture",
                    type: .select,
                    required: false,
                    options: ["Straight", "Wavy", "Curly", "Coily", "Mixed", "Unsure"],
                    placeholder: "Select texture"
                ),
                FormField(
                    id: "color_history",
                    key: "colorHistory",
                    label: "Color history (last ~12 months)",
                    type: .select,
                    required: false,
                    options: [
                        "None (natural)",
                        "At-home color",
                        "Salon color",
                        "Bleach / lightening",
                        "Not sure",
                    ]
                ),
                FormField(
                    id: "scalp_sensitivity",
                    key: "scalpSensitivity",
                    label: "Scalp sensitivity",
                    type: .select,
                    required: false,
                    options: ["No issues", "Mild / occasional", "Sensitive", "Very sensitive"]
                ),
                FormField(
                    id: "allergies",
                    key: "allergies",
                    label: "Allergies (hair / skin)",
                    type: .text,
                    required: false,
                    placeholder: "e.g. dye, latex, fragrance — or none"
                ),
                FormField(id: "hair_type", key: "hairType", label: "Hair type / length", type: .text, required: false),
                FormField(id: "style_preference", key: "stylePreference", label: "Style or color preference", type: .text, required: false),
                FormField(
                    id: "referenceImages",
                    key: "referenceImages",
                    label: "Reference photos (optional)",
                    type: .file,
                    required: false
                ),
                FormField(id: "notes", key: "notes", label: "Notes", type: .textarea, required: false),
            ]
        case .barber:
            return base + [
                FormField(
                    id: "barber_visit_type",
                    key: "visitType",
                    label: "Visit type",
                    type: .select,
                    required: false,
                    options: [
                        "Haircut",
                        "Fade",
                        "Haircut + beard",
                        "Beard trim only",
                        "Lineup / edge-up",
                        "Kids cut",
                        "Hot towel shave",
                        "Other",
                    ]
                ),
                FormField(
                    id: "fade_or_style",
                    key: "fadeOrStyle",
                    label: "Fade / style",
                    type: .select,
                    required: false,
                    options: [
                        "Low fade",
                        "Mid fade",
                        "High fade",
                        "Taper",
                        "Buzz / crew",
                        "Long on top",
                        "Not sure",
                        "N/A",
                    ],
                    placeholder: "Select style"
                ),
                FormField(
                    id: "facial_hair",
                    key: "facialHair",
                    label: "Facial hair",
                    type: .select,
                    required: false,
                    options: [
                        "Clean shave",
                        "Beard trim",
                        "Mustache only",
                        "No facial hair service today",
                        "N/A",
                    ]
                ),
                FormField(
                    id: "scalp_sensitivity",
                    key: "scalpSensitivity",
                    label: "Scalp / skin sensitivity",
                    type: .select,
                    required: false,
                    options: ["No issues", "Mild / occasional", "Sensitive", "Very sensitive"]
                ),
                FormField(
                    id: "allergies",
                    key: "allergies",
                    label: "Allergies (products / skin)",
                    type: .text,
                    required: false,
                    placeholder: "e.g. fragrance, latex — or none"
                ),
                FormField(
                    id: "cut_details",
                    key: "cutDetails",
                    label: "What do you want done?",
                    type: .text,
                    required: false,
                    placeholder: "e.g. skin fade, beard shape, lineup"
                ),
                FormField(
                    id: "referenceImages",
                    key: "referenceImages",
                    label: "Reference photos (optional)",
                    type: .file,
                    required: false
                ),
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
        case .petGrooming:
            return base + [
                FormField(id: "pet_name", key: "petName", label: "Pet name", type: .text, required: false),
                FormField(
                    id: "pet_type",
                    key: "petType",
                    label: "Pet type",
                    type: .select,
                    required: false,
                    options: ["Dog", "Cat", "Other"],
                    placeholder: "Select type"
                ),
                FormField(id: "breed_size", key: "breedSize", label: "Breed / size", type: .text, required: false),
                FormField(
                    id: "coat",
                    key: "coatNotes",
                    label: "Coat (matted, shedding, double coat, etc.)",
                    type: .text,
                    required: false
                ),
                FormField(
                    id: "behavior",
                    key: "behaviorNotes",
                    label: "Behavior (nervous, senior, reactive, etc.)",
                    type: .text,
                    required: false
                ),
                FormField(id: "notes", key: "notes", label: "Notes", type: .textarea, required: false),
                FormField(id: "pet_photos", key: "petPhotos", label: "Reference photos", type: .file, required: false),
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
        case .barber:
            return [
                ("Haircut", 30),
                ("Fade", 45),
                ("Haircut + beard", 45),
                ("Beard trim", 20),
                ("Lineup / edge-up", 20),
                ("Hot towel shave", 45),
                ("Kids cut", 25),
                ("Consultation", 15),
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
        case .petGrooming:
            return [
                ("Full groom", 90),
                ("Bath & brush", 60),
                ("Nail trim", 30),
                ("Deshedding treatment", 75),
                ("Puppy / kitten intro", 45),
                ("Teeth brushing add-on", 15),
            ]
        case .custom:
            return []
        }
    }
}
