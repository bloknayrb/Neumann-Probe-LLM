import "./load-env.js"; // MUST be first — populates process.env from .env
import app from "./app";
import { logger } from "./lib/logger";
import { startPoller } from "./routes/vng/poller.js";
import { assertPolicyCoversTools } from "./routes/vng/tool-policy.js";

// Also asserted in the MCP subprocess, but that one's stderr goes to a spawned
// child nobody watches — a policy/tools mismatch there just looks like the brain
// quietly having fewer tools. Fail here, where the operator is looking.
assertPolicyCoversTools();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startPoller();
});
