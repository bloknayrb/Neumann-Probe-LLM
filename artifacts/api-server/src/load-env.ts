import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs at import time — must be the FIRST import in the entrypoint so env is
// populated before any other module reads process.env. Prefers the monorepo
// root .env (VNG_API_KEY + PORT); falls back to a local .env. Uses Node's
// native loader (Node 20.12+). Silent if no .env file exists.
const here = path.dirname(fileURLToPath(import.meta.url)); // dist/ once bundled
const candidates = [
  path.resolve(here, "..", "..", "..", ".env"), // <repo-root>/.env
  path.resolve(here, "..", ".env"), // artifacts/api-server/.env
  path.resolve(process.cwd(), ".env"),
];

for (const file of candidates) {
  try {
    (process as any).loadEnvFile(file);
    break;
  } catch {
    // missing/unreadable — try the next candidate
  }
}
