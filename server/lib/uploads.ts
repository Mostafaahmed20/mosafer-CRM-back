import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use one shared uploads path that stays consistent in both source and bundled builds.
export const UPLOADS_DIR = path.resolve(__dirname, "..", "..", "uploads");
