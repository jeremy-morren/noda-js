// Vitest's JUnit reporter, with each test file's suite (and each test's classname) named after its project too:
// "test/ported/LocalDateTest.test.ts [firefox]". The same file runs in the node, chromium, firefox and webkit
// projects, and a failure should say which one. `npm run test:ci` uses it with `--outputFile.junit=...`, like the
// built-in `junit` reporter.
//
// CI runs the projects on several machines, each writing a blob report labelled with where it ran (VITEST_BLOB_LABEL:
// "ubuntu", "windows", "macos", an iOS or Android device), and merges them with `vitest --merge-reports` (see
// .github/workflows/ci.yml). There the label follows the project: "test/ported/LocalDateTest.test.ts [firefox, macos]".

import { JUnitReporter, type TestModule } from "vitest/node";

type NameVariables = { filename: string; filepath: string; displayName: string };
type FileInfo = { name: string; label: string | undefined };

const key = (project: string, filepath: string) => `${project}\0${filepath}`;

export default class ProjectJUnitReporter extends JUnitReporter {
  // Each test file's name, relative to its own machine's checkout (Vitest's {filename} is relative to this one, which
  // doesn't work for another machine's paths), and its blob's label; by project and absolute path, as each machine
  // has its own checkout path and runs a project once.
  private readonly files: Map<string, FileInfo>;

  constructor() {
    const files = new Map<string, FileInfo>();
    const name = (vars: NameVariables) => {
      const file = files.get(key(vars.displayName, vars.filepath));
      const project = file?.label ? `${vars.displayName}, ${file.label}` : vars.displayName;
      return `${file?.name ?? vars.filename} [${project}]`;
    };
    super({ suiteNameTemplate: name, classnameTemplate: name });
    this.files = files;
  }

  override onTestRunEnd(testModules: ReadonlyArray<TestModule>, unhandledErrors?: Parameters<JUnitReporter["onTestRunEnd"]>[1]): Promise<void> {
    // (When merging, each module's project is the blob's: scripts/merge-test-reports.ps1 defines every project.)
    for (const testModule of testModules) {
      this.files.set(key(testModule.project.name, testModule.moduleId), {
        name: testModule.relativeModuleId,
        label: testModule.meta().__vitest_label__,
      });
    }
    return super.onTestRunEnd(testModules, unhandledErrors);
  }
}
