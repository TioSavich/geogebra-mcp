# Local setup → GitHub push

This folder was built inside Cowork; the sandbox couldn't create a usable in-tree `.git/` directory. Two clean paths to get a real repo on your machine.

## Option A — Recommended: restore the prepared commit from the bundle

A git bundle was written next to this folder at `../geogebra-mcp.bundle`. Restoring it gives you the commit history with the carefully-written initial commit message intact.

```bash
cd <the folder containing this repo and geogebra-mcp.bundle>

# 1. Remove the unusable partial .git/ that the sandbox created
rm -rf geogebra-mcp/.git

# 2. Clone from the bundle (creates a fresh repo with one commit)
git clone geogebra-mcp.bundle geogebra-mcp-fresh
mv geogebra-mcp geogebra-mcp.old
mv geogebra-mcp-fresh geogebra-mcp
# Keep .old for a minute as a safety net; remove once you're happy.

cd geogebra-mcp
git remote remove origin              # the bundle is bound as origin; drop it
git remote add origin git@github.com:TioSavich/geogebra-mcp.git
git push -u origin main
```

## Option B — Fresh `git init`

If you'd rather start clean and write your own commit message:

```bash
cd geogebra-mcp
rm -rf .git
git init -b main
git config user.email "tsavich@gmail.com"
git config user.name "Tio Savich"
git add -A
git commit -m "Initial commit: geogebra-mcp v0.1.0"
git remote add origin git@github.com:TioSavich/geogebra-mcp.git
git push -u origin main
```

## Create the GitHub repo first

You'll need the repo to exist on GitHub before pushing. Either:

- Web UI: https://github.com/new — name `geogebra-mcp`, public, no README/license/gitignore (we have those), then push.
- Or via `gh`: `gh repo create TioSavich/geogebra-mcp --public --source=. --remote=origin --description "GeoGebra MCP server — construct, CAS, export, .ggb round-trip — for Claude and Codex"`

## CI note

Per your global preferences, GitHub Actions is disabled at the account level. **No workflow file is included.** If you ever re-enable Actions, a basic CI would just be `npm ci && npm run build && npm run smoke && npm run mcp-smoke`.

## Publishing to npm (optional, later)

```bash
npm login
npm publish --access public
```

Once published, the install instructions in `README.md` (`npx -y @tiosavich/geogebra-mcp`) work for anyone.
