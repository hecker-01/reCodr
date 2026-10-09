"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const electronPath = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(
  electronPath,
  [path.join(__dirname, "..", "tests", "electron-smoke.cjs")],
  {
    stdio: "inherit",
    env,
    windowsHide: true,
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status === null ? 1 : result.status;
}
