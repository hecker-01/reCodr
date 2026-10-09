"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const result = spawnSync(
  process.execPath,
  [
    path.join(__dirname, "..", "node_modules", "electron-builder", "cli.js"),
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status === null ? 1 : result.status;
}
