"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const testDirectory = path.join(__dirname, "..", "tests", "unit");
const testFiles = fs
  .readdirSync(testDirectory)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(testDirectory, name));

if (!testFiles.length) {
  console.error("No unit test files found in tests/unit.");
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ["--test", ...testFiles], {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status === null ? 1 : result.status;
  }
}
