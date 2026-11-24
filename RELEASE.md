# Release process

The first release is `v0.0.1-beta`. The workflow starts on a push of a `v*` tag. Git tags identify commits, so the validation job checks that the tagged commit is in the history of `main`. A tag on a commit that has only been pushed to a feature branch fails validation. Use a SemVer tag without build metadata, such as `v0.0.1-beta`.

## First publication

1. Merge the release branch into `main`. Review the repository and its history for readiness before making the source repository public. The workflow checks visibility before pushing packages. Enable GitHub private vulnerability reporting for the contact link in SECURITY.md.
2. Ensure GitHub Actions can publish packages with `GITHUB_TOKEN`. The workflow uses GitHub Container Registry (GHCR) and creates the `kestrel-it-api`, `kestrel-it-web`, and `charts/kestrel-it` packages.
3. Push the tag from the release commit on `main`.

   ```sh
   git fetch origin main
   git tag -a v0.0.1-beta origin/main -m "Kestrel-IT v0.0.1-beta"
   git push origin refs/tags/v0.0.1-beta
   ```

4. GHCR packages start private. After the workflow first pushes them, open each package's settings and set its visibility to **Public**. Rerun the failed job for the same tag. If a package already exists, grant this repository Actions write access in the package's settings before rerunning.

The workflow runs the build, typecheck, PostgreSQL tests, and OpenAPI check. It lints and packages the chart, builds both images, and smoke-tests the web and API together with PostgreSQL. It then pushes images for Linux AMD64 and ARM64 and publishes one versioned OCI chart. Anonymous OCI access must pass before GitHub publishes the release with the chart archive and SHA-256 checksum. SemVer prerelease tags produce GitHub prereleases.

After publication, use a new version tag for changes. The chart version, app version, and default image tags come from the release tag with the leading `v` removed.

[Release workflow](.github/workflows/release.yml) · [End-user installation](deploy/helm/kestrel-it/README.md)
