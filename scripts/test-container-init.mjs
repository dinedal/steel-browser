import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const image = process.argv[2];
assert.ok(image, "Usage: node scripts/test-container-init.mjs IMAGE");
const fixture = fileURLToPath(
  new URL("./fixtures/init-probe.mjs", import.meta.url),
);

function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function start(t, mode, args = [], env = []) {
  const id = docker(
    "run",
    "-d",
    "--network=none",
    "--mount",
    `type=bind,src=${fixture},dst=/app/api/build/index.js,readonly`,
    "-e",
    `INIT_PROBE=${mode}`,
    ...env.flatMap((value) => ["-e", value]),
    image,
    ...args,
  );
  t.after(() => docker("rm", "-f", id));
  return id;
}

async function ready(id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (docker("logs", id).includes("ready")) return;
    await delay(50);
  }
  assert.fail(`Probe did not start: ${docker("logs", id)}`);
}

test("reaps orphaned descendants through the image entrypoint", (t) => {
  const id = start(t, "reap", ["--no-nginx"]);
  assert.equal(
    docker("wait", id),
    "0",
    "The orphaned descendant was not reaped",
  );
  assert.match(docker("logs", id), /orphan reaped/);
});

test("preserves the application's exit status", (t) => {
  const id = start(t, "exit", ["--no-nginx"]);
  assert.equal(docker("wait", id), "42");
});

for (const args of [[], ["--no-nginx"]]) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    test(`forwards ${signal} to children and grandchildren (${
      args[0] ?? "nginx"
    })`, async (t) => {
      const id = start(t, "signals", args);
      await ready(id);
      docker("kill", `--signal=${signal}`, id);
      assert.equal(docker("wait", id), "0");
      const logs = docker("logs", id);
      for (let depth = 0; depth <= 2; depth++) {
        assert.ok(logs.includes(`depth=${depth} signal=${signal}`), logs);
      }
    });
  }
}

test("keeps nginx and debug DBus in the application's process group", async (t) => {
  const id = start(t, "signals", [], ["DEBUG=true"]);
  await ready(id);
  const rows = docker("exec", id, "ps", "-eo", "pgid=,comm=")
    .split("\n")
    .map((row) => row.trim().split(/\s+/));
  const nodeGroup = rows.find(([, command]) => command === "node")?.[0];
  assert.ok(nodeGroup, "Node process missing");
  for (const name of ["nginx", "dbus-daemon"]) {
    const groups = rows.filter(([, command]) => command === name);
    assert.ok(groups.length > 0, `${name} process missing`);
    for (const [group] of groups)
      assert.equal(group, nodeGroup, `${name} escaped the group`);
  }
});
