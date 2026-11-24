/**
 * build.mjs — builds each extension entry as a self-contained IIFE.
 * Run: node scripts/build.mjs
 */
import { build } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { copyFileSync, mkdirSync, rmSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const entries = [
  {
    name: "service-worker",
    entry: resolve(root, "src/background/service-worker.ts"),
    outDir: resolve(root, "dist/background"),
  },
  {
    name: "bridge",
    entry: resolve(root, "src/content/bridge.ts"),
    outDir: resolve(root, "dist/content"),
  },
  {
    name: "page-injected",
    entry: resolve(root, "src/content/page-injected.ts"),
    outDir: resolve(root, "dist/content"),
  },
  {
    name: "popup",
    entry: resolve(root, "src/popup/popup.ts"),
    outDir: resolve(root, "dist/popup"),
  },
  {
    name: "options",
    entry: resolve(root, "src/options/options.ts"),
    outDir: resolve(root, "dist/options"),
  },
  {
    name: "approve",
    entry: resolve(root, "src/approve/approve.ts"),
    outDir: resolve(root, "dist/approve"),
  },
];

// One id per build, baked into every bundle. The settings page compares its own id with the
// service worker's (GET_BUILD_ID) and warns when they differ: Chrome keeps running the OLD
// worker script of an unpacked extension until it is reloaded, while pages load fresh files.
const BUILD_ID = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "") + "-" + Math.random().toString(36).slice(2, 6);

// Clean dist/
try {
  rmSync(resolve(root, "dist"), { recursive: true, force: true });
} catch {}

// Build each entry as a standalone IIFE
for (const e of entries) {
  console.log(`Building ${e.name}…`);
  await build({
    configFile: false,
    root,
    publicDir: false,       // prevent Vite from copying public/ into each outDir
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
    build: {
      emptyOutDir: false,
      minify: false,
      target: "chrome114",
      outDir: e.outDir,
      lib: {
        entry: e.entry,
        name: e.name.replace(/-/g, "_"),
        formats: ["iife"],
        fileName: () => `${e.name}.js`,
      },
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
    },
  });
}

// Copy static assets from public/ into dist/
function copyStatic(src, dest) {
  mkdirSync(dest.substring(0, dest.lastIndexOf("/")), { recursive: true });
  copyFileSync(src, dest);
}

copyStatic(resolve(root, "public/manifest.json"),       resolve(root, "dist/manifest.json"));
copyStatic(resolve(root, "public/popup/popup.html"),   resolve(root, "dist/popup/popup.html"));
copyStatic(resolve(root, "public/icons/icon128.png"),  resolve(root, "dist/icons/icon128.png"));
copyStatic(resolve(root, "src/popup/popup.css"),       resolve(root, "dist/popup/popup.css"));
copyStatic(resolve(root, "src/ui/theme.css"),          resolve(root, "dist/ui/theme.css"));
copyStatic(resolve(root, "public/options/options.html"), resolve(root, "dist/options/options.html"));
copyStatic(resolve(root, "public/approve/approve.html"), resolve(root, "dist/approve/approve.html"));
copyStatic(resolve(root, "src/approve/approve.css"),     resolve(root, "dist/approve/approve.css"));
copyStatic(resolve(root, "src/options/options.css"),    resolve(root, "dist/options/options.css"));

console.log(`✓ Extension built → dist/  (build ${BUILD_ID})`);


