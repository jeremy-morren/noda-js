// Coverage for `npm run test:ci`: Vitest's v8 provider (@vitest/coverage-v8), measured in the node project only.
//
// Vitest refuses `coverage.provider: "v8"` when Firefox or WebKit projects are in the run (v8 coverage in a browser
// needs Chromium's DevTools protocol), and coverage options are global, not per project. As a custom provider this
// module is loaded on Node (where it is the v8 provider) and in each browser tester page, where it's inert: Vitest's
// start/take/stopCoverage hooks are optional, and getProvider is only called on Node. Browsers run the same src/, so
// Node's coverage is the coverage.
//
// CI runs the node project on Linux, Windows and macOS and merges their blob reports (`vitest --merge-reports`, see
// .github/workflows/ci.yml). Each blob's coverage is keyed by absolute paths in that machine's checkout, so before
// merging, each path is moved to the same file in this checkout; otherwise every file would appear once per machine.
//
// No top-level await: Vitest imports this module several times, sometimes concurrently, and a concurrent import of a
// module still awaiting can see it without its default export. So the v8 module is loaded on first use.

import type { CoverageProvider, CoverageProviderModule } from "vitest/node";

const v8Module = "@vitest/coverage-v8";

// A coverage map as a blob report stores it: file coverage data by absolute path, each with its `path` too.
type SerializedCoverage = Record<string, { path: string }>;

// The node: modules are imported here, not at the top, so the browser pages never load them.
async function nodeModules() {
  return {
    module: (await import(/* @vite-ignore */ "node:module" as string)) as typeof import("node:module"),
    url: (await import(/* @vite-ignore */ "node:url" as string)) as typeof import("node:url"),
    fs: (await import(/* @vite-ignore */ "node:fs" as string)) as typeof import("node:fs"),
    path: ((await import(/* @vite-ignore */ "node:path" as string)) as { default: typeof import("node:path") }).default,
  };
}

// The v8 provider module, resolved to its file with Node's resolver (Vitest's module runner resolves a bare specifier
// imported this way against the root, not node_modules). Node caches it, so every import of this module shares one:
// it keeps its inspector session on itself between startCoverage and takeCoverage.
async function v8(): Promise<CoverageProviderModule> {
  const { module, url } = await nodeModules();
  const file = module.createRequire(import.meta.url).resolve(v8Module);
  return ((await import(/* @vite-ignore */ url.pathToFileURL(file).href)) as { default: CoverageProviderModule }).default;
}

// The file in this checkout that a path from another machine's checkout names: the first tail of its segments that
// starts at a "src" (coverage only includes src/) and exists here. Unchanged if there's none.
async function rebaser(): Promise<(filepath: string) => string> {
  const { fs, path, url } = await nodeModules();
  const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");
  return (filepath) => {
    const segments = filepath.split(/[\\/]/);
    for (let i = segments.indexOf("src"); i >= 0; i = segments.indexOf("src", i + 1)) {
      const candidate = path.join(root, ...segments.slice(i));
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return filepath;
  };
}

const nodeProvider: CoverageProviderModule = {
  async getProvider(): Promise<CoverageProvider> {
    const provider = await (await v8()).getProvider();
    const mergeReports = provider.mergeReports?.bind(provider);
    if (mergeReports) {
      const rebase = await rebaser();
      provider.mergeReports = (coverages) =>
        mergeReports(coverages.map((coverage) => {
          if (!coverage || typeof coverage !== "object") {
            return coverage;
          }
          const rebased: SerializedCoverage = {};
          for (const fileCoverage of Object.values(coverage as SerializedCoverage)) {
            const filepath = rebase(fileCoverage.path);
            rebased[filepath] = { ...fileCoverage, path: filepath };
          }
          return rebased;
        }));
    }
    return provider;
  },
  // In each test worker. (Called on the v8 module itself, which holds the session.)
  async startCoverage(options) {
    return (await v8()).startCoverage?.(options);
  },
  async takeCoverage(options) {
    return (await v8()).takeCoverage?.(options);
  },
  async stopCoverage(options) {
    return (await v8()).stopCoverage?.(options);
  },
};

const provider: CoverageProviderModule =
  typeof window === "undefined"
    ? nodeProvider
    : {
        getProvider() {
          throw new Error("The v8 coverage provider runs on Node only.");
        },
      };

export default provider;
