// GeoGebra driver — wraps a single headless Chromium page that hosts the
// GeoGebra Apps API. All tool handlers proxy through here. We keep one
// browser/page alive for the life of the MCP server process; switching
// "app" (graphing / geometry / 3d / cas / classic / suite) does a navigate.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Locate assets/applet.html relative to the compiled file. After `tsc` the
// file lives at dist/geogebra.js, so the asset is at ../assets/applet.html.
// We also check a sibling path for when running uncompiled (ts-node etc.).
function locateApplet(): string {
  const candidates = [
    resolve(__dirname, "..", "assets", "applet.html"),
    resolve(__dirname, "..", "..", "assets", "applet.html"),
    resolve(process.cwd(), "assets", "applet.html"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Could not locate assets/applet.html (looked in ${candidates.join(", ")})`
  );
}

export type GgbApp =
  | "graphing"
  | "geometry"
  | "3d"
  | "classic"
  | "suite"
  | "cas"
  | "scientific"
  | "evaluator"
  | "notes";

export interface GeoGebraDriverOptions {
  app?: GgbApp;
  width?: number;
  height?: number;
  /** Override the pinned GeoGebra HTML5 codebase URL (advanced). */
  codebase?: string;
  /** Path to assets/applet.html (auto-detected if omitted). */
  appletPath?: string;
  /** Launch Chromium headless. Default true. Set false to debug visually. */
  headless?: boolean;
}

export class GeoGebraDriver {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private currentApp: GgbApp;
  private width: number;
  private height: number;
  private codebase: string | undefined;
  private appletPath: string;
  private headless: boolean;
  private readyPromise: Promise<void> | null = null;

  constructor(opts: GeoGebraDriverOptions = {}) {
    this.currentApp = opts.app ?? "suite";
    this.width = opts.width ?? 1024;
    this.height = opts.height ?? 768;
    this.codebase = opts.codebase;
    this.appletPath = opts.appletPath ?? locateApplet();
    this.headless = opts.headless ?? true;
  }

  async start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this._start();
    return this.readyPromise;
  }

  private async _start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.headless,
      args: [
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-gpu",
      ],
    });
    // Restrictive context — we are loading a local file plus geogebra.org's
    // CDN. We do NOT grant geolocation, camera, mic, clipboard, etc.
    this.context = await this.browser.newContext({
      viewport: { width: this.width, height: this.height },
      bypassCSP: false,
      javaScriptEnabled: true,
      acceptDownloads: false,
      permissions: [],
      ignoreHTTPSErrors: false,
    });
    this.page = await this.context.newPage();
    // Surface page errors to the server's stderr (handy when debugging).
    this.page.on("pageerror", (err) => {
      process.stderr.write(`[ggb page error] ${err.message}\n`);
    });
    await this._navigate(this.currentApp);
  }

  private async _navigate(app: GgbApp): Promise<void> {
    if (!this.page) throw new Error("Driver not started");
    const url = new URL("file://" + this.appletPath);
    url.searchParams.set("app", app);
    url.searchParams.set("w", String(this.width));
    url.searchParams.set("h", String(this.height));
    if (this.codebase) {
      // Pass override into the page before navigation by using an init script.
      await this.page.addInitScript((cb) => {
        (window as any).__GGB_CODEBASE = cb;
      }, this.codebase);
    }
    await this.page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    // Wait until the applet's appletOnLoad callback has fired.
    await this.page.waitForFunction(
      () => (window as any).__ggbReady === true && (window as any).__ggb,
      undefined,
      { timeout: 60_000 }
    );
    this.currentApp = app;
    // CAS in GeoGebra's web build is lazy-loaded (the giac engine arrives as a
    // separate chunk). In CAS-capable apps we poll until 1+1=2 to make the
    // first user CAS call snappy and not surprise them with "?".
    if (this._appHasCAS(app)) {
      await this._warmCAS();
    }
  }

  private _appHasCAS(app: GgbApp): boolean {
    // graphing, geometry, scientific, evaluator, notes don't ship CAS by default.
    return app === "classic" || app === "cas" || app === "suite" || app === "3d";
  }

  private async _warmCAS(maxMs = 15_000): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.waitForFunction(
        () => {
          try {
            const out = (window as any).__ggb.evalCommandCAS("1+1");
            return typeof out === "string" && out.trim() === "2";
          } catch { return false; }
        },
        undefined,
        { timeout: maxMs, polling: 200 }
      );
    } catch {
      // Don't fail startup if CAS never warms — user can still use construction
      // tools and we'll surface "?" if they try CAS.
      process.stderr.write("[ggb] CAS did not warm up within timeout; CAS tools may return '?' until ready.\n");
    }
  }

  async setApp(app: GgbApp): Promise<void> {
    if (!this.page) await this.start();
    if (app === this.currentApp) return;
    await this._navigate(app);
  }

  async stop(): Promise<void> {
    try { await this.page?.close(); } catch {}
    try { await this.context?.close(); } catch {}
    try { await this.browser?.close(); } catch {}
    this.page = null;
    this.context = null;
    this.browser = null;
    this.readyPromise = null;
  }

  // All Apps API calls go through evalInPage. Playwright serializes the
  // function source and arguments across the bridge, so the function body
  // must not close over outer variables — pass everything through `args`.
  private evalInPage<T, A extends any[]>(
    fn: (api: any, ...args: A) => T,
    ...args: A
  ): Promise<T> {
    return (async () => {
      if (!this.page) await this.start();
      const expr = fn.toString();
      return this.page!.evaluate(
        ({ expr, args }) => {
          // eslint-disable-next-line no-new-func
          const f = new Function("return (" + expr + ")")();
          return f((window as any).__ggb, ...args);
        },
        { expr, args }
      ) as Promise<T>;
    })();
  }

  // Real construction methods — re-implemented using evalInPage for clarity.

  async runCommand(cmd: string): Promise<boolean> {
    return this.evalInPage((api: any, c: string) => {
      try { return !!api.evalCommand(c); } catch { return false; }
    }, cmd);
  }

  async runCommandGetLabels(cmd: string): Promise<string[]> {
    return this.evalInPage((api: any, c: string) => {
      try {
        const s = api.evalCommandGetLabels(c) + "";
        if (!s) return [];
        return s.split(",").map((x: string) => x.trim()).filter((x: string) => x.length > 0);
      } catch { return []; }
    }, cmd);
  }

  async setValue(name: string, value: number): Promise<void> {
    await this.evalInPage((api: any, n: string, v: number) => {
      api.setValue(n, v);
    }, name, value);
  }

  async setTextValue(name: string, value: string): Promise<void> {
    await this.evalInPage((api: any, n: string, v: string) => {
      api.setTextValue(n, v);
    }, name, value);
  }

  async setCoords(name: string, x: number, y: number, z?: number): Promise<void> {
    await this.evalInPage((api: any, n: string, xx: number, yy: number, zz: number | null) => {
      if (zz === null) api.setCoords(n, xx, yy);
      else api.setCoords(n, xx, yy, zz);
    }, name, x, y, z ?? null);
  }

  async deleteObject(name: string): Promise<void> {
    await this.evalInPage((api: any, n: string) => { api.deleteObject(n); }, name);
  }

  async setVisible(name: string, visible: boolean): Promise<void> {
    await this.evalInPage((api: any, n: string, v: boolean) => {
      api.setVisible(n, v);
    }, name, visible);
  }

  async setColor(name: string, r: number, g: number, b: number): Promise<void> {
    await this.evalInPage((api: any, n: string, rr: number, gg: number, bb: number) => {
      api.setColor(n, rr, gg, bb);
    }, name, r, g, b);
  }

  async setCaption(name: string, caption: string): Promise<void> {
    await this.evalInPage((api: any, n: string, c: string) => {
      api.setCaption(n, c);
    }, name, caption);
  }

  async setLabelVisible(name: string, visible: boolean): Promise<void> {
    await this.evalInPage((api: any, n: string, v: boolean) => {
      api.setLabelVisible(n, v);
    }, name, visible);
  }

  async setLabelStyle(name: string, style: 0 | 1 | 2 | 3): Promise<void> {
    await this.evalInPage((api: any, n: string, s: number) => {
      api.setLabelStyle(n, s);
    }, name, style);
  }

  async renameObject(oldName: string, newName: string): Promise<boolean> {
    return this.evalInPage((api: any, o: string, nn: string) => {
      try { return !!api.renameObject(o, nn); } catch { return false; }
    }, oldName, newName);
  }

  async newConstruction(): Promise<void> {
    await this.evalInPage((api: any) => { api.newConstruction(); });
  }

  async reset(): Promise<void> {
    await this.evalInPage((api: any) => { api.reset(); });
  }

  async setCoordSystem(
    xmin: number, xmax: number, ymin: number, ymax: number,
    zmin?: number, zmax?: number, yVertical?: boolean
  ): Promise<void> {
    await this.evalInPage(
      (api: any, xn: number, xx: number, yn: number, yx: number,
        zn: number | null, zx: number | null, yv: boolean) => {
        if (zn !== null && zx !== null) api.setCoordSystem(xn, xx, yn, yx, zn, zx, yv);
        else api.setCoordSystem(xn, xx, yn, yx);
      },
      xmin, xmax, ymin, ymax, zmin ?? null, zmax ?? null, !!yVertical
    );
  }

  async setAxesVisible(xAxis: boolean, yAxis: boolean): Promise<void> {
    await this.evalInPage((api: any, x: boolean, y: boolean) => {
      api.setAxesVisible(x, y);
    }, xAxis, yAxis);
  }

  async setGridVisible(visible: boolean): Promise<void> {
    await this.evalInPage((api: any, v: boolean) => {
      api.setGridVisible(v);
    }, visible);
  }

  async showAllObjects(): Promise<void> {
    await this.evalInPage((api: any) => { api.showAllObjects(); });
  }

  // ---------- Inspection ----------

  async getValue(name: string): Promise<number> {
    return this.evalInPage((api: any, n: string) => Number(api.getValue(n)), name);
  }

  async getValueString(name: string): Promise<string> {
    return this.evalInPage((api: any, n: string) => String(api.getValueString(n)), name);
  }

  async getDefinitionString(name: string): Promise<string> {
    return this.evalInPage((api: any, n: string) => String(api.getDefinitionString(n)), name);
  }

  async getCommandString(name: string): Promise<string> {
    return this.evalInPage((api: any, n: string) => String(api.getCommandString(n)), name);
  }

  async getLaTeXString(name: string): Promise<string> {
    return this.evalInPage((api: any, n: string) => String(api.getLaTeXString(n)), name);
  }

  async getObjectType(name: string): Promise<string> {
    return this.evalInPage((api: any, n: string) => String(api.getObjectType(n)), name);
  }

  async exists(name: string): Promise<boolean> {
    return this.evalInPage((api: any, n: string) => !!api.exists(n), name);
  }

  async isDefined(name: string): Promise<boolean> {
    return this.evalInPage((api: any, n: string) => !!api.isDefined(n), name);
  }

  async getAllObjectNames(type?: string): Promise<string[]> {
    return this.evalInPage((api: any, t: string | null) => {
      const arr = t ? api.getAllObjectNames(t) : api.getAllObjectNames();
      return Array.from(arr || []).map((s: any) => String(s));
    }, type ?? null);
  }

  async getXcoord(name: string): Promise<number> {
    return this.evalInPage((api: any, n: string) => Number(api.getXcoord(n)), name);
  }
  async getYcoord(name: string): Promise<number> {
    return this.evalInPage((api: any, n: string) => Number(api.getYcoord(n)), name);
  }
  async getZcoord(name: string): Promise<number> {
    return this.evalInPage((api: any, n: string) => Number(api.getZcoord(n)), name);
  }

  // ---------- CAS ----------

  async cas(expression: string): Promise<string> {
    const first = await this.evalInPage((api: any, e: string) => {
      try { return String(api.evalCommandCAS(e)); } catch { return ""; }
    }, expression);
    // If CAS isn't loaded yet, try to warm it and retry once.
    if (first === "?" && this._appHasCAS(this.currentApp)) {
      await this._warmCAS(15_000);
      return this.evalInPage((api: any, e: string) => {
        try { return String(api.evalCommandCAS(e)); } catch { return ""; }
      }, expression);
    }
    return first;
  }

  // ---------- Export ----------

  async exportPNG(scale = 1, transparent = false, dpi: number | null = 72): Promise<string> {
    return this.evalInPage((api: any, s: number, t: boolean, d: number | null) => {
      return String(api.getPNGBase64(s, t, d === null ? undefined : d));
    }, scale, transparent, dpi);
  }

  async exportSVG(): Promise<string | null> {
    return this.evalInPage(async (_api: any) => {
      // @ts-ignore — defined in applet.html
      return await (window as any).__ggbExportSVG();
    });
  }

  async exportPDF(scale = 1, sliderLabel = ""): Promise<string | null> {
    return this.evalInPage(async (_api: any, s: number, sl: string) => {
      // @ts-ignore
      return await (window as any).__ggbExportPDF(s, sl);
    }, scale, sliderLabel);
  }

  // ---------- State ----------

  async getBase64(): Promise<string> {
    return this.evalInPage(async (_api: any) => {
      // @ts-ignore
      const b = await (window as any).__ggbGetBase64();
      return b ? String(b) : "";
    });
  }

  async setBase64(b64: string): Promise<boolean> {
    return this.evalInPage(async (_api: any, data: string) => {
      // @ts-ignore
      return !!(await (window as any).__ggbSetBase64(data));
    }, b64);
  }

  async getXML(): Promise<string> {
    return this.evalInPage((api: any) => String(api.getXML()));
  }

  async setXML(xml: string): Promise<void> {
    await this.evalInPage((api: any, x: string) => { api.setXML(x); }, xml);
  }

  async getVersion(): Promise<string> {
    return this.evalInPage((api: any) => {
      try { return String(api.getVersion()); } catch { return "unknown"; }
    });
  }
}
