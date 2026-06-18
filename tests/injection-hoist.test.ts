import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";

/** Transpile and split diagnostics for assertion. */
function diag(source: string, validate = true) {
  const result = transpile(source, { fileName: "t.actio.yml", validate });
  return {
    result,
    errors: result.diagnostics.filter((d) => d.severity === "error"),
    warnings: result.diagnostics.filter((d) => d.severity === "warning"),
  };
}

function byCode(diags: { code?: string }[], code: string) {
  return diags.filter((d) => d.code === code);
}

const wrap = (steps: string, opts = "") => `name: t
on: [issues]
jobs:
  b:
    runs-on: ubuntu-latest${opts}
    steps:
${steps}
`;

describe("injection-hoist errors", () => {
  it("errors on an untrusted expression inside a quoted heredoc", () => {
    const { errors } = diag(
      wrap(`      - run: |
          cat <<'EOF'
          title: \${{ github.event.issue.title }}
          EOF`),
    );
    const hit = byCode(errors, "injection-hoist/quoted-heredoc");
    expect(hit.length, JSON.stringify(errors, null, 2)).toBe(1);
    expect(hit[0]?.range, "quoted-heredoc error should carry a range").toBeTruthy();
  });

  it("errors on an untrusted expression inside single quotes", () => {
    const { errors } = diag(wrap(`      - run: echo '\${{ github.event.issue.title }}'`));
    const hit = byCode(errors, "injection-hoist/single-quote");
    expect(hit.length, JSON.stringify(errors, null, 2)).toBe(1);
    expect(hit[0]?.range).toBeTruthy();
  });

  it("errors (no rewrite) when injectionHoist mode is error", () => {
    const src = wrap(
      `      - run: echo "\${{ github.event.issue.title }}"`,
      `
    injectionHoist: error`,
    );
    const { errors, result } = diag(src);
    const hit = byCode(errors, "injection-hoist/untrusted");
    expect(hit.length, JSON.stringify(errors, null, 2)).toBe(1);
    // error mode must NOT rewrite the body.
    expect(result.yaml).toContain("${{ github.event.issue.title }}");
    expect(result.yaml).not.toContain("ISSUE_TITLE");
  });
});

describe("injection-hoist warnings", () => {
  it("warns and does not rewrite a python body, but still emits the env entry", () => {
    const { warnings, result } = diag(
      wrap(`      - shell: python
        run: print("\${{ github.event.issue.title }}")`),
    );
    expect(byCode(warnings, "injection-hoist/python").length).toBe(1);
    expect(result.yaml).toContain("ISSUE_TITLE: ${{ github.event.issue.title }}");
    // body left literal
    expect(result.yaml).toContain('print("${{ github.event.issue.title }}")');
  });

  it("warns on an unsupported shell, emitting the env entry without a rewrite", () => {
    const { warnings, result } = diag(
      wrap(`      - shell: cmd
        run: echo "\${{ github.event.issue.title }}"`),
    );
    expect(byCode(warnings, "injection-hoist/unsupported-shell").length).toBe(1);
    expect(result.yaml).toContain("ISSUE_TITLE: ${{ github.event.issue.title }}");
    expect(result.yaml).toContain('echo "${{ github.event.issue.title }}"');
  });

  it("warns when an untrusted value sits inside a complex expression it cannot hoist", () => {
    const { warnings } = diag(
      wrap(`      - run: echo "\${{ format('t-{0}', github.event.issue.title) }}"`),
    );
    const hit = byCode(warnings, "injection-hoist/complex-expression");
    expect(hit.length, JSON.stringify(warnings, null, 2)).toBe(1);
    expect(hit[0]?.range).toBeTruthy();
  });

  it("warns (hoisted) when mode is warn", () => {
    const { warnings, result } = diag(
      wrap(
        `      - run: echo "\${{ github.event.issue.title }}"`,
        `
    injectionHoist: warn`,
      ),
    );
    expect(byCode(warnings, "injection-hoist/hoisted").length).toBe(1);
    // warn mode still rewrites.
    expect(result.yaml).toContain("$ISSUE_TITLE");
  });

  it("warns on an invalid injectionHoist mode and ignores it (defaults to fix)", () => {
    const { warnings, result } = diag(
      wrap(
        `      - run: echo "\${{ github.event.issue.title }}"`,
        `
    injectionHoist: loud`,
      ),
    );
    expect(byCode(warnings, "injection-hoist/invalid-mode").length).toBe(1);
    // falls back to fix -> still hoists.
    expect(result.yaml).toContain("$ISSUE_TITLE");
  });

  it("warns on a non-boolean unsafe knob and ignores it", () => {
    const { warnings, result } = diag(
      wrap(`      - run: echo "\${{ github.event.issue.title }}"
        unsafe: "yes"`),
    );
    expect(byCode(warnings, "injection-hoist/invalid-config").length).toBe(1);
    // invalid unsafe ignored -> still hoists.
    expect(result.yaml).toContain("$ISSUE_TITLE");
  });

  it("warns on non-string trust entries and ignores them", () => {
    const { warnings } = diag(
      wrap(`      - run: echo "\${{ github.event.issue.title }}"
        trust:
          - 42`),
    );
    expect(byCode(warnings, "injection-hoist/invalid-config").length).toBe(1);
  });
});

describe("injection-hoist seam + scoping guards", () => {
  it("does not hoist the actio share namespace, but still hoists untrusted siblings", () => {
    // share.* is not a real GHA context until #18 lands, so disable validation.
    const { result } = diag(
      wrap(`      - run: echo "\${{ share.buildId }} \${{ github.event.issue.title }}"`),
      false,
    );
    // share token left untouched...
    expect(result.yaml).toContain("${{ share.buildId }}");
    // ...while the untrusted sibling is hoisted.
    expect(result.yaml).toContain("ISSUE_TITLE: ${{ github.event.issue.title }}");
  });

  it("never hoists trusted contexts (sha/run_id/secrets)", () => {
    const { result, warnings, errors } = diag(
      wrap(`      - run: echo "\${{ github.sha }} \${{ github.run_id }} \${{ secrets.TOKEN }}"`),
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(result.yaml).toContain("${{ github.sha }}");
    expect(result.yaml).not.toContain("env:");
  });

  it("honors trust: to skip an otherwise-untrusted expression", () => {
    const { result } = diag(
      wrap(`      - run: echo "\${{ github.event.issue.title }}"
        trust:
          - github.event.issue.title`),
    );
    expect(result.yaml).toContain("${{ github.event.issue.title }}");
    expect(result.yaml).not.toContain("ISSUE_TITLE");
  });

  it("honors force: to hoist an otherwise-trusted expression", () => {
    const { result } = diag(
      wrap(`      - run: echo "\${{ github.actor }}"
        force:
          - github.actor`),
    );
    expect(result.yaml).toContain("ACTOR: ${{ github.actor }}");
    expect(result.yaml).toContain("$ACTOR");
  });

  it("does not hoist inside if:/name:/with: contexts", () => {
    const { result } = diag(
      wrap(`      - name: Title \${{ github.event.issue.title }}
        if: \${{ github.event.issue.title != '' }}
        uses: actions/github-script@v7
        with:
          script: console.log("\${{ github.event.issue.title }}")`),
    );
    expect(result.yaml).not.toContain("env:");
    expect(result.yaml).toContain("name: Title ${{ github.event.issue.title }}");
  });
});
