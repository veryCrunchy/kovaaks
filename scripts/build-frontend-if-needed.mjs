import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const distDir = path.join(repoRoot, "dist");
const cacheFile = path.join(repoRoot, ".cache", "frontend-build.json");

const inputEntries = [
  "src",
  "public",
  "index.html",
  "logs.html",
  "stats.html",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "tailwind.config.js",
  "postcss.config.js",
];

const requiredOutputs = ["index.html", "logs.html", "stats.html"].map((file) =>
  path.join(distDir, file),
);

function walkFiles(entryPath) {
  if (!existsSync(entryPath)) {
    return [];
  }

  const stat = statSync(entryPath);
  if (stat.isFile()) {
    return [entryPath];
  }

  if (!stat.isDirectory()) {
    return [];
  }

  return readdirSync(entryPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => walkFiles(path.join(entryPath, entry.name)));
}

function toRepoRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function loadCachedHash() {
  if (!existsSync(cacheFile)) {
    return null;
  }

  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    return typeof cached.hash === "string" ? cached.hash : null;
  } catch {
    return null;
  }
}

function distOutputsExist() {
  return requiredOutputs.every((filePath) => existsSync(filePath));
}

const inputFiles = inputEntries
  .flatMap((entry) => walkFiles(path.join(repoRoot, entry)))
  .sort((left, right) => toRepoRelative(left).localeCompare(toRepoRelative(right)));

const hash = createHash("sha256");
hash.update("frontend-build-v1\n");
for (const filePath of inputFiles) {
  hash.update(toRepoRelative(filePath));
  hash.update("\n");
  hash.update(readFileSync(filePath));
  hash.update("\n");
}
const currentHash = hash.digest("hex");

if (
  process.env.FORCE_FRONTEND_BUILD !== "1" &&
  distOutputsExist() &&
  loadCachedHash() === currentHash
) {
  console.log("Skipping frontend build; dist is up to date.");
  process.exit(0);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const build = spawnSync(npmCommand, ["run", "build:frontend"], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (!distOutputsExist()) {
  console.error("Frontend build completed but expected dist outputs are missing.");
  process.exit(1);
}

mkdirSync(path.dirname(cacheFile), { recursive: true });
writeFileSync(
  cacheFile,
  `${JSON.stringify({ hash: currentHash, builtAt: new Date().toISOString() }, null, 2)}\n`,
);
