import { type Diagnostic, transpile } from "actio-core";
import { describe, expect, it } from "vitest";

const compile = (source: string, unusedSymbols?: "off" | "warn" | "error") =>
  transpile(source, { fileName: "t.actio.yml", validate: false, unusedSymbols });

const unused = (diagnostics: Diagnostic[]) =>
  diagnostics.filter((d) => d.code?.startsWith("unused-"));

describe("unused symbol diagnostics", () => {
  it("warns on a declared param that is never referenced", () => {
    const source = `name: T
on: [push]
params:
  used:
    type: string
    default: a
  ghost:
    type: string
    default: b
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo {{ params.used }}
`;
    const diagnostics = unused(compile(source).diagnostics);
    expect(diagnostics).toHaveLength(1);
    const diag = diagnostics[0];
    expect(diag.code).toBe("unused-param");
    expect(diag.severity).toBe("warning");
    expect(diag.message).toContain("ghost");
    expect(diag.source).toBe("actio");
  });

  it("does not warn on a referenced param", () => {
    const source = `name: T
on: [push]
params:
  used:
    type: string
    default: a
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo {{ params.used }}
`;
    expect(unused(compile(source).diagnostics)).toHaveLength(0);
  });

  it("warns on a declared fragment that is never injected", () => {
    const source = `name: T
on: [push]
fragments:
  used:
    - run: echo used
  ghost:
    - run: echo ghost
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - inject: used
      - run: npm test
`;
    const diagnostics = unused(compile(source).diagnostics);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("unused-fragment");
    expect(diagnostics[0].message).toContain("ghost");
  });

  it("does not flag a fragment injected only by another used fragment", () => {
    const source = `name: T
on: [push]
fragments:
  inner:
    - run: echo inner
  outer:
    - inject: inner
    - run: echo outer
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - inject: outer
`;
    expect(unused(compile(source).diagnostics)).toHaveLength(0);
  });

  it("warns on a declared executor that is never referenced", () => {
    const source = `name: T
on: [push]
executors:
  used:
    runs-on: ubuntu-latest
  ghost:
    runs-on: ubuntu-latest
jobs:
  build:
    executor: used
    steps:
      - run: echo hi
`;
    const diagnostics = unused(compile(source).diagnostics);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("unused-executor");
    expect(diagnostics[0].message).toContain("ghost");
  });

  it("suppresses the warning for a symbol marked with # actio-keep", () => {
    const source = `name: T
on: [push]
params:
  keptp: # actio-keep
    type: string
    default: a
fragments:
  keptf: # actio-keep
    - run: echo hi
executors:
  kepte: # actio-keep
    runs-on: ubuntu-latest
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    expect(unused(compile(source).diagnostics)).toHaveLength(0);
  });

  it("emits nothing when the check is off", () => {
    const source = `name: T
on: [push]
params:
  ghost:
    type: string
    default: b
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    expect(unused(compile(source, "off").diagnostics)).toHaveLength(0);
  });

  it("escalates to an error and fails the build when severity is error", () => {
    const source = `name: T
on: [push]
params:
  ghost:
    type: string
    default: b
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const result = compile(source, "error");
    const diagnostics = unused(result.diagnostics);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("error");
    expect(result.ok).toBe(false);
  });

  it("defaults to warning when no severity is configured", () => {
    const source = `name: T
on: [push]
params:
  ghost:
    type: string
    default: b
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const result = transpile(source, { fileName: "t.actio.yml", validate: false });
    const diagnostics = unused(result.diagnostics);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("warning");
    expect(result.ok).toBe(true);
  });

  it("points the range at the declaration key, not its body", () => {
    const source = `name: T
on: [push]
params:
  used:
    type: string
    default: a
  ghost:
    type: string
    default: b
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo {{ params.used }}
`;
    const diag = unused(compile(source).diagnostics)[0];
    expect(diag.range?.start).toEqual({ line: 7, col: 3 });
  });
});
