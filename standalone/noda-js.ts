// The single-file ES module (noda-js.js, in the noda-js-module-<version>.zip / .tar.gz release assets): everything in
// the noda-js package in one module, for use without a bundler or package manager (a browser's
// <script type="module">, Deno, embedded engines such as QuickJS). A single file can't be tree-shaken, so it has it
// all: the core, every calendar system, the bundled tzdb, every culture (registered for
// NodaCultureInfo.CurrentCulture), the system and Windows providers, the tzdb compiler, the testing helpers and the
// linq comparers.
// Built by standalone/build.ts (npm run build:module).

export * from "../src/noda-js/index.ts";
export * from "../src/noda-js/entries/tzdb-bundled.ts";
export * from "../src/noda-js/entries/tzdb-compiler.ts";
export * from "../src/noda-js/entries/system.ts";
export * from "../src/noda-js/entries/windows.ts";
export * from "../src/noda-js/entries/testing.ts";
export * from "../src/noda-js/entries/linq.ts";
export * from "../src/noda-js/Cultures/index.generated.ts";
import "../src/noda-js/Cultures/all.generated.ts";
import "../src/noda-js/entries/calendars/all.ts";
