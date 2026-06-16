/**
 * Mirrors BookingTemplate.defaultServices + minimal form schema for web sign-up.
 */
const minimalFormSchema = [
  { key: "name", label: "Full Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email", required: true },
  { key: "phone", label: "Phone", type: "phone", required: true },
  {
    key: "referenceImages",
    label: "Reference photos (optional)",
    type: "file",
    required: false,
  },
  { key: "notes", label: "Notes", type: "textarea", required: false },
];

/** Matches BookingTemplate.formFields → FormField.toFirestore() (Test/BookingTemplate.swift). */
const baseContactFormFields = [
  { key: "name", label: "Full Name", type: "text", required: true },
  {
    key: "email",
    label: "Email",
    type: "email",
    required: true,
    placeholder: "example@example.com",
  },
  {
    key: "phone",
    label: "Phone",
    type: "phone",
    required: true,
    placeholder: "(xxx) xxx - xxxx",
  },
];

function formSchemaForIndustry(industry) {
  const ind = (industry || "").trim().toLowerCase();
  switch (ind) {
    case "hair":
      return baseContactFormFields.concat([
        {
          key: "visitType",
          label: "Visit type",
          type: "select",
          required: false,
          options: [
            "Cut only",
            "Color only",
            "Cut + color",
            "Highlights",
            "Balayage",
            "Extensions consult",
            "Other",
          ],
        },
        {
          key: "hairTexture",
          label: "Hair texture",
          type: "select",
          required: false,
          options: ["Straight", "Wavy", "Curly", "Coily", "Mixed", "Unsure"],
          placeholder: "Select texture",
        },
        {
          key: "colorHistory",
          label: "Color history (last ~12 months)",
          type: "select",
          required: false,
          options: [
            "None (natural)",
            "At-home color",
            "Salon color",
            "Bleach / lightening",
            "Not sure",
          ],
        },
        {
          key: "scalpSensitivity",
          label: "Scalp sensitivity",
          type: "select",
          required: false,
          options: ["No issues", "Mild / occasional", "Sensitive", "Very sensitive"],
        },
        {
          key: "allergies",
          label: "Allergies (hair / skin)",
          type: "text",
          required: false,
          placeholder: "e.g. dye, latex, fragrance — or none",
        },
        {
          key: "hairType",
          label: "Hair type / length",
          type: "text",
          required: false,
        },
        {
          key: "stylePreference",
          label: "Style or color preference",
          type: "text",
          required: false,
        },
        {
          key: "referenceImages",
          label: "Reference photos (optional)",
          type: "file",
          required: false,
        },
        { key: "notes", label: "Notes", type: "textarea", required: false },
      ]);
    case "barber":
      return baseContactFormFields.concat([
        {
          key: "fadeOrStyle",
          label: "Fade / style",
          type: "select",
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
          placeholder: "Select style",
        },
        {
          key: "facialHair",
          label: "Facial hair",
          type: "select",
          required: false,
          options: [
            "Clean shave",
            "Beard trim",
            "Mustache only",
            "No facial hair service today",
            "N/A",
          ],
        },
        {
          key: "scalpSensitivity",
          label: "Scalp / skin sensitivity",
          type: "select",
          required: false,
          options: ["No issues", "Mild / occasional", "Sensitive", "Very sensitive"],
        },
        {
          key: "allergies",
          label: "Allergies (products / skin)",
          type: "text",
          required: false,
          placeholder: "e.g. fragrance, latex — or none",
        },
        {
          key: "cutDetails",
          label: "What do you want done?",
          type: "text",
          required: false,
          placeholder: "e.g. skin fade, beard shape, lineup",
        },
        {
          key: "referenceImages",
          label: "Reference photos (optional)",
          type: "file",
          required: false,
        },
        { key: "notes", label: "Notes", type: "textarea", required: false },
      ]);
    case "tattoos":
      return baseContactFormFields.concat([
        {
          key: "placement",
          label: "Tattoo placement",
          type: "select",
          required: false,
          options: [
            "arm",
            "forearm",
            "leg",
            "back",
            "chest",
            "foot/ankle",
            "unsure",
          ],
        },
        {
          key: "size",
          label: "Approx size (inches)",
          type: "select",
          required: false,
          options: [
            'small (1-3")',
            'medium (4-6")',
            'large (7 - 10")',
            "sleeve",
          ],
        },
        {
          key: "style",
          label: "Style",
          type: "select",
          required: false,
          options: [
            "black & grey",
            "color",
            "fine line",
            "traditional",
            "realism",
            "unsure",
          ],
        },
        {
          key: "description",
          label: "Description",
          type: "textarea",
          required: false,
          placeholder: "Describe your tattoo idea",
        },
        {
          key: "referenceImages",
          label: "Reference images / details",
          type: "file",
          required: false,
        },
        {
          key: "preferredDays",
          label: "Preferred days",
          type: "text",
          required: false,
        },
        {
          key: "preferredTime",
          label: "Preferred time of day",
          type: "select",
          required: false,
          options: ["Morning", "Afternoon", "Night", "Flexible"],
          placeholder: "Select preferred time",
        },
      ]);
    case "nails":
      return baseContactFormFields.concat([
        {
          key: "nailType",
          label: "Nail type (gel, acrylic, natural)",
          type: "text",
          required: false,
        },
        {
          key: "designPreference",
          label: "Design preference",
          type: "text",
          required: false,
        },
        {
          key: "referenceImages",
          label: "Reference photos (optional)",
          type: "file",
          required: false,
        },
        { key: "notes", label: "Notes", type: "textarea", required: false },
      ]);
    case "custom":
    default:
      return minimalFormSchema;
  }
}

const defaultServicesByIndustry = {
  hair: [
    { name: "Haircut", durationMinutes: 45 },
    { name: "Blowout", durationMinutes: 45 },
    { name: "Single process color", durationMinutes: 90 },
    { name: "Highlights", durationMinutes: 120 },
    { name: "Balayage", durationMinutes: 180 },
    { name: "Consultation", durationMinutes: 30 },
  ],
  barber: [
    { name: "Skin fade", durationMinutes: 45 },
    { name: "Beard trim", durationMinutes: 20 },
    { name: "Lineup / edge-up", durationMinutes: 20 },
    { name: "Full service", durationMinutes: 75 },
  ],
  tattoos: [
    { name: "Consultation", durationMinutes: 30 },
    { name: "Small piece", durationMinutes: 60 },
    { name: "Medium piece", durationMinutes: 120 },
    { name: "Full session", durationMinutes: 240 },
  ],
  nails: [
    { name: "Manicure", durationMinutes: 45 },
    { name: "Pedicure", durationMinutes: 60 },
    { name: "Gel manicure", durationMinutes: 60 },
    { name: "Acrylic full set", durationMinutes: 90 },
    { name: "Nail art", durationMinutes: 30 },
  ],
  custom: [
    { name: "Consultation", durationMinutes: 30 },
    { name: "Standard service", durationMinutes: 45 },
    { name: "Premium service", durationMinutes: 60 },
    { name: "Full service", durationMinutes: 90 },
  ],
};

function themesForIndustry(industry) {
  const ind = (industry || "").trim().toLowerCase();
  const universal = ["luxe-v1", "blade-v1", "stonecut-v1", "studio-12-v1"];
  const classicByIndustry = {
    hair: "hair-salon-v1",
    barber: "barber-shop-v1",
    tattoos: "tattoo-studio-v1",
    nails: "nail-salon-v1",
    custom: "custom-standard",
  };
  if (!ind || !(ind in classicByIndustry)) {
    return new Set(["custom-standard", ...universal]);
  }
  const base = classicByIndustry[ind];
  return new Set([base, ...universal]);
}

function defaultThemeForIndustry(industry) {
  const allowed = themesForIndustry(industry);
  const first = ["hair-salon-v1", "barber-shop-v1", "tattoo-studio-v1", "nail-salon-v1", "custom-standard"];
  for (const id of first) {
    if (allowed.has(id)) return id;
  }
  return "custom-standard";
}

function resolveWebThemeId(industry, preset) {
  const allowed = themesForIndustry(industry);
  const map = {
    obsidian: "blade-v1",
    blanc: "luxe-v1",
    ember: "stonecut-v1",
    portfolio: null,
  };
  let id = map[preset];
  if (preset === "portfolio" || !id) {
    return defaultThemeForIndustry(industry);
  }
  if (!allowed.has(id)) {
    return defaultThemeForIndustry(industry);
  }
  return id;
}

function slugFromBusiness(business) {
  return business
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("");
}

function normalizeIndustry(raw) {
  const s = (raw || "").trim().toLowerCase();
  const map = {
    hair: "hair",
    barber: "barber",
    tattoo: "tattoos",
    tattoos: "tattoos",
    nails: "nails",
    custom: "custom",
  };
  return map[s] || (["hair", "barber", "tattoos", "nails", "custom"].includes(s) ? s : "custom");
}

module.exports = {
  minimalFormSchema,
  formSchemaForIndustry,
  defaultServicesByIndustry,
  resolveWebThemeId,
  slugFromBusiness,
  normalizeIndustry,
};
