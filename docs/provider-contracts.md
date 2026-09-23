# Provider contracts

This reference describes provider APIs, usage normalization, and runner requirements. Policy fields, credential setup, and caller responsibilities are defined in the [configuration reference](configuration.md).

## GitHub

The adapter uses `GET /organizations/{org}/settings/billing/usage` to discover repositories with Actions compute usage, then reads their metadata to exclude public repositories. It sums `GET /organizations/{org}/settings/billing/usage/summary` with `year`, `month`, `product=Actions`, and a `repository` filter for every private repository. API version is `2026-03-10`. It validates organization identity case-insensitively, checks the time period, reads `usageItems[*].grossQuantity`, and converts minute SKUs with configured `sku-minute-multipliers`. Pagination preserves the origin, path, period, and repository filter. The summary API is currently documented as public preview. [Billing API](https://docs.github.com/en/rest/billing/usage)

Reports include fully discounted public repository usage; summing the unfiltered organization gross total would overcount included minutes. Discount totals combine included usage and public-runner discounts, so neither gross nor net organization totals alone identify remaining free allowance. [Billing report fields](https://docs.github.com/en/billing/reference/billing-reports)

App installation tokens and fine-grained PATs are supported. Credentials require organization `Administration: read` and repository `Metadata: read` access for every repository appearing in the Actions compute report. Inaccessible metadata makes the provider unavailable; the adapter never silently excludes an unclassified repository. App tokens minted for lookup are revoked afterward when the API permits it; a rate-limit cooldown can prevent revocation, leaving the token valid until its normal expiry. Supplied billing tokens remain caller-owned.

API retries honor server deadlines; a required wait beyond five seconds makes the lookup unavailable instead of sending an early request. The same credential cannot bypass an active cooldown through a follow-up call. See [failure behavior](configuration.md#failure-behavior) for retry and cleanup details.

Current repository visibility is an observation, so visibility changes during the billing period require manual reconciliation. SKU conversion factors must match the account's included allowance; test fixtures and example policy values are not authoritative account settings.

Free runner eligibility uses the explicit standard-label set in [github-runner-usage.ts](../src/github-runner-usage.ts), based on [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). A string, one-label array, or labels-only object with a recognized label is accepted. Groups, multi-label constraints, larger-runner labels, and unknown names are skipped because their free eligibility cannot be established from the configured target. Standard public-repository runners skip billing lookup; private repositories evaluate the organization's allowance. [Billing rules](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

## Blacksmith

The adapter uses the official CLI with organization-token authentication. CLI 0.4.60 defines `billing_minutes` as platform-weighted vCPU minutes: divide by two to obtain the free-tier x64 Linux 2-vCPU equivalent. Raw runtime minutes and estimated dollar costs are not the allowance count. [Usage docs](https://docs.blacksmith.sh/blacksmith-cli/usage), [authentication](https://docs.blacksmith.sh/blacksmith-cli/overview), [free-tier units](https://docs.blacksmith.sh/blacksmith-runners/overview)

The response must contain `window.start`, `window.end`, `installation.installation_name`, `installation.installation_model_id`, and `summary.billing_minutes`. The installation must match the caller's organization and the returned window must match the requested range. Queries use whole-second precision because the CLI truncates fractional seconds.

The production integration runs CLI commands. The local server routes in [verify-blacksmith-cli.mjs](../scripts/verify-blacksmith-cli.mjs) are test scaffolding for the pinned CLI's serialization and flags, not a supported backend HTTP API.

Pinned binaries:

| Platform | Version | SHA-256 |
| --- | --- | --- |
| Linux x64 (production selector) | 0.4.60 | `5ace4f255ae26b59c230ab8b22ee584f726266d7c1abebda2a953c27224065c0` |
| macOS arm64 (optional local contract check) | 0.4.60 | `bd273fb9245d116836898fc5880015325d8ac36ccac78df7ffe359424db5b8e3` |

The CLI runs in an owned temporary directory under `RUNNER_TEMP`, allowing the system `/tmp` to remain mounted `noexec`. It receives the token through standard input and uses an isolated credential directory. Normal cleanup and the post action remove that directory; post cleanup requires the runner to remain available. See [failure behavior](configuration.md#failure-behavior) for cancellation and timeout handling.

Free allowances and reset schedules are caller-supplied. An echoed query window or a dashboard's month-to-date filter does not establish the provider's reset timezone. Record unverified assumptions in the caller's policy and compare normalized usage over the same period and unit; see [billing windows and units](configuration.md#billing-windows-and-units).

CLI upgrades require updating the version and checksums together and rerunning contract checks. A successful synthetic CLI check establishes command and response compatibility, not account entitlements or reset timing.

## Action and workflow distribution

The root JavaScript Action is called with `uses: j0urneyk/open-ci@v1.0.0`. `action.yml` defines the canonical inputs, outputs, Node.js 24 runtime, and main/post bundle paths. Both the root entrypoint and the existing `j0urneyk/open-ci/action@REF` entrypoint execute the same bundles under `action/dist/`. The build generates the subdirectory metadata from the root contract to prevent drift.

The `v1.0.0` tag identifies the published release; a full commit SHA pins exact code. Release commits include both generated bundles and the generated subdirectory metadata.

The reusable workflow uses `$/action`, the official GitHub.com self-repository reference, so the action is resolved from the called workflow's repository at the running commit. It needs no checkout of caller code and no fixed repository owner or branch-head reference. [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsuses)

The reusable workflow remains available as a complete selector job. The selector runner must support Node.js 24 actions. Workload tools, Docker, disk capacity, event trust, and publication gates belong to the caller; see [adopting an existing CI](configuration.md#adopting-an-existing-ci).

Billing access and provider selection do not establish downstream runner availability or workload compatibility. Validate each allowed target with an actual workload, including a private GitHub runner when included allowance is available. Cancellation cleanup also depends on the target runner's ability to execute the post action; local subprocess tests do not establish that host lifecycle behavior.
