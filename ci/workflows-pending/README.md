# Pending GitHub Actions workflows

These files belong in `.github/workflows/`. They are staged here because the
Abacus GitHub App that opened this PR lacks the `workflows` permission, and
GitHub rejects any push from it that touches `.github/workflows/`.

To activate (from the PR branch, using your own GitHub account):

1. Open each file on GitHub -> pencil (Edit) icon.
2. Change the path in the filename box to `.github/workflows/ci.yml`
   (resp. `.github/workflows/release.yml`) and commit to this branch.
3. Delete this README.

`release.yml` publishes `@quotagate/sdk` on `v*` tags using the `NPM_TOKEN`
repository secret.
