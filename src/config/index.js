// Configuration module
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Environment variables
export const PORT = process.env.PORT || 3000;
export const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
export const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
export const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
export const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
export const EXTERNAL_WEBHOOK_TOKEN = process.env.EXTERNAL_WEBHOOK_TOKEN;
export const PERSIST_PATH =
  process.env.PERSIST_PATH || path.join(__dirname, "../../storage.json");

// GitHub Gist storage configuration
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
export const GIST_ID = process.env.GIST_ID;
export const USE_GIST_STORAGE = process.env.USE_GIST_STORAGE === "true";

// Validate required environment variables
if (
  !SLACK_SIGNING_SECRET ||
  !SLACK_BOT_TOKEN ||
  !ADMIN_USER_ID ||
  !EXTERNAL_WEBHOOK_TOKEN
) {
  console.error(
    "Missing env vars. Required: SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, ADMIN_USER_ID, EXTERNAL_WEBHOOK_TOKEN"
  );
  console.error(
    "Optional for multi-workspace: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET"
  );
  process.exit(1);
}

// Auto-save configuration
export const AUTO_SAVE_INTERVAL = 300000; // 5 minutes (300 seconds)
export const MAX_HOME_VIEW_FAILURES = 5;
