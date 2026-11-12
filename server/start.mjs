import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLocal } from "./local-config.mjs";
import { createSystem } from "./system.mjs";
import { nodeServer } from "./node-server.mjs";
const config = loadLocal(),
  system = createSystem(config),
  server = nodeServer(system, {
    origin: config.origin,
    key: readFileSync(join(config.dir, "tls-key.pem")),
    cert: readFileSync(join(config.dir, "tls-cert.pem")),
  });
const timer = setInterval(() => {
  try {
    system.data.maintain();
    system.access.maintain();
  } catch {}
}, 900000);
timer.unref();
server.on("error", () => {
  clearInterval(timer);
  system.close();
  console.error(
    "Local HTTPS listener unavailable; no fallback listener opened.",
  );
  process.exitCode = 1;
});
server.listen(4318, "127.0.0.1", () =>
  console.log(
    "QuietStats local example: https://127.0.0.1:4318 (self-signed local TLS; collection default off)",
  ),
);
function stop() {
  clearInterval(timer);
  server.close(() => {
    system.close();
    process.exitCode = 0;
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
