# Release Process

This project uses automated publishing to npm via GitHub Actions and Trusted Publishers. No npm tokens needed!

## Prerequisites

- ✅ Trusted Publisher configured on npm (already done)
- ✅ Push access to the GitHub repository
- ✅ Clean working directory (all changes committed)

## Release Steps

### 1. Ensure all changes are committed

```bash
git status  # Should show clean working tree
```

### 2. Bump version

Choose the appropriate version bump:

```bash
# For bug fixes and minor changes
npm version patch   # 0.8.0 → 0.8.1

# For new features (backwards compatible)
npm version minor   # 0.8.0 → 0.9.0

# For breaking changes
npm version major   # 0.8.0 → 1.0.0
```

This command:
- Updates `package.json` and `package-lock.json`
- Creates a git commit with message like "0.8.1"
- Creates a git tag like `v0.8.1`

### 3. Push commits and tags

```bash
git push && git push --tags
```

### 4. Create GitHub Release

**Option A: Using GitHub CLI (recommended)**

```bash
gh release create v0.8.1 --generate-notes
```

This automatically generates release notes from commit messages.

**Option B: Using GitHub Web UI**

1. Go to https://github.com/ianhi/jupyterlab-collab-mcp/releases/new
2. Select the tag you just pushed (e.g., `v0.8.1`)
3. Click "Generate release notes" button
4. Review and edit if needed
5. Click "Publish release"

### 5. Automated Publishing

GitHub Actions will automatically run **two workflows**:

**When you push the tag** (step 3):
- ✅ Deploy updated docs to GitHub Pages

**When you publish the release** (step 4):
- ✅ Run all TypeScript tests
- ✅ Build the project
- ✅ Publish to npm with provenance signature

Monitor the workflow at: https://github.com/ianhi/jupyterlab-collab-mcp/actions

### 6. Verify Publication

```bash
# Check npm registry
npm view jupyterlab-collab-mcp

# View on npm website
open https://www.npmjs.com/package/jupyterlab-collab-mcp
```

## Troubleshooting

### Release workflow fails

1. Check the Actions tab for error details
2. Common issues:
   - Tests failing → Fix tests and create a new patch release
   - Build errors → Fix build and create a new patch release
   - Trusted Publisher misconfigured → Verify settings at npm package settings

### Need to unpublish a version

You cannot unpublish versions after 24 hours. Instead:

```bash
npm deprecate jupyterlab-collab-mcp@0.8.1 "Use version 0.8.2 instead"
```

Then release a fixed version.

## Version Guidelines

Follow [Semantic Versioning](https://semver.org/):

- **Patch** (0.8.x): Bug fixes, documentation updates, internal refactoring
- **Minor** (0.x.0): New features, new tools, backwards-compatible changes
- **Major** (x.0.0): Breaking changes to tool schemas, removed features

## Quick Reference

```bash
# Standard release workflow
npm version patch
git push && git push --tags
gh release create v0.8.1 --generate-notes

# That's it! GitHub Actions handles the rest.
```
