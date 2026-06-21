import { type PinPolicy, transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type StepObj = Record<string, unknown>;

/**
 * Emit-oracle: feed a single-step job, transpile, and read the emitted steps
 * back out. The proof for the artifacts macro is the trailing upload step it
 * splices in, so we assert against the compiled YAML the runner would see.
 */
function compile(
  artifactsStep: StepObj,
  opts: Parameters<typeof transpile>[1] = {},
  extraSteps: StepObj[] = [],
) {
  const source = `
name: ci
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${[artifactsStep, ...extraSteps].map((s) => `      - ${JSON.stringify(s)}`).join("\n")}
`;
  const result = transpile(source, { header: false, validate: false, ...opts });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const doc = result.yaml ? parse(result.yaml) : undefined;
  const steps = (doc?.jobs?.build?.steps ?? []) as StepObj[];
  return { result, errors, steps, yaml: result.yaml };
}

const pinPolicy = (over: Partial<PinPolicy> = {}): PinPolicy => ({
  enabled: true,
  thirdParty: true,
  github: false,
  docker: true,
  allow: [],
  comment: "tag",
  ...over,
});

describe("artifacts macro", () => {
  it("appends an upload step right after its run step", () => {
    const { errors, steps } = compile({
      run: "npm run build",
      artifacts: { paths: "dist/**", name: "build-output" },
    });
    expect(errors).toEqual([]);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ run: "npm run build" });
    expect(steps[1]).toMatchObject({
      name: "Upload artifacts",
      if: "always()",
      uses: "actions/upload-artifact@v4",
      with: { name: "build-output", path: "dist/**" },
    });
  });

  it("strips the artifacts key off the original step", () => {
    const { steps } = compile({ run: "make", artifacts: { paths: "out/**", name: "x" } });
    expect(steps[0]).not.toHaveProperty("artifacts");
  });

  it("joins a list of paths into the multiline path input", () => {
    const { errors, steps } = compile({
      run: "make",
      artifacts: { paths: ["coverage/**", "reports/**"], name: "out" },
    });
    expect(errors).toEqual([]);
    expect((steps[1].with as StepObj).path).toBe("coverage/**\nreports/**");
  });

  it("maps retention-days as an integer", () => {
    const { errors, steps } = compile({
      run: "make",
      artifacts: { paths: "dist/**", name: "out", "retention-days": 7 },
    });
    expect(errors).toEqual([]);
    expect((steps[1].with as StepObj)["retention-days"]).toBe(7);
  });

  it("honors a custom if expression on the upload step", () => {
    const { steps } = compile({
      run: "make",
      artifacts: { paths: "dist/**", name: "out", if: "success()" },
    });
    expect(steps[1].if).toBe("success()");
  });

  it("defaults if to always() so artifacts upload even on failure", () => {
    const { steps } = compile({ run: "make", artifacts: { paths: "dist/**", name: "out" } });
    expect(steps[1].if).toBe("always()");
  });

  it("derives a unique name when none is provided", () => {
    const { steps } = compile({ run: "npm test", artifacts: { paths: "dist/**" } });
    // job id `build` + step label `npm test` -> slug
    expect((steps[1].with as StepObj).name).toBe("build_npm_test");
  });

  it("derives collision-free names for two unnamed uploads in the same job", () => {
    const { steps } = compile({ run: "make", artifacts: { paths: "a/**" } }, {}, [
      { run: "make", artifacts: { paths: "b/**" } },
    ]);
    const names = steps.filter((s) => s.uses).map((s) => (s.with as StepObj).name);
    expect(names).toEqual(["build_make", "build_make-2"]);
  });

  it("never lets a derived name shadow an explicit one elsewhere in the job", () => {
    const { steps } = compile(
      { run: "make", artifacts: { paths: "a/**", name: "build_make" } },
      {},
      [{ run: "make", artifacts: { paths: "b/**" } }],
    );
    const names = steps.filter((s) => s.uses).map((s) => (s.with as StepObj).name);
    expect(names).toEqual(["build_make", "build_make-2"]);
  });

  it("emits a configured custom uploader ref", () => {
    const { steps } = compile(
      { run: "make", artifacts: { paths: "dist/**", name: "out" } },
      { artifacts: { uploader: "myorg/uploader@v1" } },
    );
    expect(steps[1].uses).toBe("myorg/uploader@v1");
  });

  it("flows the uploader ref through the pin pass", () => {
    const sha = "a".repeat(40);
    const { steps, yaml } = compile(
      { run: "make", artifacts: { paths: "dist/**", name: "out" } },
      {
        artifacts: { uploader: "myorg/uploader@v1" },
        pin: {
          policy: pinPolicy(),
          resolutions: { "myorg/uploader@v1": { digest: sha } },
        },
      },
    );
    expect(steps[1].uses).toBe(`myorg/uploader@${sha}`);
    expect(yaml).toContain(`uses: myorg/uploader@${sha} # v1`);
  });

  it("leaves steps without an artifacts key untouched", () => {
    const { steps } = compile({ run: "echo hi" });
    expect(steps).toEqual([{ run: "echo hi" }]);
  });

  describe("diagnostics", () => {
    it("errors when paths is missing", () => {
      const { errors } = compile({ run: "make", artifacts: { name: "x" } });
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("artifacts-paths");
    });

    it("errors when paths is an empty string", () => {
      const { errors } = compile({ run: "make", artifacts: { paths: "" } });
      expect(errors[0].code).toBe("artifacts-paths");
    });

    it("errors when paths is an empty list", () => {
      const { errors } = compile({ run: "make", artifacts: { paths: [] } });
      expect(errors[0].code).toBe("artifacts-paths");
    });

    it("errors on a non-integer retention-days", () => {
      const { errors } = compile({
        run: "make",
        artifacts: { paths: "a/**", "retention-days": 2.5 },
      });
      expect(errors[0].code).toBe("artifacts-retention");
    });

    it("errors on a zero or negative retention-days", () => {
      const { errors } = compile({
        run: "make",
        artifacts: { paths: "a/**", "retention-days": -3 },
      });
      expect(errors[0].code).toBe("artifacts-retention");
    });

    it("errors when artifacts is not a mapping", () => {
      const { errors } = compile({ run: "make", artifacts: "dist/**" });
      expect(errors[0].code).toBe("artifacts-shape");
    });

    it("keeps the original run step after a bad spec", () => {
      const { steps } = compile({ run: "make", artifacts: { name: "x" } });
      expect(steps).toEqual([{ run: "make" }]);
    });
  });
});
