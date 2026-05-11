# geogebra-mcp

A Model Context Protocol server that lets Claude (Desktop, Code, Cowork) and Codex CLI drive [GeoGebra](https://www.geogebra.org) — building constructions, doing CAS, exporting PNG/SVG/PDF, and round-tripping `.ggb` files that you can drop straight into Canvas, GitHub Pages, or any HTML-friendly Markdown.

Built fresh in 2026 because the existing community servers were either stale (`Stainless-Studio/gebrai` hadn't been updated in a long while) or suspicious in provenance. This one runs the **official GeoGebra Apps API** inside a headless Chromium via Playwright. It pins the GeoGebra version, disables in-construction scripting, and ships under MIT with all sources visible in `src/`.

## What you get

39 MCP tools across five groups.

**Construction.** `eval_command` (drives the full GeoGebra Input Bar), `set_value`, `set_coords`, `delete_object`, `set_visible`, `set_color`, `set_caption`, `rename_object`, `reset`, `set_app`, `set_coord_system`, `set_axes_visible`, `set_grid_visible`, `show_all_objects`.

**Inspection.** `get_value`, `get_value_string`, `get_definition`, `get_latex`, `get_object_type`, `object_exists`, `list_objects`, `get_coords`.

**CAS.** `cas_eval` (raw passthrough to `evalCommandCAS`), plus convenience wrappers `solve`, `factor`, `simplify`, `derivative`, `integral`.

**Export.** `export_png`, `export_svg`, `export_pdf` — each returns the asset inline and can also write to a path you specify.

**State + embedding.** `save_ggb`, `load_ggb`, `get_xml`, `set_xml`, `make_embed_html`, `make_embed_markdown`, `make_materials_iframe`. The embed helpers wrap the current construction (or a Materials ID you already uploaded) in a snippet you can paste into a webpage, a Markdown file that allows raw HTML, or — for Canvas — the existing GeoGebra LTI integration.

`geogebra_version` reports the running GeoGebra version.

## Install

```bash
npm install -g @tiosavich/geogebra-mcp
# Playwright will fetch Chromium on first install
```

Or skip the install and let your MCP client run it via `npx`:

```jsonc
{ "command": "npx", "args": ["-y", "@tiosavich/geogebra-mcp"] }
```

System requirements: Node 18.17+, ~150 MB for Chromium, an outbound connection to `geogebra.org`'s CDN (or a self-hosted codebase via `GEOGEBRA_CODEBASE`).

## Connect it to your MCP client

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "geogebra": {
      "command": "npx",
      "args": ["-y", "@tiosavich/geogebra-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add geogebra --scope user -- npx -y @tiosavich/geogebra-mcp
```

### Cowork (Claude desktop)

Open Settings → Connectors → Custom MCP, then add:

| Field   | Value                              |
|---------|------------------------------------|
| Name    | geogebra                           |
| Command | `npx`                              |
| Args    | `-y @tiosavich/geogebra-mcp`       |

### Codex CLI

Codex uses stdio MCP servers too. Add to `~/.codex/config.toml`:

```toml
[mcp_servers.geogebra]
command = "npx"
args = ["-y", "@tiosavich/geogebra-mcp"]
```

Then `codex` will list these tools alongside its built-ins. (If you've installed globally, replace `npx -y @tiosavich/geogebra-mcp` with `geogebra-mcp`.)

## Quickstart from inside an LLM client

> "Plot y = sin(x), then export a PNG and save the .ggb."

That request maps to:

1. `eval_command` with `f(x) = sin(x)`
2. `export_png` with `scale=2`
3. `save_ggb` with `output_path=lesson.ggb`

> "Build a triangle ABC with vertices (0,0), (4,0), (0,3), then tell me the area and produce an embeddable HTML snippet I can paste into my Canvas page."

Maps to four `eval_command`s, `get_value` on the polygon, and `make_embed_html` (or `make_materials_iframe` if you uploaded the .ggb to geogebra.org first — the LTI-friendly path for Canvas).

## Environment variables

| Name                 | Default     | Meaning                                                                   |
|----------------------|-------------|---------------------------------------------------------------------------|
| `GEOGEBRA_APP`       | `suite`     | Initial app: `suite` (default — has everything), `graphing`, `geometry`, `3d`, `classic`, `cas`, `scientific`. CAS tools (`solve`, `factor`, `derivative`, `integral`, `cas_eval`) require `suite`, `classic`, `cas`, or `3d`. |
| `GEOGEBRA_HEADLESS`  | `true`      | Set `false` to launch a visible Chromium window (debugging)               |
| `GEOGEBRA_CODEBASE`  | unset       | Override the pinned GeoGebra HTML5 codebase URL                           |

## Build from source

```bash
git clone https://github.com/TioSavich/geogebra-mcp
cd geogebra-mcp
npm install
npm run build
node dist/index.js   # serves on stdio
```

## Embedding in Canvas

GeoGebra publishes an LTI 1.3 integration that most Canvas installations (including Indiana University's) already have available. The recommended flow is:

1. `save_ggb { "output_path": "lesson.ggb" }`
2. Upload `lesson.ggb` to [geogebra.org/materials](https://www.geogebra.org/materials) (manual; takes ~30 seconds).
3. Copy the resulting material ID (a short alphanumeric like `MJWHp9en`).
4. In Canvas, either use the GeoGebra LTI external tool, **or** call `make_materials_iframe { "material_id": "MJWHp9en" }` and paste the iframe into a Canvas Page via the HTML editor.

If your Canvas instance does not have the LTI tool, `make_embed_html` produces a self-contained block that pulls `deployggb.js` from the GeoGebra CDN and inlines the .ggb — works in any HTML-permissive RCE.

## Why this exists / what's different from gebrai

- **Provenance.** Built by Tio Savich; all source visible in `src/`; pinned dependencies; MIT.
- **Safety.** `enableScripting` and `useBrowserForJS` are off, so loading a .ggb file from an untrusted source can't execute JavaScript or Python attached to objects. Input names are validated.
- **API completeness.** Wraps the full GeoGebra Apps API for construction, CAS, export, and state — including SVG and PDF, which most prior servers omit.
- **Embed helpers.** Generates HTML/Markdown snippets and Materials iframes so the output is immediately usable in Canvas, GitHub Pages, MkDocs, and Obsidian.
- **Multi-client.** Documented configurations for Claude Desktop, Claude Code, Cowork, and Codex CLI.

See `SECURITY.md` for the threat model.

## License

MIT — see `LICENSE`. GeoGebra itself is licensed by the International GeoGebra Institute; see https://www.geogebra.org/license. This server only invokes the public Apps API.
