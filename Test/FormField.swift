//
//  FormField.swift
//
//  Model for custom form fields in tenant formSchema.
//

import Foundation

struct FormField: Identifiable, Equatable {
    var id: String
    var key: String
    var label: String
    var type: FormFieldType
    var required: Bool
    var options: [String]?
    var placeholder: String?

    init(
        id: String = UUID().uuidString,
        key: String,
        label: String,
        type: FormFieldType = .text,
        required: Bool = true,
        options: [String]? = nil,
        placeholder: String? = nil
    ) {
        self.id = id
        self.key = key
        self.label = label
        self.type = type
        self.required = required
        self.options = options
        self.placeholder = placeholder
    }

    func toFirestore() -> [String: Any] {
        var dict: [String: Any] = ["key": key, "label": label, "type": type.rawValue, "required": required]
        if let options { dict["options"] = options }
        if let placeholder { dict["placeholder"] = placeholder }
        return dict
    }

    static func fromFirestore(_ dict: [String: Any]) -> FormField? {
        guard let key = dict["key"] as? String, let label = dict["label"] as? String else { return nil }
        let typeRaw = dict["type"] as? String ?? "text"
        let type = FormFieldType(rawValue: typeRaw) ?? .text
        let required = dict["required"] as? Bool ?? true
        let options = dict["options"] as? [String]
        let placeholder = dict["placeholder"] as? String
        return FormField(
            id: key,
            key: key,
            label: label,
            type: type,
            required: required,
            options: options,
            placeholder: placeholder
        )
    }
}

enum FormFieldType: String, CaseIterable {
    case text
    case email
    case phone
    case textarea
    case file
    case select

    var displayName: String {
        switch self {
        case .text: return "Text"
        case .email: return "Email"
        case .phone: return "Phone"
        case .textarea: return "Long text"
        case .file: return "File / photos"
        case .select: return "Dropdown"
        }
    }
}
