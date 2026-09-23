# Share one selection across workflows

This example selects a runner once, then runs checks and tests in two reusable workflows. It is sample configuration, outside open-ci's active workflows.

Copy these three files **directly** into your repository's `.github/workflows/` directory:

| Example | Destination |
| --- | --- |
| [ci.yml](ci.yml) | `.github/workflows/ci.yml` |
| [shared-checks.yml](shared-checks.yml) | `.github/workflows/shared-checks.yml` |
| [shared-tests.yml](shared-tests.yml) | `.github/workflows/shared-tests.yml` |

Merge the parent into an existing CI entrypoint if necessary. Do not copy the `shared-selection` directory underneath `.github/workflows/`: reusable workflows must be directly in that directory. Keep the local `uses` paths in sync if you rename files.

Configure `OPEN_CI_SELECTOR_RUNS_ON` as a JSON Linux x64 target, preferably a dedicated self-hosted runner such as `["self-hosted","open-ci-selector"]`. Set `OPEN_CI_CONFIG` and/or `.github/open-ci.yml` using the [policy example](../open-ci.yml). For metered providers, configure the [billing credentials](../../docs/configuration.md#workflow-inputs-variables-and-secrets). The parent passes them only to open-ci; the children need no billing Secrets.

The sample workload uses Node.js 24, a committed npm lockfile, `npm run check`, and `npm test`. Replace those steps with your existing checkout, installation, checks, and tests. Both workloads must support the same provider policy and runner requirements. Only independent work should run in parallel. The parent permits main pushes, manual runs, and same-repository pull requests; adapt that trust boundary before allowing untrusted code on persistent runners.

The children share the selected target, but each job still needs a runner. They may run on different matching machines; neither should rely on files or tools left by the selector or the other child. This is why both children retain their own checkout and installation steps.

`runner` carries the output JSON unchanged, including string targets (`"ubuntu-24.04"`), labels arrays (`["self-hosted","linux","x64"]`), and group/labels objects (`{"group":"workers","labels":["linux","x64"]}`). Each child interprets it with `fromJSON(inputs.runner)`. If a child needs provider-specific setup, declare an additional string input named `provider` and pass the selector's `provider` output. Pass `reason` only when reporting needs it.

Selection, including its post cleanup when the runner is available, finishes before the two children start. The selector releases its runner while the parent workflow run remains active. There are three job checks here: `select-runner`, `checks / check`, and `tests / test`, each with its own status and logs. Matrix jobs add more checks. Confirm the actual names in a test run before changing required-check settings. If you already use an `always()` required aggregate gate, retain its failure reporting as described in [adopting an existing CI](../../docs/configuration.md#adopting-an-existing-ci).

Failed, cancelled, or skipped selection prevents both calls; empty output is never passed to a child's `fromJSON`. This shares one observation within one run. Independent workflow runs still select separately. Selection does not reserve usage or prevent charges as concurrent or long-running workloads consume more minutes.

To lint the example with the same local workflow paths that GitHub will resolve after copying, run from the open-ci repository root with `actionlint` installed:

```sh
example_root=$(mktemp -d)
mkdir -p "$example_root/.github/workflows" "$example_root/.git"
cp examples/shared-selection/*.yml "$example_root/.github/workflows/"
(cd "$example_root" && actionlint .github/workflows/*.yml)
rm -r "$example_root"
```

`npm run verify` also checks YAML and the connections between these files. See [sharing a selection across workflows](../../docs/configuration.md#sharing-a-selection-across-workflows) for the execution contract and GitHub documentation.
