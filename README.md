# open-ci

Choose a GitHub Actions runner before a job starts, using your organization's free allowance and a provider priority list. When an earlier provider reaches its threshold or its usage cannot be read, open-ci tries the next configured provider. Your existing build and test steps stay in their repository.

Supported providers are GitHub-hosted runners, Blacksmith, and self-hosted runners. Organization-owned public and private repositories are supported. Self-hosted runners have no usage quota and are not probed for availability.

## Setup

Provide a dedicated Linux x64 self-hosted runner for the selector, accessible to each calling repository. It needs a GitHub Actions runner version supporting Node.js 24 actions and outbound access to GitHub and, when selected, Blacksmith. Blacksmith CLI 0.4.60 is downloaded lazily, checked against a pinned SHA-256, authenticated in a temporary directory under `RUNNER_TEMP`, and removed afterward. That job directory must allow executable files; the system temporary directory is used only outside Actions when `RUNNER_TEMP` is absent.

The examples use the organization or repository Variable `OPEN_CI_SELECTOR_RUNS_ON` as a JSON runner target, for example `["self-hosted","open-ci-selector"]`. You can also set the selector job's `runs-on` directly. This is separate from the runners that execute your build jobs: the selector needs a runner before it can read repository configuration.

Put common JSON policy in `OPEN_CI_CONFIG`, a repository override in `.github/open-ci.yml`, or both. The smallest policy uses only self-hosted workers and needs no billing credentials:

```yaml
version: 1
priority: [self-hosted]
providers:
  self-hosted:
    runs-on: [self-hosted, linux, x64]
```

For the full provider example, see [examples/open-ci.yml](examples/open-ci.yml) and the [configuration reference](docs/configuration.md). Verify free allowances, SKU conversion factors, and billing reset boundaries before enabling metered providers.

## Use the Action

Use `j0urneyk/open-ci@v1.0.0` in a selector job, then pass its output to your build or test job. The Action reads policy through the GitHub API, so the selector does not need to check out your repository. The integration targets GitHub.com.

```yaml
permissions:
  contents: read

jobs:
  select-runner:
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ${{ fromJSON(vars.OPEN_CI_SELECTOR_RUNS_ON) }}
    timeout-minutes: 5
    outputs:
      runs-on: ${{ steps.select.outputs.runs-on }}
    steps:
      - id: select
        uses: j0urneyk/open-ci@v1.0.0
        with:
          config: ${{ vars.OPEN_CI_CONFIG }}
          github-token: ${{ github.token }}
  test:
    needs: select-runner
    runs-on: ${{ fromJSON(needs.select-runner.outputs.runs-on) }}
    steps:
      - uses: actions/checkout@v6
      - run: ./ci/test.sh
```

Keep your existing steps in place of the example test script. The example skips fork pull requests; choose which events may use your self-hosted runners before adapting it. Use the [metered-provider caller example](examples/caller-workflow.yml) to pass Secrets explicitly. A `priority` JSON input replaces the policy's order; omitted providers are never added. Outputs are `provider`, JSON `runs-on`, and `reason`. Job Summary records the decisions and available usage evidence.

`v1.0.0` identifies the published release. Use a full commit SHA to pin exact code. The reusable workflow is also available at `j0urneyk/open-ci/.github/workflows/select-runner.yml@v1.0.0` for callers that prefer a complete selector job; see [calling the reusable workflow](docs/configuration.md#calling-the-reusable-workflow).

## Credentials and limits

The `github-token` input reads repository metadata and the policy file at the run's `GITHUB_SHA`. Billing is a separate permission. For GitHub billing, pass `vars.OPEN_CI_GITHUB_APP_ID` as `app-id` and an organization-installed App's private key as `app-private-key`, or pass an existing billing token as `billing-token`. The billing credential needs organization `Administration: read` and repository `Metadata: read` access to every repository with reported Actions usage. For a fine-grained PAT, select the organization as resource owner and all its repositories; Contents access is not required for billing. Public repository usage is excluded before summing private repository minutes across the organization. Generated installation tokens are revoked after the lookup.

Store credentials in Actions Secrets and pass them explicitly from the caller. On GitHub Free, organization Secrets and Variables are unavailable to private repositories; use repository Secrets and Variables instead. The repository `GITHUB_TOKEN` is not a billing token. The [configuration reference](docs/configuration.md#workflow-inputs-variables-and-secrets) maps App ID, PEM private key, and Blacksmith token to their caller settings.

For Blacksmith, pass an organization token as `blacksmith-token`. A token is not placed in command arguments, logs, or your runner's existing CLI credentials. The action registers its temporary directory for post cleanup, including after cancellation when the runner can execute the post action; active CLI subprocesses stop without triggering fallback when cancelled. Missing credentials skip only the affected candidate. Public standard GitHub-hosted runners and self-hosted-first policies do not query billing. Fork pull requests normally do not receive repository Secrets; choose the provider policy and runner access appropriate for those events.

The default reserve is 5%: a metered candidate is skipped at **95% used**, including equality. You configure the free allowance and reset anchor; open-ci queries usage but does not discover or verify those account settings. This policy covers runner compute minutes, not storage, caches, sticky disks, or other charges. Usage is an observation, not a reservation; simultaneous jobs and provider reporting delays can exceed the allowance. GitHub custom/group targets whose free eligibility cannot be verified are skipped. Unknown minute SKUs also skip GitHub until their allowance factors are explicitly mapped. No provider is retried after a build starts, and queued jobs are not moved to another provider.

## Development and validation

Use Node.js 24 or newer and npm:

```sh
npm ci
npm run verify
```

The root `action.yml` is the input/output contract. The build writes the committed Node bundles under `action/dist/` and generates `action/action.yml` for the existing subdirectory entrypoint; consumers do not install npm dependencies. Tests use synthetic provider responses. An optional real-CLI check against a local synthetic API is available with `node scripts/verify-blacksmith-cli.mjs /path/to/blacksmith`; it requires the checksum-pinned 0.4.60 binary and does not contact a real organization.

See the [configuration reference](docs/configuration.md) for policy and workflow settings, and [provider contracts](docs/provider-contracts.md) for API behavior, usage interpretation, and integration requirements.
