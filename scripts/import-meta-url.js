// Gives bundled CommonJS code a working import.meta.url (used to locate files next to modules).
export const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;
