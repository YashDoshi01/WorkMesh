// Builds the publishable npm package into packages/worker-sdk/.publish/ (never touches the
// workspace package, which keeps pointing at the TypeScript source for local development).
//
//   node packages/worker-sdk/scripts/build-package.mjs --name <package-name> --version <x.y.z>
//
// Nothing is published by this script. Publishing is a separate, deliberate command:
//   cd packages/worker-sdk/.publish && npm publish --access public
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const repoRoot = resolve(pkgDir, "../..");
const out = join(pkgDir, ".publish");

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const fail = (message) => {
  console.error(`build-package: ${message}`);
  process.exit(1);
};

const name = arg("name");
const version = arg("version");
if (!name || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) {
  fail("pass --name with a valid npm package name, e.g. --name workmesh-sdk or @you/workmesh-sdk");
}
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail("pass --version, e.g. --version 0.1.0");
}
if (!existsSync(join(repoRoot, "LICENSE"))) fail("the repository has no LICENSE file");

const source = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const repository = arg("repository"); // e.g. https://github.com/you/workmesh.git
const author = arg("author");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const tsc = spawnSync("npx", ["tsc", "-p", join(pkgDir, "tsconfig.build.json")], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (tsc.status !== 0) fail("the TypeScript build failed");

const manifest = {
  name,
  version,
  description:
    "Node.js SDK for WorkMesh: queue jobs from your application and run them in workers, with safe retries (idempotency keys).",
  license: "MIT",
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  files: ["dist", "README.md", "LICENSE"],
  sideEffects: false,
  // Only Node 24 has been tested; widen this after testing older versions.
  engines: { node: ">=24" },
  keywords: ["jobs", "queue", "background-jobs", "workflow", "scheduler", "workmesh"],
  dependencies: source.dependencies,
  publishConfig: { access: "public" },
  ...(author ? { author } : {}),
  ...(repository ? { repository: { type: "git", url: repository } } : {}),
};
writeFileSync(join(out, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
cpSync(join(repoRoot, "LICENSE"), join(out, "LICENSE"));
const readme = readFileSync(join(repoRoot, "docs", "SDK.md"), "utf8");
// docs/SDK.md is the README. It must use the name being published, or users copy a wrong import.
if (!readme.includes(`from "${name}"`)) {
  fail(`docs/SDK.md does not import from "${name}": update it before publishing`);
}
writeFileSync(join(out, "README.md"), readme);

console.log(`\nbuilt ${name}@${version} in ${out}`);
console.log("Review it with:  cd packages/worker-sdk/.publish && npm pack --dry-run");
