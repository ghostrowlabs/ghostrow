/** Word lists for value models. Synthetic by construction: names are combined at random, emails use reserved domains. */

export const FIRST_NAMES = [
  "Aiko", "Amara", "Anika", "Arjun", "Ayesha", "Bea", "Bilal", "Bruno", "Camila", "Chen", "Chiara", "Dana", "Daniel", "Dilan", "Elena", "Emeka", "Emil", "Farah",
  "Felix", "Grace", "Hana", "Hiro", "Imani", "Ines", "Isaac", "Ivan", "Jae", "Jana", "Jonas", "Kai", "Kavya", "Kofi", "Lars", "Leila", "Lena", "Luca", "Maya",
  "Mateo", "Mei", "Nadia", "Nikhil", "Nina", "Noah", "Olu", "Omar", "Priya", "Rafael", "Rania", "Ravi", "Rosa", "Ruwan", "Sakura", "Samir", "Sana", "Sofia",
  "Tariq", "Tara", "Thilini", "Tomas", "Uma", "Valentina", "Vikram", "Wei", "Yara", "Yusuf", "Zara", "Zoe", "Ada", "Alan", "Grace", "Linus", "Margaret", "Hedy",
];

export const LAST_NAMES = [
  "Abebe", "Alvarez", "Andersson", "Bakshi", "Bauer", "Castillo", "Chowdhury", "Costa", "Dias", "Dubois", "Eriksen", "Fernando", "Fischer", "Gupta", "Haddad",
  "Hansen", "Ito", "Iyer", "Jayasinghe", "Jensen", "Kaur", "Kim", "Kowalski", "Lindqvist", "Lopez", "Mendis", "Meyer", "Moreau", "Nakamura", "Nguyen", "Novak",
  "Okafor", "Oliveira", "Park", "Perera", "Petrov", "Quinn", "Rahman", "Rossi", "Santos", "Schmidt", "Silva", "Singh", "Tanaka", "Thomsen", "Varga", "Wang",
  "Weber", "Wijesinghe", "Yamada", "Yilmaz", "Zhou", "Zielinski", "Lovelace", "Hopper", "Turing",
];

export const COMPANY_WORDS = ["Northwind", "Bluepeak", "Ironleaf", "Lumen", "Harbor", "Quartz", "Cedar", "Atlas", "Copperline", "Silverbay", "Kestrel", "Meridian", "Orbit", "Pinecrest", "Redwood", "Summit", "Tidal", "Vantage", "Willow", "Zenith"];
export const COMPANY_SUFFIX = ["Labs", "Systems", "Logistics", "Foods", "Analytics", "Health", "Energy", "Studio", "Partners", "Retail", "Software", "Holdings", "Works", "Group"];
export const COMPANY_TYPE = ["Inc.", "Ltd", "LLC", "GmbH", "Pvt Ltd", "S.A.", "Co."];

export const JOB_TITLES = ["Software Engineer", "Product Manager", "Data Analyst", "Account Executive", "Customer Success Manager", "Operations Lead", "QA Engineer", "Designer", "Finance Manager", "Support Specialist", "Marketing Coordinator", "HR Partner", "Site Reliability Engineer", "Sales Director", "Research Scientist"];

export const PRODUCT_ADJ = ["Compact", "Classic", "Wireless", "Organic", "Premium", "Everyday", "Travel", "Smart", "Recycled", "Ergonomic", "Portable", "Heavy-duty", "Slim", "Waterproof", "Studio"];
export const PRODUCT_NOUN = ["Backpack", "Desk Lamp", "Notebook", "Water Bottle", "Headphones", "Keyboard", "Coffee Grinder", "Jacket", "Monitor Stand", "Charger", "Tea Set", "Running Shoes", "Chair", "Camera Strap", "Planter"];

export const WORDS = [
  "account", "update", "order", "review", "delivery", "invoice", "team", "project", "report", "request", "schedule", "release", "service", "change", "support",
  "payment", "customer", "product", "feature", "issue", "plan", "quarter", "summary", "meeting", "draft", "approval", "inventory", "shipment", "renewal", "contract",
  "weekly", "monthly", "new", "pending", "final", "urgent", "internal", "regional", "annual", "quick", "detailed", "revised", "shared", "priority", "standard",
];

export const SENTENCES = [
  "Delivered on time and in good condition.",
  "Please confirm the shipping address before dispatch.",
  "Customer asked for an itemised invoice.",
  "Follow up next week about the renewal.",
  "Discount applied at checkout.",
  "Replacement sent after the first unit arrived damaged.",
  "Needs approval from the finance team.",
  "Imported from the previous system.",
  "Prefers contact by email in the morning.",
  "Bulk order for the new office.",
  "Gift wrapping requested.",
  "Awaiting stock from the supplier.",
  "Recurring order, same as last month.",
  "Address verified by phone.",
  "Escalated to second-line support.",
];

export const CITIES: [string, string, string][] = [
  ["Colombo", "Western", "LK"], ["Kandy", "Central", "LK"], ["Galle", "Southern", "LK"], ["Berlin", "Berlin", "DE"], ["Munich", "Bavaria", "DE"],
  ["London", "England", "GB"], ["Manchester", "England", "GB"], ["Paris", "Île-de-France", "FR"], ["Lyon", "Auvergne-Rhône-Alpes", "FR"], ["Madrid", "Madrid", "ES"],
  ["Lisbon", "Lisbon", "PT"], ["Amsterdam", "North Holland", "NL"], ["Stockholm", "Stockholm", "SE"], ["Oslo", "Oslo", "NO"], ["Warsaw", "Masovia", "PL"],
  ["New York", "NY", "US"], ["Austin", "TX", "US"], ["Seattle", "WA", "US"], ["Chicago", "IL", "US"], ["Toronto", "ON", "CA"], ["Vancouver", "BC", "CA"],
  ["São Paulo", "SP", "BR"], ["Mexico City", "CDMX", "MX"], ["Bengaluru", "Karnataka", "IN"], ["Mumbai", "Maharashtra", "IN"], ["Singapore", "Singapore", "SG"],
  ["Tokyo", "Tokyo", "JP"], ["Osaka", "Osaka", "JP"], ["Seoul", "Seoul", "KR"], ["Sydney", "NSW", "AU"], ["Melbourne", "VIC", "AU"], ["Auckland", "Auckland", "NZ"],
  ["Cape Town", "Western Cape", "ZA"], ["Nairobi", "Nairobi", "KE"], ["Lagos", "Lagos", "NG"], ["Dubai", "Dubai", "AE"],
];

export const COUNTRIES: Record<string, string> = {
  LK: "Sri Lanka", DE: "Germany", GB: "United Kingdom", FR: "France", ES: "Spain", PT: "Portugal", NL: "Netherlands", SE: "Sweden", NO: "Norway", PL: "Poland",
  US: "United States", CA: "Canada", BR: "Brazil", MX: "Mexico", IN: "India", SG: "Singapore", JP: "Japan", KR: "South Korea", AU: "Australia", NZ: "New Zealand",
  ZA: "South Africa", KE: "Kenya", NG: "Nigeria", AE: "United Arab Emirates",
};

export const STREETS = ["Main Street", "Station Road", "Park Avenue", "Galle Road", "High Street", "Market Street", "Lake View", "Church Lane", "Hill Street", "Harbour Road", "Elm Close", "King's Road", "Temple Road", "Mill Lane"];

export const CURRENCIES = ["USD", "EUR", "GBP", "LKR", "INR", "JPY", "AUD", "CAD", "SGD", "CHF"];
export const LANGUAGES = ["en", "de", "fr", "es", "pt", "si", "ta", "hi", "ja", "ko", "nl", "sv"];
export const TIMEZONES = ["UTC", "Europe/Berlin", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Colombo", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney", "Africa/Nairobi"];
export const MIME_TYPES = ["application/pdf", "image/png", "image/jpeg", "text/csv", "application/json", "text/plain", "application/zip"];
export const COLORS = ["#1F6FEB", "#2DA44E", "#BF3989", "#D4A72C", "#8250DF", "#CF222E", "#57606A", "#0E8A16", "#FB8500", "#023047"];
export const DOMAINS = ["example.com", "example.org", "example.net", "mail.example", "work.example"];

/** Category values for status-like columns, by the column's last word. First values are the most common. */
export const CATEGORY_VALUES: Record<string, string[]> = {
  status: ["active", "pending", "inactive", "archived"],
  state: ["open", "in_progress", "closed"],
  priority: ["medium", "low", "high", "urgent"],
  severity: ["minor", "major", "critical"],
  gender: ["female", "male", "non_binary", "unspecified"],
  sex: ["F", "M"],
  role: ["member", "admin", "viewer", "owner"],
  plan: ["free", "plus", "pro", "max"],
  tier: ["standard", "silver", "gold", "platinum"],
  level: ["beginner", "intermediate", "advanced"],
  type: ["standard", "premium", "basic"],
  kind: ["standard", "special"],
  category: ["general", "electronics", "home", "outdoors", "books"],
  channel: ["web", "mobile", "email", "store"],
  source: ["organic", "referral", "ads", "partner"],
  method: ["card", "bank_transfer", "wallet"],
  mode: ["auto", "manual"],
  phase: ["planning", "build", "review", "done"],
  stage: ["lead", "qualified", "proposal", "won", "lost"],
  visibility: ["public", "private", "internal"],
};
