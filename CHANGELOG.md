# Changelog

## Unreleased

- Add a complete example and configuration guidance for sharing one runner selection across multiple reusable workflows, preserving JSON targets and individual job checks without forwarding billing credentials.

## 1.0.1 - 2026-09-23

- Honor GitHub API retry and rate-limit reset deadlines without shortening server waits. Stop requests whose required wait exceeds five seconds, including follow-up requests with the same credential, so billing lookup failures can fall back safely.
- License open-ci under MIT and link the license from the README.
- Document release management and provide the `v1` compatibility tag alongside versioned releases.

## 1.0.0 - 2026-09-23

- Add Marketplace branding with a blue shuffle icon.
- Publish a root JavaScript Action for `uses: j0urneyk/open-ci@v1.0.0`, with the same provider selection, outputs, authentication, and post-job credential cleanup.
- Keep the reusable workflow and existing `/action` entrypoint compatible; generate subdirectory metadata from the root Action contract.
- Make root Action calls the default in documentation and examples, including caller-owned selector jobs and explicit input/output mapping.
- Keep provider documentation focused on current API contracts and operating requirements; remove experiment summaries and consumer-specific work records.
- Document App/Blacksmith credential setup, caller-owned runner preparation, fork-PR handling, and the distinction between configured billing assumptions and verified provider facts.
- Use the Actions job temporary directory for Blacksmith CLI execution so self-hosted runners with `/tmp` mounted `noexec` can query usage without changing host security settings.
- Exclude public repository usage from GitHub free-allowance consumption, aggregate every private repository, and require billing credentials to read repository metadata instead of silently omitting unknown repositories.
- Send Blacksmith billing windows at whole-second precision to match real CLI responses while retaining strict period validation.
- Verify live GitHub App authentication and token revocation, private-only usage aggregation, authenticated Blacksmith lookup, and downstream self-hosted execution after zero allowances, either provider priority order, or missing Blacksmith credentials.
- Reconcile Blacksmith normalized minutes with an account's free-tier dashboard and verify actual Linux x64 worker execution after GitHub allowance exhaustion. Keep the exact Blacksmith reset timezone and positive private GitHub selection explicitly unverified.
- Add an organization-only reusable workflow that selects GitHub-hosted, Blacksmith, or self-hosted runners before workload jobs start.
- Add common JSON policy, repository YAML overrides at the run commit, configurable priority, and a default 5% free-allowance reserve.
- Add explicit billing units and windows, fail-closed provider lookups, workflow outputs, and decision summaries.
- Select recognized standard GitHub-hosted runners for public repositories without billing credentials or allowance checks; skip targets whose free eligibility cannot be verified.
- Match billing organization identities case-insensitively and reject reports for a different organization or billing period.
- Isolate Blacksmith CLI credentials, register post-action cleanup, and stop active CLI subprocesses on cancellation without triggering fallback.
- Add local regression and CLI-contract checks, and verify live cross-repository self-hosted execution for string, labels-array, and group/labels targets.
