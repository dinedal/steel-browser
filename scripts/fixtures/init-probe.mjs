import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

if (process.env.INIT_PROBE === "exit") {
  process.exit(42);
}

if (process.env.INIT_PROBE === "reap") {
  // Detach a grandchild, then let its parent exit before it does.
  const parent = spawn(
    process.execPath,
    [
      "-e",
      `
    const { spawn } = require("node:child_process");
    const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], {
      detached: true,
      stdio: "ignore",
    });
    console.log(orphan.pid);
    orphan.unref();
  `,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let output = "";
  parent.stdout.on("data", (chunk) => {
    output += chunk;
  });
  await once(parent, "close");
  const pid = Number(output.trim());
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("Missing orphan PID");

  for (let attempt = 0; attempt < 60; attempt++) {
    if (!existsSync(`/proc/${pid}`)) {
      console.log("orphan reaped");
      process.exit(0);
    }
    await delay(50);
  }
  throw new Error(`Orphan ${pid} was not reaped`);
}

const depth = Number(process.env.INIT_DEPTH ?? 0);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`depth=${depth} signal=${signal}`);
    // Give descendants time to report before PID 1 exits.
    setTimeout(() => process.exit(0), (2 - depth) * 200);
  });
}

if (depth < 2) {
  spawn(process.execPath, [process.argv[1]], {
    env: { ...process.env, INIT_DEPTH: String(depth + 1) },
    stdio: "inherit",
  });
} else {
  console.log("ready");
}
setInterval(() => {}, 1000);
