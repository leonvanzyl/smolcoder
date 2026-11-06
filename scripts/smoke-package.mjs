// Checks the npm package the way a user gets it: packs it, installs it into an
// empty folder, runs both commands, and starts the web UI to check that it
// serves the page and the bundled font. No model server is needed. Run
// `npm run build` first.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smolcoder-package-"));
const home = path.join(tmp, "home");
fs.mkdirSync(home);
// A scratch home folder, so nothing reads or writes the real ~/.smolcoder.
const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
const PORT = Number(process.env.SMOKE_PORT) || 7499;

const sh = (cmd, cwd) => {
  const res = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", env });
  if (res.status !== 0) throw new Error(`${cmd} failed:\n${res.stdout}\n${res.stderr}`);
  return res.stdout.trim();
};

let server;
try {
  const tarball = path.join(root, sh("npm pack --silent", root).split(/\r?\n/).pop());
  sh("npm init -y", tmp);
  sh(`npm install --no-audit --no-fund "${tarball}"`, tmp);
  fs.rmSync(tarball);

  const installed = path.join(tmp, "node_modules", "smolcoder");
  for (const f of ["dist/index.js", "assets/fonts/inter-latin-wght-normal.woff2", "assets/fonts/OFL.txt", "README.md"]) {
    if (!fs.existsSync(path.join(installed, f))) throw new Error(`the package is missing ${f}`);
  }

  for (const bin of ["smol", "smolcoder"]) {
    const version = sh(`npx --no-install ${bin} --version`, tmp);
    if (version !== pkg.version) throw new Error(`${bin} --version printed "${version}", expected ${pkg.version}`);
    console.log(`${bin} --version: ${version}`);
  }
  const help = sh("npx --no-install smol --help", tmp);
  for (const want of ["/models", "/sessions", "/undo", "Keyboard:"]) {
    if (!help.includes(want)) throw new Error(`smol --help does not mention ${want}`);
  }
  console.log("smol --help lists the commands and keys");

  // Started from the (scratch) home folder, the web UI opens without a session.
  server = spawn(process.execPath, [path.join(installed, "dist", "index.js"), "--web", String(PORT)], {
    cwd: home,
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  server.stdout.on("data", (d) => (out += d));
  let url = null;
  for (let i = 0; i < 60 && !url; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (server.exitCode !== null) throw new Error(`smol --web exited with code ${server.exitCode}:\n${out}`);
    url = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?k=\S+/)?.[0] ?? null;
  }
  if (!url) throw new Error(`smol --web never printed its address:\n${out}`);

  const page = await fetch(url);
  const html = await page.text();
  if (page.status !== 200 || !html.includes("<style>")) throw new Error(`the web UI did not serve its page (${page.status})`);
  const font = await fetch(`http://127.0.0.1:${PORT}/fonts/inter-latin-wght-normal.woff2`);
  const bytes = Buffer.from(await font.arrayBuffer());
  if (font.status !== 200 || font.headers.get("content-type") !== "font/woff2" || bytes.subarray(0, 4).toString() !== "wOF2") {
    throw new Error(`the web UI did not serve the bundled font (${font.status} ${font.headers.get("content-type")})`);
  }
  const locked = await fetch(`http://127.0.0.1:${PORT}/`);
  if (locked.status !== 403) throw new Error(`the web UI answered without its key (${locked.status})`);
  console.log("smol --web serves the page and the font, and refuses requests without the key");
} finally {
  server?.kill();
  // Windows keeps the folder locked until the server has exited.
  await new Promise((r) => setTimeout(r, 1000));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
