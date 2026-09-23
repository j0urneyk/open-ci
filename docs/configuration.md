# Configuration reference

Policy precedence is built-in defaults, the Action's `config` JSON input, repository YAML, then the `priority` input. The examples pass `vars.OPEN_CI_CONFIG` as `config`; GitHub chooses the repository Variable over an organization Variable with the same name. Ordinary objects merge by field. Priority arrays and every `runs-on` value replace their predecessors completely, including group/labels objects.

The repository file defaults to `.github/open-ci.yml` at the run's `GITHUB_SHA`. An absent default file is allowed. Setting `config-path` explicitly makes a missing file an error, even when the explicit value is `.github/open-ci.yml`. Files are read through the GitHub Contents API without checking out or executing caller code. Changes to the base Variable or usage can still change a rerun's result.

## Policy fields

| Field | Contract |
| --- | --- |
| `version` | `1`; omitted means `1` |
| `priority` | Required after merging. Nonempty JSON/YAML array of unique `github`, `blacksmith`, `self-hosted` identifiers |
| `providers` | Configurations keyed by those identifiers; unknown names are errors |
| `enabled` | Provider boolean, default `true`. Disabled placeholders are allowed but cannot appear in priority |
| `runs-on` | String, nonempty unique labels array, or an object with `group`, `labels`, or both |
| `free-minutes` | Required for enabled metered providers, finite number at least zero. Zero means no remaining allowance |
| `reserve-percent` | Metered providers only, default `5`, finite number from `0` inclusive to `100` exclusive |
| `billing-cycle.anchor` | Operator-supplied monthly reset anchor, UTC RFC3339 without fractional seconds. The anchor must be at or before execution; open-ci does not verify the provider's reset schedule |
| `sku-minute-multipliers` | GitHub only: explicit gross-minute → allowance-minute factors for every observed Actions minute SKU. Missing observed SKU skips the candidate |

Self-hosted providers accept only `enabled` and `runs-on`. No usage or availability request is made for them. Each layer is size-limited to 48 KiB. Duplicate keys, YAML aliases, custom tags, `null`, unsafe object keys, and unsupported fields are rejected. Configuration errors fail the selector; they do not trigger a quiet fallback.

Every enabled provider must have its required fields after merging, even when it is absent from priority. This also applies to GitHub in public repositories: its metered policy fields are required by configuration validation, although a recognized standard runner is selected without querying billing or applying the allowance threshold.

The [JSON Schema](../schema/open-ci.schema.json) describes partial configuration for editors. The runtime validates the fully merged result, including required provider fields, real calendar dates, and priority membership.

For example, this file retains an existing common GitHub quota policy but replaces the runner target and priority:

```yaml
priority: [github, self-hosted]
providers:
  github:
    runs-on: ubuntu-24.04
  self-hosted:
    runs-on:
      group: repository-workers
      labels: [linux, x64]
```

## Billing windows and units

Usage covers the organization across repositories. A repository override can change the selection policy but cannot narrow billing usage to that repository. The default reserve is 5%; a metered provider is eligible only while usage is strictly below `free-minutes × (1 − reserve-percent / 100)`. Reaching the threshold, including equality, moves selection to the next candidate.

An anchor such as `2026-01-01T00:00:00Z` declares a reset at UTC midnight on the first of each month. Verify it against the account's allowance period, and record any unverified assumption in the caller's policy. Neither the anchor nor the free allowance is discovered from the usage API. GitHub's monthly summary adapter requires this calendar-month boundary. Other anchors are rejected for GitHub rather than querying a wrong period. Blacksmith supports other UTC monthly reset days/times; a day beyond the end of a shorter month clamps to that month's last day without changing later months. Anchors use fixed UTC time, not daylight-saving time rules.

The configured GitHub allowance and SKU factors must use the same units. A mapping such as `actions_linux: 1` asserts that one gross minute of that SKU consumes one configured allowance minute. An explicit factor `0` excludes a SKU verified not to consume that allowance, such as a paid-only larger runner SKU. Do not derive factors from dollar rates or map an unknown SKU to zero. All observed compute SKUs in private repositories need a verified factor, including those used by other repositories or operating systems. Public repository usage does not consume the included allowance and is excluded before normalization.

The GitHub adapter discovers repositories through the organization's billing report, checks their current visibility, and sums usage summaries for every private repository. Missing repository identity or inaccessible metadata makes GitHub unavailable; it never silently omits an unclassified repository. Renames, deletions, or visibility changes during a billing period may require manual reconciliation with GitHub billing before relying on the remaining allowance.

Blacksmith's configured allowance is in x64 Linux 2-vCPU equivalent minutes. CLI 0.4.60 documents `billing_minutes` as platform-weighted vCPU minutes; open-ci divides by two. It does not use wall-clock runtime or estimated spend as the allowance count.

Blacksmith queries end at the current whole second because the CLI reports timestamps at that precision. The response must still match the requested window exactly; the lookup timestamp retains its original precision. That match proves the requested range was returned, not that the range matches the provider's free-tier reset. A dashboard's month-to-date filter alone does not establish the reset timezone.

Compare the adapter's normalized usage with the dashboard's free-tier consumption for the same period and unit. Raw runtime minutes can differ when runners have different vCPU counts or platforms. A dollar usage estimate and the amount due after discounts are also different quantities. This policy counts runner compute minutes only; storage, cache, sticky-disk, and other charges are outside its scope.

## Workflow inputs, Variables, and Secrets

Call the root Action with `uses: j0urneyk/open-ci@v1` in `steps`. Pass configuration, Variables, and Secrets explicitly through `with`; the Action does not read the caller's `vars` or `secrets` contexts automatically. Set the selector job's runner, timeout, and job outputs in the calling workflow as shown in the [caller example](../examples/caller-workflow.yml).

| Name | Location | Meaning |
| --- | --- | --- |
| `config` | Action input | Optional base JSON policy; defaults to empty |
| `priority` | Action/workflow input | JSON array replacing policy priority; empty uses policy |
| `config-path` | Action/workflow input | Explicit file path; empty uses optional default |
| `github-token` | Required Action input | Calling repository token with Contents read access; pass `github.token` |
| `app-id` | Action input | Billing App ID when using App credentials |
| `selector-runs-on` | Reusable workflow input only | JSON selector target overriding the selector Variable |
| `OPEN_CI_SELECTOR_RUNS_ON` | Caller Variable | JSON runner target used by examples and as the reusable workflow default |
| `OPEN_CI_CONFIG` | Caller Variable | Optional JSON passed to `config`; mapped automatically by the reusable workflow |
| `OPEN_CI_GITHUB_APP_ID` | Caller Variable | ID passed to `app-id`; mapped automatically by the reusable workflow |
| `OPEN_CI_GITHUB_APP_PRIVATE_KEY` | Caller Secret (example name) | Complete PEM file, passed explicitly as `app-private-key` |
| `OPEN_CI_BLACKSMITH_TOKEN` | Caller Secret (example name) | Organization token, passed explicitly as `blacksmith-token` |
| `app-private-key` | Action input / workflow Secret | Organization-installed billing App private key |
| `billing-token` | Action input / workflow Secret | Alternative billing token, takes precedence over App credentials |
| `blacksmith-token` | Action input / workflow Secret | Blacksmith organization token |

GitHub billing credentials require organization `Administration: read` plus `Metadata: read` access to all repositories appearing in the Actions billing report. Configure the billing App installation or fine-grained PAT repository access accordingly. No repository Contents permission is required by this billing path. On GitHub Free, private repositories must store these Secrets and Variables at repository level because organization-level sharing is unavailable.

For GitHub App setup, register an organization-owned App with those read-only permissions, disable webhooks and user OAuth, and install it on all organization repositories. Store its App ID in `OPEN_CI_GITHUB_APP_ID` and pass it as `app-id`. Generate a private key, save the complete PEM as an Actions Secret such as `OPEN_CI_GITHUB_APP_PRIVATE_KEY`, and pass that Secret as `app-private-key` as shown in the [caller example](../examples/caller-workflow.yml). Client ID, Client Secret, and Installation ID inputs are not needed. Omit `billing-token` when using App authentication because an explicit billing token takes precedence.

The caller Secret names above are conventions used by the example. Root Action calls pass them through `with`; reusable workflow calls pass them through `secrets`. Keep the PEM's header, footer, and line breaks. Installation tokens minted by open-ci are revoked after lookup when the API permits it. An active rate-limit cooldown also applies to revocation; if it prevents that request, the token remains valid until its normal expiry. A supplied `billing-token` remains caller-owned and is neither minted nor revoked by open-ci.

For Blacksmith, an organization administrator can use the installed official CLI to run `blacksmith org-token create --label open-ci --organization YOUR_ORG`. Complete browser authentication, then save the token as the caller Secret. The CLI displays a newly created organization token once and does not save it in local credentials. To replace a lost token, mint a new one and update the Secret; replacing the Secret does not revoke the old provider token. See [Blacksmith authentication](https://docs.blacksmith.sh/blacksmith-cli/overview).

The selector target is separate because a runner must be allocated before repository YAML can be read. Blacksmith's bundled CLI requires a Linux x64 selector. Workload targets are preserved without OS/architecture restrictions.

## Calling the reusable workflow

The optional reusable workflow provides the selector job, its five-minute timeout, and job outputs. It maps `OPEN_CI_CONFIG`, `OPEN_CI_GITHUB_APP_ID`, and `github.token` to the same Action inputs. Existing calls and the published `j0urneyk/open-ci/action@REF` entrypoint retain their contracts.

```yaml
jobs:
  select-runner:
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    uses: j0urneyk/open-ci/.github/workflows/select-runner.yml@v1
    with:
      selector-runs-on: '["self-hosted","open-ci-selector"]'
    secrets:
      app-private-key: ${{ secrets.OPEN_CI_GITHUB_APP_PRIVATE_KEY }}
      blacksmith-token: ${{ secrets.OPEN_CI_BLACKSMITH_TOKEN }}
```

Grant `contents: read` in the caller and connect downstream jobs to the returned `runs-on` exactly as for the root Action. Switching entrypoints does not change provider order, allowance calculations, or credential cleanup.

## Outputs and selection timing

| Output | Contract |
| --- | --- |
| `provider` | Selected identifier: `github`, `blacksmith`, or `self-hosted` |
| `runs-on` | JSON encoding of the selected string, labels array, or group/labels object. Use `fromJSON(needs.select-runner.outputs.runs-on)` as the workload's `runs-on` |
| `reason` | Human-readable selection explanation; do not parse it as a stable status code |

Root Action outputs are step outputs. Map each needed value through the selector job's `outputs` before using it from another job; the reusable workflow supplies that mapping. Job Summary records attempted providers, selection reasons, and available usage, billing-window, and lookup-time evidence. Providers after the first eligible candidate are not queried.

Use one selector job and share its outputs through `needs` for jobs that should use the same decision. A separate invocation for a later job obtains a new observation. Selection does not reserve usage, so concurrent jobs and delayed provider reports can exceed an allowance. A queued or running workload is not reassigned after selection.

## Sharing a selection across workflows

One parent can select once and pass the JSON `runs-on` output as a string input named `runner` to multiple reusable workflows. The [complete example](../examples/shared-selection/README.md) includes two children. Copy all three YAML files directly into the caller repository's `.github/workflows/` directory; GitHub does not support nested reusable workflow directories. Each caller job uses `uses` without `runs-on`; the child's execution job owns `runs-on: ${{ fromJSON(inputs.runner) }}`. See GitHub's [reusable workflow input and calling rules](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).

Preserve the JSON string without adding quotes or converting it into a labels-only representation. String, array, and group/labels targets all use the same input. Pass `provider` as another string input only for provider-specific work, and `reason` only for reporting. Keep billing credentials in the selector; pass only Secrets and permissions that the child actually needs.

Each workload job is scheduled separately on a runner matching the shared target. Sharing the decision does not reduce the number of workload jobs or guarantee the same machine or workspace. Keep checkout and setup in each child, and use explicit artifacts or outputs to pass results between jobs. GitHub describes this allocation in [choosing a runner for a job](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idruns-on).

Each call directly needs the selector and requires successful selection with nonempty output. Failure, cancellation, or a skipped selector prevents child execution and avoids parsing empty JSON. Keep any existing required aggregate gate capable of reporting failure even when children are skipped.

The selector job, including its post actions when the runner remains available, completes and releases its runner before dependent children start. The parent workflow run stays active until its jobs finish. Child job checks have separate progress, outcomes, and logs within that run, typically named `caller-job / child-job`. With one execution job per child, N children plus the selector produce N+1 job checks; matrices and aggregate gates change that count. Confirm actual check names before changing branch requirements.

This works within a single call flow with compatible runner requirements. Separately triggered workflows, including later manual runs, make independent selections. Concurrent and long-running jobs can consume usage beyond the observation made at selection time; no usage is reserved. Keep existing dependencies, publication gates, and event trust rules. If setting concurrency in children, use groups distinct from the parent's: reusing a `github.workflow` group with cancellation can cancel the caller, as described in GitHub's [reusable workflow reference](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations).

## Adopting an existing CI

Every job using the selector's outputs must list the selector directly in `needs`, alongside its existing dependencies. Keep build, test, and publication gates intact. An `if: always()` aggregate check needs a usable runner even if selection fails; a fixed trusted self-hosted target can report failed or skipped prerequisites without parsing a missing `runs-on` output. It must treat those prerequisites as failure, not silently pass.

Runner labels select machines; they do not ensure equivalent tools, architecture, Docker configuration, disk capacity, or network access. Prepare these for every allowed workload target. Persistent self-hosted hosts should be configured outside jobs that might restart a shared Docker daemon. Workloads using executable temporary files may also need `TMPDIR` set to `RUNNER_TEMP` when `/tmp` is mounted `noexec`. open-ci uses that directory for its own CLI but does not configure workload steps or their concurrency.

The caller controls event trust and access to persistent runners. Missing billing Secrets can select self-hosted through fallback, so Secret absence alone is not a fork-PR safeguard. The [caller example](../examples/caller-workflow.yml) skips fork pull requests before allocating its selector. Repository policy is read without executing caller code; downstream checkout and build steps remain the caller's responsibility.

## Failure behavior

A malformed policy, unknown or disabled priority entry, unsupported personal owner, or unreadable required policy file fails the selector. A usage API/authentication failure, unexpected report shape, period/organization mismatch, unmapped compute SKU, unverified GitHub runner target, or exhausted allowance skips that provider. When every candidate is skipped, the job fails and its summary retains the attempts. Self-hosted being selectable is not a claim that a matching machine is online.

Cancellation stops selection; it does not trigger fallback. Blacksmith CLI subprocesses are terminated on cancellation. The action removes its temporary CLI and credentials in normal cleanup and registers the same directory for an `always()` post action. Post cleanup requires the runner to remain available; it cannot run after the machine is lost.

Blacksmith uses a dedicated subdirectory of `RUNNER_TEMP` so a hardened runner's system `/tmp` can remain mounted `noexec`. The job temporary directory must permit execution. Outside Actions, when `RUNNER_TEMP` is absent, the operating system temporary directory is used. Cleanup accepts only the action's named directories directly under these temporary roots.

GitHub HTTP requests use up to three attempts with 15-second timeouts. Retries respect `Retry-After` and, when the quota is exhausted, `x-ratelimit-reset`; when both apply, the later deadline wins. Required waits up to five seconds are honored in full. Longer waits or invalid timing headers stop the request rather than shortening the delay. A secondary rate limit without timing headers requires at least one minute, so it is not retried. A headerless HTTP 403 is also handled conservatively: it fails immediately and blocks follow-up calls for one minute because it may indicate secondary throttling. The cooldown is retained per credential within the Action process and also blocks follow-up requests, including token revocation. A blocked billing lookup skips GitHub; a blocked caller metadata or policy lookup fails the selector because its configuration cannot be established. Network failures and server errors without a cooldown retain bounded exponential backoff.

Blacksmith download and CLI calls have 30-second timeouts; usage queries have at most three attempts. Set a job timeout when calling the root Action; the examples and reusable job use five minutes. No usage is persisted between runs. Reporting time is not necessarily aggregation time, and this implementation does not promise a provider freshness SLA.
