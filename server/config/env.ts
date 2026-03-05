import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

type NodeEnv = "development" | "test" | "production";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Support running from repo root or server/ directory.
const envCandidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "..", ".env"),
  path.resolve(__dirname, "..", ".env"),
  path.resolve(__dirname, "..", "..", ".env"),
];

for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

function readString(name: string, fallback = ""): string {
  const raw = process.env[name];
  if (typeof raw !== "string") return fallback;
  return raw.trim();
}

function readInt(name: string, fallback: number): number {
  const raw = readString(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = readString(name).toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function readCsv(name: string, fallback: string[]): string[] {
  const raw = readString(name);
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

const nodeEnv = (readString("NODE_ENV", "development") as NodeEnv) || "development";
const isProd = nodeEnv === "production";

const defaultCorsOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const jwtSecret = readString("JWT_SECRET", "trello-local-secret-key");
if (isProd && !readString("JWT_SECRET")) {
  throw new Error("Missing required env var: JWT_SECRET");
}
if (isProd && jwtSecret === "trello-local-secret-key") {
  throw new Error("JWT_SECRET must be changed in production");
}

const mongoUri = readString("MONGODB_URI", "mongodb://localhost:27017/trello");
if (!mongoUri) {
  throw new Error("Missing required env var: MONGODB_URI");
}

const port = readInt("PORT", 5000);
if (!Number.isFinite(port) || port <= 0) {
  throw new Error("PORT must be a positive integer");
}

export const env = {
  NODE_ENV: nodeEnv,
  IS_PROD: isProd,
  PORT: port,
  MONGODB_URI: mongoUri,
  JWT_SECRET: jwtSecret,
  APP_BASE_URL: readString("APP_BASE_URL", "http://localhost:3000"),
  CORS_ORIGINS: readCsv("CORS_ORIGINS", defaultCorsOrigins),
  USE_BULLMQ_JOBS: readBool("USE_BULLMQ_JOBS", false),
  REDIS_URL: readString("REDIS_URL", "redis://127.0.0.1:6379"),
  RESEND_API_KEY: readString("RESEND_API_KEY"),
  RESEND_FROM: readString("RESEND_FROM", "Trello Clone <no-reply@example.com>"),
  EMAIL_ENABLED: Boolean(readString("RESEND_API_KEY")),
  GOOGLE_CLIENT_ID: readString("GOOGLE_CLIENT_ID"),
  CLOUDINARY_CLOUD_NAME: readString("CLOUDINARY_CLOUD_NAME"),
  CLOUDINARY_API_KEY: readString("CLOUDINARY_API_KEY"),
  CLOUDINARY_API_SECRET: readString("CLOUDINARY_API_SECRET"),
  CLOUDINARY_FOLDER: readString("CLOUDINARY_FOLDER", "crm-attachments"),
  AUDIT_RETENTION_DAYS: readInt("AUDIT_RETENTION_DAYS", 365),
};
