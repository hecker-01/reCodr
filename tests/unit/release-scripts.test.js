"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { nextPatch, prepareBuild } = require("../../scripts/prepare-build");
const { validateArtifacts } = require("../../scripts/verify-build");
const packageManifest = require("../../package.json");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recodr-build-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "recodr", version: "1.7.1" }, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify(
      {
        name: "recodr",
        version: "1.7.1",
        packages: { "": { name: "recodr", version: "1.7.1" } },
      },
      null,
      2,
    ) + "\n",
  );
  return root;
}

test("local build preparation increments only patch and synchronizes both lock roots", (t) => {
  const root = fixture(t);
  assert.equal(nextPatch("1.7.1"), "1.7.2");
  assert.equal(prepareBuild({ root }), "1.7.2");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  assert.equal(manifest.version, "1.7.2");
  assert.equal(lock.version, "1.7.2");
  assert.equal(lock.packages[""].version, "1.7.2");
});

test("a CI-selected version stays exact across repeated platform build hooks", (t) => {
  const root = fixture(t);
  assert.equal(prepareBuild({ root, requestedVersion: "2.3.0" }), "2.3.0");
  assert.equal(prepareBuild({ root, requestedVersion: "2.3.0" }), "2.3.0");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  assert.equal(manifest.version, "2.3.0");
  assert.equal(lock.packages[""].version, "2.3.0");
});

test("version preparation rejects malformed versions and a pre-existing manifest/lock mismatch", (t) => {
  const root = fixture(t);
  assert.throws(
    () => prepareBuild({ root, requestedVersion: "v2.0.0" }),
    /stable semantic version/,
  );
  const lockPath = path.join(root, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.packages[""].version = "0.0.0";
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  assert.throws(() => prepareBuild({ root }), /versions must match/);
});

test("artifact verification requires normalized platform/version names and matching packaged app version", () => {
  const files = [
    "release/reCodr-1.7.2-mac-universal.dmg",
    "release/reCodr-1.7.2-mac-universal.zip",
  ];
  assert.equal(
    validateArtifacts({
      files,
      version: "1.7.2",
      platform: "mac",
      packageVersions: ["1.7.2"],
    }).length,
    2,
  );
  assert.throws(
    () =>
      validateArtifacts({
        files,
        version: "1.7.2",
        platform: "mac",
        packageVersions: ["1.7.1"],
      }),
    /version mismatch/,
  );
  assert.throws(
    () =>
      validateArtifacts({
        files: ["release/reCodr-1.7.2-linux-x64.deb"],
        version: "1.7.2",
        platform: "mac",
        packageVersions: ["1.7.2"],
      }),
    /No mac build artifacts/,
  );
  assert.throws(
    () =>
      validateArtifacts({
        files: ["release/reCodr-1.7.2-linux-x64.deb"],
        version: "1.7.2",
        platform: "linux",
        packageVersions: ["1.7.2"],
      }),
    /Missing expected linux artifact type/,
  );
});

test("each local build command has one shared version-preparation lifecycle hook", () => {
  for (const name of [
    "build",
    "build:win",
    "build:mac",
    "build:linux",
    "build:full",
  ]) {
    assert.equal(
      packageManifest.scripts[`pre${name}`],
      "node scripts/prepare-build.js",
      name,
    );
    assert.match(
      packageManifest.scripts[name],
      /^node scripts\/build\.js(?:\s|$)/,
      name,
    );
  }
  assert.equal(
    Object.values(packageManifest.scripts).some((script) =>
      script.startsWith("npm version "),
    ),
    false,
  );
});
