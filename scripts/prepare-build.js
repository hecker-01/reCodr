"use strict";

const fs = require("node:fs");
const path = require("node:path");

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(version, label = "version") {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(
      `${label} must be a stable semantic version in major.minor.patch form; received ${JSON.stringify(version)}.`,
    );
  }
  return version.split(".").map(Number);
}

function nextPatch(version) {
  const [major, minor, patch] = parseVersion(version);
  if (patch === Number.MAX_SAFE_INTEGER)
    throw new Error("Patch version is too large to increment safely.");
  return `${major}.${minor}.${patch + 1}`;
}

function prepareBuild({
  root = path.resolve(__dirname, ".."),
  requestedVersion,
} = {}) {
  const packagePath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

  parseVersion(manifest.version, "package.json version");
  if (
    lock.version !== manifest.version ||
    lock.packages?.[""]?.version !== manifest.version
  ) {
    throw new Error(
      "package.json and both package-lock.json root versions must match before preparing a build.",
    );
  }

  const version =
    requestedVersion === undefined
      ? nextPatch(manifest.version)
      : requestedVersion;
  parseVersion(version, "build version");
  manifest.version = version;
  lock.version = version;
  lock.packages[""].version = version;

  fs.writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return version;
}

if (require.main === module) {
  try {
    if (process.argv.includes("--next-version")) {
      const manifest = require(path.join(__dirname, "..", "package.json"));
      process.stdout.write(`${nextPatch(manifest.version)}\n`);
    } else {
      const version = prepareBuild({
        requestedVersion: process.env.RECODR_BUILD_VERSION,
      });
      process.stdout.write(`Prepared reCodr ${version}\n`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { nextPatch, parseVersion, prepareBuild };
