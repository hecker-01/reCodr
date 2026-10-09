"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_EXTENSIONS = {
  windows: new Set([".exe"]),
  mac: new Set([".dmg", ".zip"]),
  linux: new Set([".AppImage", ".deb"]),
};

function findFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? findFiles(fullPath) : [fullPath];
  });
}

function validateArtifacts({ files, version, platform, packageVersions = [] }) {
  if (!EXPECTED_EXTENSIONS[platform])
    throw new Error(`Unknown build platform: ${platform}`);
  const artifacts = files.filter((file) =>
    EXPECTED_EXTENSIONS[platform].has(path.extname(file)),
  );
  if (artifacts.length === 0)
    throw new Error(`No ${platform} build artifacts were found.`);
  const foundExtensions = new Set(artifacts.map((file) => path.extname(file)));
  const missingExtensions = [...EXPECTED_EXTENSIONS[platform]].filter(
    (extension) => !foundExtensions.has(extension),
  );
  if (missingExtensions.length) {
    throw new Error(
      `Missing expected ${platform} artifact type(s): ${missingExtensions.join(", ")}.`,
    );
  }
  for (const artifact of artifacts) {
    const name = path.basename(artifact);
    if (!name.startsWith(`reCodr-${version}-${platform}-`)) {
      throw new Error(
        `Artifact name does not match ${version}/${platform}: ${name}`,
      );
    }
  }
  if (
    packageVersions.length === 0 ||
    packageVersions.some((actual) => actual !== version)
  ) {
    throw new Error(
      `Packaged app version mismatch: expected ${version}; found ${packageVersions.join(", ") || "no app.asar"}.`,
    );
  }
  return artifacts;
}

function readPackagedVersions(files) {
  const asar = require("@electron/asar");
  return files
    .filter((file) => path.basename(file) === "app.asar")
    .map((file) => {
      const packageJson = JSON.parse(
        asar.extractFile(file, "package.json").toString("utf8"),
      );
      return packageJson.version;
    });
}

if (require.main === module) {
  try {
    const [version, platform] = process.argv.slice(2);
    if (!version || !platform)
      throw new Error(
        "Usage: node scripts/verify-build.js <version> <windows|mac|linux>",
      );
    const releaseDirectory = path.resolve("release");
    const files = findFiles(releaseDirectory);
    const currentArtifacts = files.filter(
      (file) => path.dirname(file) === releaseDirectory &&
        path.basename(file).startsWith(`reCodr-${version}-${platform}-`),
    );
    const verified = validateArtifacts({
      files: currentArtifacts,
      version,
      platform,
      packageVersions: readPackagedVersions(files),
    });
    console.log(
      `Verified ${verified.length} ${platform} artifact(s) and packaged version ${version}.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { findFiles, readPackagedVersions, validateArtifacts };
