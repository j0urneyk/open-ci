# Releasing open-ci

Publish a GitHub Release for each stable full version and keep a separate major-version tag pointing to the latest compatible release. The repository currently uses the manual procedure below; creating a GitHub Release does not move the major tag automatically.

## Version references

| Reference | Meaning | Maintainer action |
| --- | --- | --- |
| `@v1` | Latest compatible stable v1 release selected by the maintainer | Move this tag when publishing the newest stable v1 release; do not create a GitHub Release named `v1` |
| `@v1.0.1` | A specific published version | Create its tag and GitHub Release once; preserve both |
| Full commit SHA | Exact code | Never changes; callers choose when to update |

For example, `v1.0.1` and `v1` initially point to the same commit. After publishing `v1.1.0`, move only `v1` to that release's commit. The `v1.0.1` tag continues to identify its original code. GitHub resolves the named reference; it does not search for the highest matching semantic version.

Use patch versions for compatible fixes and minor versions for compatible additions. Breaking input, output, configuration, or runtime changes require a new major version and a migration guide. Do not advance `v1` to a v2 release or a prerelease, or move it backward when publishing a backport to an older minor line. If a published version needs a correction, publish another patch version instead of replacing its tag or release. Major tags remain movable even when full-version releases are made immutable, provided no GitHub Release is attached to the major tag.

## Prepare and validate

1. Start from an up-to-date, clean `main` checkout. Choose the version and review all changes since the previous release.
2. Update `package.json` and `package-lock.json` with `npm version 1.0.1 --no-git-tag-version --ignore-scripts`, substituting the intended version. Keep the package private: consumers download the Action from GitHub, so no npm publication is needed.
3. Move the relevant `CHANGELOG.md` entries from `Unreleased` into a dated version section. Keep an empty `Unreleased` section above it. Update any documentation that names the current fixed release; general caller examples should use `@v1`.
4. Run `npm ci --ignore-scripts` and `npm run verify`. Review the generated `action/action.yml` and `action/dist/` files and commit them with the source, documentation, and version changes. The root `action.yml` is the metadata source of truth.
5. Push the release commit to `main` and wait for that exact commit's GitHub CI to succeed. Confirm the working tree is clean before creating tags.

## Publish the full version

The commands below illustrate a stable `v1.0.1` release. Run them from the verified release commit in the same shell, and use the intended version each time. Stop if the tag or release already exists; inspect its state rather than replacing it.

```sh
set -eu
release_version=v1.0.1
release_commit=$(git rev-parse HEAD)
release_notes=$(mktemp)

python3 - "$release_version" "$release_notes" <<'PY'
import re
import sys
from pathlib import Path

version, destination = sys.argv[1:]
changelog = Path('CHANGELOG.md').read_text(encoding='utf-8')
section = re.search(
    r'^## ' + re.escape(version.removeprefix('v')) + r' - \d{4}-\d{2}-\d{2}\n(.*?)(?=^## |\Z)',
    changelog,
    re.MULTILINE | re.DOTALL,
)
if not section or not section.group(1).strip():
    raise SystemExit('Release notes missing: finalize this version in CHANGELOG.md first.')
Path(destination).write_text(section.group(1).strip() + '\n', encoding='utf-8')
PY

git tag -a "$release_version" "$release_commit" -m "open-ci $release_version"
git push origin "refs/tags/$release_version"
gh release create "$release_version" --repo j0urneyk/open-ci \
  --verify-tag --title "$release_version" --notes-file "$release_notes" --latest
```

Confirm that the release was published successfully before proceeding. Prereleases need a prerelease label and must not be marked latest or move the stable major tag. Use `--latest=false` for backports that should not replace the repository's latest stable release.

## Update the major tag

Update only the intended major tag after the stable version is published. This is a tag update, not another GitHub Release. The explicit lease prevents overwriting a concurrent maintainer's update; an empty previous value allows the first creation only if the tag is still absent.

```sh
release_major=${release_version%%.*}
major_previous=$(git ls-remote --refs origin "refs/tags/$release_major" | cut -f1)
git tag -fa "$release_major" "$release_commit" -m "open-ci $release_major"
git push --force-with-lease="refs/tags/$release_major:$major_previous" \
  origin "refs/tags/$release_major:refs/tags/$release_major"
```

If the lease fails, inspect the remote tag and coordinate the intended version before retrying. Do not force-push all tags. Future workflow runs using `j0urneyk/open-ci@v1` resolve the updated tag; callers pinned to a full version or commit remain on their chosen code.

## Verify publication

- Check that the full-version tag and major tag resolve to the verified release commit. With annotated tags, compare the peeled `^{}` commit values, not the tag object IDs.
- Compare the published release body with the finalized changelog section, and confirm the package version matches it. Preserve the `Unreleased` section for subsequent work.
- Confirm GitHub CI succeeds for the published references and that `action.yml`, the main bundle, the post bundle, and `LICENSE` are present in the tagged tree.
- Check the [Marketplace listing](https://github.com/marketplace/actions/open-ci-runner-selector). If the new version is not listed, edit its GitHub Release and enable **Publish this Action to the GitHub Marketplace**. Use **Continuous integration** as the primary category and **Utilities** as the secondary category. Complete any required account agreement or authentication in GitHub. The icon and color come from `action.yml`.

Useful read-only checks:

```sh
git ls-remote --tags origin "refs/tags/$release_version" "refs/tags/$release_version^{}" \
  "refs/tags/$release_major" "refs/tags/$release_major^{}"
gh release view "$release_version" --repo j0urneyk/open-ci --json tagName,body,url,isDraft,isPrerelease
gh run list --repo j0urneyk/open-ci --commit "$release_commit" --json databaseId,status,conclusion,url
```

See GitHub's [Action release management](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/manage-custom-actions#using-tags-for-release-management) and [immutable releases and movable tags](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/using-immutable-releases-and-tags-to-manage-your-actions-releases).
