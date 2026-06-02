#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cp, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appName = "Codex Refit";
const bundleId = "com.nick.codex-refit";
const version = "0.1.0";
const electronApp = path.join(projectRoot, "node_modules", "electron", "dist", "Electron.app");
const releaseDir = path.join(projectRoot, "release");
const appPath = path.join(releaseDir, `${appName}.app`);
const contentsDir = path.join(appPath, "Contents");
const resourcesDir = path.join(contentsDir, "Resources");
const appResourcesDir = path.join(resourcesDir, "app");
const plistPath = path.join(contentsDir, "Info.plist");
const appIcon = path.join(projectRoot, "electron", "appIcon.icns");

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

  try {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "pipe" });
  } catch (error) {
    console.warn(`Codesign skipped: ${error.message}`);
  }

  try {
    execFileSync("xattr", ["-dr", "com.apple.quarantine", appPath], { stdio: "pipe" });
  } catch {
    // Local bundles may not have quarantine metadata.
  }

  console.log(appPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
