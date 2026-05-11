# Security and threat model

## What this server does

`geogebra-mcp` launches a headless Chromium browser via Playwright, loads a small local HTML page (`assets/applet.html`), and uses that page to call the [GeoGebra Apps API](https://geogebra.github.io/docs/reference/en/GeoGebra_Apps_API/). The browser fetches the GeoGebra HTML5 codebase from `geogebra.org` (or a URL you set in `GEOGEBRA_CODEBASE`). Tool calls from the MCP client become `evaluate()` calls in the page.

## What this server does **not** do

- It does not load arbitrary URLs.
- It does not write files unless a tool argument supplies `output_path`.
- It does not read files unless a tool argument supplies `input_path`.
- It does not run user-provided JavaScript in the browser. Tool handler functions are written in TypeScript and serialized to the page via `page.evaluate`; argument values flow over Playwright's structured channel, not as code.
- It does not enable script execution inside loaded `.ggb` files. GeoGebra supports per-object JavaScript and Python event handlers (`onClick`, `onUpdate`, etc.). These are disabled in the host applet via `enableScripting: false` and `useBrowserForJS: false`. A `.ggb` you load via `load_ggb` cannot execute those handlers in this server.

## Threat model

### Trusted

- The Node process running the MCP server.
- The MCP client that connects to it (Claude Desktop, Codex CLI, etc.).
- The GeoGebra codebase served from `geogebra.org` (or whatever `GEOGEBRA_CODEBASE` points at). If you don't trust GeoGebra's CDN, point at a self-hosted bundle.

### Untrusted

- `.ggb` files loaded via `load_ggb` (could come from anywhere).
- Strings passed as `eval_command` / `cas_eval` / `set_xml`. These are GeoGebra commands and XML, not JavaScript, but they can mutate the current construction.
- The CAS engine output (used as a value, not as code).

## Mitigations in this release

| Concern                                                  | Mitigation                                                                                                            |
|----------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------|
| Loaded `.ggb` runs JS / Python event handlers            | `enableScripting: false`, `useBrowserForJS: false` in the applet                                                       |
| Loaded `.ggb` triggers right-click actions on injection  | `enableRightClick: false`                                                                                              |
| Server is told to navigate to an arbitrary URL           | Server only ever navigates to `file://…/assets/applet.html`. There is no `navigate` tool.                              |
| Tool args contain executable JavaScript                  | Args are passed as JSON over the MCP transport and again across the Playwright bridge — never as code.                 |
| Object names contain weird characters                    | Names must match `^[\p{L}_][\p{L}\p{N}_'′]*$`.                                                                         |
| Oversized payloads                                       | Command strings capped at 8 KB; base64 payloads at 50 MB.                                                              |
| Browser permissions (camera, mic, geolocation, clipboard) | Granted as empty list in the Playwright context.                                                                       |
| Browser downloads triggered by exporters                 | `acceptDownloads: false` — exports go through the API, not the download path.                                          |
| Orphaned Chromium processes                              | SIGINT / SIGTERM handlers tear down the browser.                                                                       |
| Silent upstream behavior changes                         | `applet.html` pins a specific GeoGebra HTML5 codebase URL.                                                              |

## Known limitations

- The applet still fetches scripts and assets from `geogebra.org` by default. If your environment requires fully offline operation, download the [GeoGebra Math Apps Bundle](https://download.geogebra.org/package/geogebra-math-apps-bundle), host it locally, and set `GEOGEBRA_CODEBASE` to the local path.
- We trust the Playwright bridge. A vulnerability in Chromium or Playwright would affect this server like it would any Playwright-based tool.
- The server does not authenticate calls — it trusts the MCP client. Run it under your own user account and don't expose stdio to untrusted networks (stdio is local-only by construction).

## Reporting a vulnerability

Email tiosavich@gmail.com or open a GitHub Security Advisory at https://github.com/TioSavich/geogebra-mcp/security/advisories.
