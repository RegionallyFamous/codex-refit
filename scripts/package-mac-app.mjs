#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cp, copyFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appName = "Codex Refit";
const bundleId = "com.nick.codex-refit";
const version = "0.1.0";
const electronApp = path.join(projectRoot, "node_modules", "electron", "dist", "Electron.app");
const releaseDir = path.join(projectRoot, "release");
const appPath = path.join(releaseDir, `${appName}.app`);
const dmgRoot = path.join(releaseDir, "dmg-root");
const dmgPath = path.join(releaseDir, `${appName.replaceAll(" ", "-")}-${version}-macOS-arm64.dmg`);
const notarizationZipPath = path.join(releaseDir, `${appName.replaceAll(" ", "-")}-${version}-macOS-arm64-notarization.zip`);
const contentsDir = path.join(appPath, "Contents");
const resourcesDir = path.join(contentsDir, "Resources");
const appResourcesDir = path.join(resourcesDir, "app");
const plistPath = path.join(contentsDir, "Info.plist");
const appIcon = path.join(projectRoot, "electron", "appIcon.icns");
const entitlementsPath = path.join(projectRoot, "electron", "entitlements.mac.plist");

function setPlist(key, value) {
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath]);
}

function deletePlist(key) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plistPath]);
  } catch {
    // Missing optional plist keys are fine.
  }
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

function findDeveloperIdIdentity() {
  if (process.env.CODESIGN_IDENTITY) return process.env.CODESIGN_IDENTITY;
  const output = commandOutput("security", ["find-identity", "-v", "-p", "codesigning"]);
  const match = output.match(/"([^"]*Developer ID Application:[^"]+)"/);
  return match?.[1] || null;
}

async function copyAppSources() {
  await mkdir(appResourcesDir, { recursive: true });
  await cp(path.join(projectRoot, "electron"), path.join(appResourcesDir, "electron"), { recursive: true });
  await cp(path.join(projectRoot, "public"), path.join(appResourcesDir, "public"), { recursive: true });
  await cp(path.join(projectRoot, "src"), path.join(appResourcesDir, "src"), { recursive: true });
  await copyFile(path.join(projectRoot, "server.mjs"), path.join(appResourcesDir, "server.mjs"));
  await copyFile(path.join(projectRoot, "index.html"), path.join(appResourcesDir, "index.html"));
  await writeFile(
    path.join(appResourcesDir, "package.json"),
    `${JSON.stringify(
      {
        name: "codex-refit",
        productName: appName,
        version,
        private: true,
        type: "module",
        main: "electron/main.mjs",
      },
      null,
      2,
    )}\n`,
  );
}

function signApp(identity) {
  if (identity) {
    signNestedBinaries(identity);
    signElectronBundles(identity);
    signCode(identity, appPath, { entitlements: entitlementsPath });
    return;
  }

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
}

function signCode(identity, filePath, { entitlements = null } = {}) {
  const args = ["--force", "--options", "runtime", "--timestamp"];
  if (entitlements) args.push("--entitlements", entitlements);
  args.push("--sign", identity, filePath);
  execFileSync("codesign", args, { stdio: "inherit" });
}

function signIfPresent(identity, filePath, options) {
  try {
    execFileSync("test", ["-e", filePath]);
    signCode(identity, filePath, options);
  } catch {
    // Electron versions can move helper binaries. Missing optional nested binaries are fine.
  }
}

function signNestedBinaries(identity) {
  const frameworkDir = path.join(contentsDir, "Frameworks");
  const nestedBinaries = [
    path.join(frameworkDir, "Electron Framework.framework", "Versions", "A", "Libraries", "libEGL.dylib"),
    path.join(frameworkDir, "Electron Framework.framework", "Versions", "A", "Libraries", "libGLESv2.dylib"),
    path.join(frameworkDir, "Electron Framework.framework", "Versions", "A", "Libraries", "libffmpeg.dylib"),
    path.join(frameworkDir, "Electron Framework.framework", "Versions", "A", "Libraries", "libvk_swiftshader.dylib"),
    path.join(frameworkDir, "Electron Framework.framework", "Versions", "A", "Helpers", "chrome_crashpad_handler"),
    path.join(frameworkDir, "Squirrel.framework", "Versions", "A", "Resources", "ShipIt"),
  ];

  for (const binaryPath of nestedBinaries) {
    signIfPresent(identity, binaryPath);
  }
}

function signElectronBundles(identity) {
  const frameworkDir = path.join(contentsDir, "Frameworks");
  const frameworks = [
    path.join(frameworkDir, "Electron Framework.framework"),
    path.join(frameworkDir, "Mantle.framework"),
    path.join(frameworkDir, "ReactiveObjC.framework"),
    path.join(frameworkDir, "Squirrel.framework"),
  ];
  const helperApps = [
    path.join(frameworkDir, "Electron Helper.app"),
    path.join(frameworkDir, "Electron Helper (GPU).app"),
    path.join(frameworkDir, "Electron Helper (Plugin).app"),
    path.join(frameworkDir, "Electron Helper (Renderer).app"),
  ];

  for (const frameworkPath of frameworks) {
    signIfPresent(identity, frameworkPath);
  }
  for (const helperAppPath of helperApps) {
    signIfPresent(identity, helperAppPath, { entitlements: entitlementsPath });
  }
}

function verifyAppSignature() {
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { stdio: "inherit" });
}

function submitForNotarization(filePath, profile) {
  const output = execFileSync(
    "xcrun",
    ["notarytool", "submit", filePath, "--keychain-profile", profile, "--wait", "--output-format", "json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const result = JSON.parse(output);
  if (result.status !== "Accepted") {
    throw new Error(`Notarization failed for ${filePath}: ${result.status || "unknown"} (${result.id || "no submission id"})`);
  }
  console.log(`Notarization accepted for ${filePath}: ${result.id}`);
}

function staple(filePath) {
  execFileSync("xcrun", ["stapler", "staple", filePath], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "validate", filePath], { stdio: "inherit" });
}

async function notarizeApp(profile) {
  await rm(notarizationZipPath, { force: true });
  execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, notarizationZipPath], { stdio: "inherit" });
  submitForNotarization(notarizationZipPath, profile);
  staple(appPath);
  verifyAppSignature();
}

async function createDmg(identity) {
  await rm(dmgRoot, { recursive: true, force: true });
  await rm(dmgPath, { force: true });
  await mkdir(dmgRoot, { recursive: true });
  await cp(appPath, path.join(dmgRoot, `${appName}.app`), { recursive: true, verbatimSymlinks: true });
  await symlink("/Applications", path.join(dmgRoot, "Applications"));

  execFileSync(
    "hdiutil",
    ["create", "-volname", appName, "-srcfolder", dmgRoot, "-ov", "-format", "UDZO", dmgPath],
    { stdio: "inherit" },
  );

  if (identity) {
    execFileSync("codesign", ["--force", "--timestamp", "--sign", identity, dmgPath], { stdio: "inherit" });
    execFileSync("codesign", ["--verify", "--verbose=2", dmgPath], { stdio: "inherit" });
  }

  await rm(dmgRoot, { recursive: true, force: true });
}

async function main() {
  await rm(appPath, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });
  await cp(electronApp, appPath, { recursive: true, verbatimSymlinks: true });

  await copyFile(appIcon, path.join(resourcesDir, "appIcon.icns"));
  await copyFile(appIcon, path.join(resourcesDir, "electron.icns"));
  await copyAppSources();

  setPlist("CFBundleDisplayName", appName);
  setPlist("CFBundleExecutable", "Electron");
  setPlist("CFBundleIconFile", "appIcon.icns");
  setPlist("CFBundleIdentifier", bundleId);
  setPlist("CFBundleName", appName);
  setPlist("CFBundleShortVersionString", version);
  setPlist("CFBundleVersion", version);
  deletePlist("ElectronAsarIntegrity");

  const identity = findDeveloperIdIdentity();
  const notaryProfile = process.env.NOTARY_PROFILE || null;
  signApp(identity);
  verifyAppSignature();

  try {
    execFileSync("xattr", ["-dr", "com.apple.quarantine", appPath], { stdio: "pipe" });
  } catch {
    // Local bundles may not have quarantine metadata.
  }

  console.log(appPath);
  if (notaryProfile) {
    if (!identity) {
      throw new Error("NOTARY_PROFILE requires a Developer ID signed app, but no Developer ID signing identity was found.");
    }
    await notarizeApp(notaryProfile);
  }
  await createDmg(identity);
  if (notaryProfile) {
    submitForNotarization(dmgPath, notaryProfile);
    staple(dmgPath);
  }
  console.log(dmgPath);
  if (!identity) {
    console.warn("Developer ID signing identity not found; created an ad-hoc signed app and unsigned DMG.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
