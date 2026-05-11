// MCP tool definitions. Each entry is a discrete tool the client can call.
// We keep names snake_case for compatibility with MCP clients that surface
// tool names directly to LLMs.

import { z } from "zod";
import type { GeoGebraDriver } from "./geogebra.js";
import {
  AppName, Base64String, ColorByte, CommandString, Dpi, LongString,
  ObjectName, Scale,
} from "./safety.js";
import { makeEmbedHTML, makeEmbedMarkdown, makeMaterialsIframe } from "./embed.js";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

// Helper: write a base64 payload to disk if the user passed `output_path`.
async function maybeWriteFile(b64: string, outputPath: string | undefined, ext: string): Promise<string | null> {
  if (!outputPath) return null;
  const target = isAbsolute(outputPath) ? outputPath : resolve(process.cwd(), outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(b64, "base64"));
  return target;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function okJSON(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
function imageContent(b64: string, mime: string) {
  return {
    content: [
      { type: "image" as const, data: b64, mimeType: mime },
    ],
  };
}

export interface ToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (args: z.infer<S>, driver: GeoGebraDriver) => Promise<{
    content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    >;
    isError?: boolean;
  }>;
}

function def<S extends z.ZodTypeAny>(d: ToolDef<S>): ToolDef<S> { return d; }

// -------------------------------- Construction --------------------------------

const evalCommandTool = def({
  name: "eval_command",
  description:
    "Evaluate one or more GeoGebra commands as if typed in the Input Bar. " +
    "Examples: 'A = (1, 2)', 'f(x) = x^2', 'Circle(A, 3)'. " +
    "Use English command names. Multiple commands can be separated by newlines. " +
    "Returns whether the command was accepted.",
  inputSchema: z.object({
    command: CommandString.describe("GeoGebra command, e.g. 'f(x) = sin(x)'"),
    return_labels: z.boolean().default(false).describe(
      "If true, return the labels of objects the command created (e.g. ['A','B']) instead of a boolean."
    ),
  }),
  handler: async ({ command, return_labels }, driver) => {
    if (return_labels) {
      const labels = await driver.runCommandGetLabels(command);
      return okJSON({ ok: labels.length > 0, labels });
    }
    const ok_ = await driver.runCommand(command);
    return okJSON({ ok: ok_ });
  },
});

const setValueTool = def({
  name: "set_value",
  description: "Set the numeric value of a named GeoGebra object (e.g. slider, free number, boolean).",
  inputSchema: z.object({
    name: ObjectName,
    value: z.number().describe("For booleans, 1 = true and anything else = false."),
  }),
  handler: async ({ name, value }, driver) => {
    await driver.setValue(name, value);
    return ok(`set ${name} = ${value}`);
  },
});

const setCoordsTool = def({
  name: "set_coords",
  description: "Move a point/vector to given coordinates (2D or 3D).",
  inputSchema: z.object({
    name: ObjectName,
    x: z.number(),
    y: z.number(),
    z: z.number().optional(),
  }),
  handler: async ({ name, x, y, z }, driver) => {
    await driver.setCoords(name, x, y, z);
    return ok(`moved ${name} to (${x}, ${y}${z !== undefined ? ", " + z : ""})`);
  },
});

const deleteObjectTool = def({
  name: "delete_object",
  description: "Delete an object by name.",
  inputSchema: z.object({ name: ObjectName }),
  handler: async ({ name }, driver) => {
    await driver.deleteObject(name);
    return ok(`deleted ${name}`);
  },
});

const setVisibleTool = def({
  name: "set_visible",
  description: "Show or hide an object in the graphics view.",
  inputSchema: z.object({ name: ObjectName, visible: z.boolean() }),
  handler: async ({ name, visible }, driver) => {
    await driver.setVisible(name, visible);
    return ok(`${name} visible = ${visible}`);
  },
});

const setColorTool = def({
  name: "set_color",
  description: "Set RGB color of an object (each component 0–255).",
  inputSchema: z.object({
    name: ObjectName, r: ColorByte, g: ColorByte, b: ColorByte,
  }),
  handler: async ({ name, r, g, b }, driver) => {
    await driver.setColor(name, r, g, b);
    return ok(`${name} color set to rgb(${r}, ${g}, ${b})`);
  },
});

const setCaptionTool = def({
  name: "set_caption",
  description: "Set the caption text on an object.",
  inputSchema: z.object({ name: ObjectName, caption: z.string().max(1024) }),
  handler: async ({ name, caption }, driver) => {
    await driver.setCaption(name, caption);
    return ok(`set caption of ${name}`);
  },
});

const renameObjectTool = def({
  name: "rename_object",
  description: "Rename an object. Returns whether the rename succeeded.",
  inputSchema: z.object({ old_name: ObjectName, new_name: ObjectName }),
  handler: async ({ old_name, new_name }, driver) => {
    const ok_ = await driver.renameObject(old_name, new_name);
    return okJSON({ ok: ok_ });
  },
});

const resetTool = def({
  name: "reset",
  description: "Clear the construction (newConstruction). Same as starting over.",
  inputSchema: z.object({}),
  handler: async (_args, driver) => {
    await driver.newConstruction();
    return ok("construction cleared");
  },
});

const setAppTool = def({
  name: "set_app",
  description:
    "Switch the active GeoGebra app. Reloads the headless page, so the current construction is lost. " +
    "Apps: graphing (default, 2D + algebra), geometry, 3d, classic (full GUI), suite, cas, scientific.",
  inputSchema: z.object({ app: AppName }),
  handler: async ({ app }, driver) => {
    await driver.setApp(app);
    return ok(`active app = ${app}`);
  },
});

const setCoordSystemTool = def({
  name: "set_coord_system",
  description: "Set the visible bounds of the graphics view (2D or 3D).",
  inputSchema: z.object({
    xmin: z.number(), xmax: z.number(),
    ymin: z.number(), ymax: z.number(),
    zmin: z.number().optional(),
    zmax: z.number().optional(),
    y_vertical: z.boolean().optional(),
  }),
  handler: async (args, driver) => {
    await driver.setCoordSystem(
      args.xmin, args.xmax, args.ymin, args.ymax,
      args.zmin, args.zmax, args.y_vertical
    );
    return ok("coord system updated");
  },
});

const setAxesVisibleTool = def({
  name: "set_axes_visible",
  description: "Show or hide the x- and y-axis.",
  inputSchema: z.object({ x_axis: z.boolean(), y_axis: z.boolean() }),
  handler: async ({ x_axis, y_axis }, driver) => {
    await driver.setAxesVisible(x_axis, y_axis);
    return ok(`axes: x=${x_axis}, y=${y_axis}`);
  },
});

const setGridVisibleTool = def({
  name: "set_grid_visible",
  description: "Show or hide the coordinate grid.",
  inputSchema: z.object({ visible: z.boolean() }),
  handler: async ({ visible }, driver) => {
    await driver.setGridVisible(visible);
    return ok(`grid visible = ${visible}`);
  },
});

const showAllObjectsTool = def({
  name: "show_all_objects",
  description: "Fit the view to all visible objects (zoom-to-fit).",
  inputSchema: z.object({}),
  handler: async (_a, driver) => {
    await driver.showAllObjects();
    return ok("view fit to objects");
  },
});

// -------------------------------- Inspection --------------------------------

const getValueTool = def({
  name: "get_value",
  description: "Get the numeric value of an object (length, area, slider value, etc.).",
  inputSchema: z.object({ name: ObjectName }),
  handler: async ({ name }, driver) => okJSON({ value: await driver.getValue(name) }),
});

const getValueStringTool = def({
  name: "get_value_string",
  description: "Get the value of an object as a display string.",
  inputSchema: z.object({ name: ObjectName }),
  handler: async ({ name }, driver) => okJSON({ value: await driver.getValueString(name) }),
});

const getDefinitionTool = def({
  name: "get_definition",
  description: "Get the definition string of an object (how it was constructed).",
  inputSchema: z.object({ name: ObjectName }),
  handler: async ({ name }, driver) => okJSON({ definition: await driver.getDefinitionString(name) }),
});

const getLatexTool = def({
  name: "get_latex",
  description: "Get the value of an object as a LaTeX string.",
  inputSchema: z.object({ name: ObjectName }),
  handler: async ({ name }, driver) => okJSON({ latex: await driver.getLaTeXString(name) }),
});

const getObjectTypeTool = def({
  name: "get_object_type",
  description: "Get the type of an object (point, line, circle, polygon, function, etc.).",
  inputSchema: z.object({ name: ObjectName }),
  handler: async ({ name }, driver) => okJSON({ type: await driver.getObjectType(name) }),
});

const existsTool = def({
  name: "object_exists",
  description: "Returns whether an object with the given name exists.",
  inputSchema: z.object({ name: ObjectName }),
  handler: async ({ name }, driver) => okJSON({ exists: await driver.exists(name) }),
});

const listObjectsTool = def({
  name: "list_objects",
  description:
    "List the names of all objects in the current construction, optionally filtered by type " +
    "(e.g. 'point', 'line', 'function').",
  inputSchema: z.object({ type: z.string().min(1).max(64).optional() }),
  handler: async ({ type }, driver) => {
    const names = await driver.getAllObjectNames(type);
    return okJSON({ names });
  },
});

const getCoordsTool = def({
  name: "get_coords",
  description: "Get the cartesian coordinates of a point or vector.",
  inputSchema: z.object({ name: ObjectName, three_d: z.boolean().default(false) }),
  handler: async ({ name, three_d }, driver) => {
    const [x, y] = await Promise.all([driver.getXcoord(name), driver.getYcoord(name)]);
    const out: Record<string, number> = { x, y };
    if (three_d) out.z = await driver.getZcoord(name);
    return okJSON(out);
  },
});

// -------------------------------- CAS --------------------------------

const casEvalTool = def({
  name: "cas_eval",
  description:
    "Evaluate a CAS expression via GeoGebra's CAS engine. Returns the symbolic result as a string. " +
    "Examples: 'Solve(x^2 - 5x + 6 = 0, x)', 'Integral(sin(x), x)', 'Factor(x^4 - 1)', 'Simplify((x^2-1)/(x-1))'.",
  inputSchema: z.object({ expression: CommandString }),
  handler: async ({ expression }, driver) => okJSON({ result: await driver.cas(expression) }),
});

const solveTool = def({
  name: "solve",
  description: "Convenience wrapper: Solve(expression, variable). variable defaults to x.",
  inputSchema: z.object({
    expression: CommandString.describe("e.g. 'x^2 = 4' or '2x + 3 = 7'"),
    variable: z.string().min(1).max(32).default("x"),
  }),
  handler: async ({ expression, variable }, driver) => {
    const r = await driver.cas(`Solve(${expression}, ${variable})`);
    return okJSON({ result: r });
  },
});

const factorTool = def({
  name: "factor",
  description: "Symbolic factor of an expression.",
  inputSchema: z.object({ expression: CommandString }),
  handler: async ({ expression }, driver) => {
    return okJSON({ result: await driver.cas(`Factor(${expression})`) });
  },
});

const simplifyTool = def({
  name: "simplify",
  description: "Symbolic simplification of an expression.",
  inputSchema: z.object({ expression: CommandString }),
  handler: async ({ expression }, driver) => {
    return okJSON({ result: await driver.cas(`Simplify(${expression})`) });
  },
});

const derivativeTool = def({
  name: "derivative",
  description: "Symbolic derivative.",
  inputSchema: z.object({
    expression: CommandString,
    variable: z.string().min(1).max(32).default("x"),
    order: z.number().int().min(1).max(10).default(1),
  }),
  handler: async ({ expression, variable, order }, driver) => {
    return okJSON({ result: await driver.cas(`Derivative(${expression}, ${variable}, ${order})`) });
  },
});

const integralTool = def({
  name: "integral",
  description: "Symbolic indefinite or definite integral.",
  inputSchema: z.object({
    expression: CommandString,
    variable: z.string().min(1).max(32).default("x"),
    lower: z.number().optional(),
    upper: z.number().optional(),
  }),
  handler: async ({ expression, variable, lower, upper }, driver) => {
    const cmd = (lower !== undefined && upper !== undefined)
      ? `Integral(${expression}, ${variable}, ${lower}, ${upper})`
      : `Integral(${expression}, ${variable})`;
    return okJSON({ result: await driver.cas(cmd) });
  },
});

// -------------------------------- Export --------------------------------

const exportPngTool = def({
  name: "export_png",
  description:
    "Export the current graphics view as PNG. Returns the image inline AND optionally writes to disk if output_path is given.",
  inputSchema: z.object({
    scale: Scale.default(1).describe("1 = native size; 2 = 2x larger."),
    transparent: z.boolean().default(false),
    dpi: Dpi.default(72),
    output_path: z.string().optional().describe("Optional absolute or cwd-relative file path."),
  }),
  handler: async ({ scale, transparent, dpi, output_path }, driver) => {
    const b64 = await driver.exportPNG(scale, transparent, dpi);
    const wrote = await maybeWriteFile(b64, output_path, "png");
    if (wrote) {
      return {
        content: [
          { type: "text", text: `Wrote PNG to ${wrote}` },
          { type: "image", data: b64, mimeType: "image/png" },
        ],
      };
    }
    return imageContent(b64, "image/png");
  },
});

const exportSvgTool = def({
  name: "export_svg",
  description: "Export the current 2D graphics view as SVG. Returns the SVG text. (3D view returns null.)",
  inputSchema: z.object({
    output_path: z.string().optional(),
  }),
  handler: async ({ output_path }, driver) => {
    const svg = await driver.exportSVG();
    if (!svg) return { content: [{ type: "text", text: "[no SVG — likely 3D view active]" }], isError: true };
    if (output_path) {
      const target = isAbsolute(output_path) ? output_path : resolve(process.cwd(), output_path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, svg, "utf8");
      return ok(`Wrote SVG to ${target}\n\n${svg.slice(0, 2000)}${svg.length > 2000 ? "..." : ""}`);
    }
    return ok(svg);
  },
});

const exportPdfTool = def({
  name: "export_pdf",
  description: "Export the current graphics view as PDF. Returns a data URL and (optionally) writes a file.",
  inputSchema: z.object({
    scale: Scale.default(1),
    output_path: z.string().optional(),
  }),
  handler: async ({ scale, output_path }, driver) => {
    const dataUrl = await driver.exportPDF(scale);
    if (!dataUrl) return { content: [{ type: "text", text: "[PDF export failed]" }], isError: true };
    // dataUrl looks like "data:application/pdf;base64,JVB..." — split it.
    const comma = dataUrl.indexOf(",");
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const wrote = await maybeWriteFile(b64, output_path, "pdf");
    if (wrote) return ok(`Wrote PDF to ${wrote}`);
    return ok(`data URL: ${dataUrl.slice(0, 80)}... (${b64.length} base64 chars)\n\nPass output_path to write to disk.`);
  },
});

// -------------------------------- State (.ggb) --------------------------------

const saveGgbTool = def({
  name: "save_ggb",
  description:
    "Save the current construction as a .ggb file. Returns the base64 payload (so the client can embed it). " +
    "Pass output_path to also write the .ggb to disk.",
  inputSchema: z.object({
    output_path: z.string().optional().describe("Where to write the .ggb file."),
  }),
  handler: async ({ output_path }, driver) => {
    const b64 = await driver.getBase64();
    if (!b64) return { content: [{ type: "text", text: "[empty .ggb]" }], isError: true };
    const wrote = await maybeWriteFile(b64, output_path, "ggb");
    const summary = `base64 length: ${b64.length} chars (${Math.round(b64.length * 0.75)} bytes decoded)`;
    if (wrote) return okJSON({ wrote, summary, base64: b64 });
    return okJSON({ summary, base64: b64 });
  },
});

const loadGgbTool = def({
  name: "load_ggb",
  description:
    "Load a .ggb construction. Provide either base64 (preferred for inline content) or input_path " +
    "(a local .ggb file). Replaces the current construction.",
  inputSchema: z.object({
    base64: Base64String.optional(),
    input_path: z.string().optional(),
  }).refine((v) => !!v.base64 || !!v.input_path, "Provide base64 or input_path"),
  handler: async ({ base64, input_path }, driver) => {
    let b64 = base64;
    if (!b64 && input_path) {
      const target = isAbsolute(input_path) ? input_path : resolve(process.cwd(), input_path);
      const buf = await readFile(target);
      b64 = buf.toString("base64");
    }
    if (!b64) return { content: [{ type: "text", text: "no payload" }], isError: true };
    const ok_ = await driver.setBase64(b64);
    return okJSON({ loaded: ok_ });
  },
});

const getXmlTool = def({
  name: "get_xml",
  description: "Get the current construction as GeoGebra's XML string.",
  inputSchema: z.object({}),
  handler: async (_a, driver) => okJSON({ xml: await driver.getXML() }),
});

const setXmlTool = def({
  name: "set_xml",
  description: "Replace the current construction with the given GeoGebra XML.",
  inputSchema: z.object({ xml: LongString }),
  handler: async ({ xml }, driver) => {
    await driver.setXML(xml);
    return ok("XML applied");
  },
});

// -------------------------------- Embedding --------------------------------

const makeEmbedHtmlTool = def({
  name: "make_embed_html",
  description:
    "Wrap the current construction (saved to a base64 .ggb on the fly) in a self-contained HTML snippet " +
    "that loads deployggb.js and inlines the .ggb. Paste the output into any HTML page or " +
    "HTML-permissive Markdown / Canvas RCE block.",
  inputSchema: z.object({
    width: z.number().int().min(100).max(4000).default(800),
    height: z.number().int().min(100).max(4000).default(600),
    show_tool_bar: z.boolean().default(false),
    show_algebra_input: z.boolean().default(false),
    show_menu_bar: z.boolean().default(false),
    show_reset_icon: z.boolean().default(true),
    enable_right_click: z.boolean().default(false),
    enable_scripting: z.boolean().default(false).describe(
      "Allow scripts embedded in the .ggb to run. Default false for safety."
    ),
    element_id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,64}$/).default("ggb-applet"),
    app_name: z.string().regex(/^[a-z0-9]{1,16}$/).default("graphing"),
    codebase: z.string().url().optional(),
  }),
  handler: async (args, driver) => {
    const b64 = await driver.getBase64();
    const html = makeEmbedHTML(b64, {
      width: args.width, height: args.height,
      showToolBar: args.show_tool_bar,
      showAlgebraInput: args.show_algebra_input,
      showMenuBar: args.show_menu_bar,
      showResetIcon: args.show_reset_icon,
      enableRightClick: args.enable_right_click,
      enableScripting: args.enable_scripting,
      elementId: args.element_id,
      appName: args.app_name,
      codebase: args.codebase,
    });
    return ok(html);
  },
});

const makeEmbedMarkdownTool = def({
  name: "make_embed_markdown",
  description:
    "Same as make_embed_html but framed for a Markdown context. Works wherever raw HTML is allowed " +
    "(GitHub Pages, MkDocs, Obsidian, Canvas Pages with the HTML editor).",
  inputSchema: makeEmbedHtmlTool.inputSchema,
  handler: async (args, driver) => {
    const b64 = await driver.getBase64();
    const md = makeEmbedMarkdown(b64, {
      width: args.width, height: args.height,
      showToolBar: args.show_tool_bar,
      showAlgebraInput: args.show_algebra_input,
      showMenuBar: args.show_menu_bar,
      showResetIcon: args.show_reset_icon,
      enableRightClick: args.enable_right_click,
      enableScripting: args.enable_scripting,
      elementId: args.element_id,
      appName: args.app_name,
      codebase: args.codebase,
    });
    return ok(md);
  },
});

const makeMaterialsIframeTool = def({
  name: "make_materials_iframe",
  description:
    "Produce a GeoGebra Materials iframe for a material you've already uploaded to geogebra.org/materials. " +
    "This is the path that works inside Canvas via the standard GeoGebra LTI integration that most schools " +
    "(including Indiana University) already have installed.",
  inputSchema: z.object({
    material_id: z.string().regex(/^[A-Za-z0-9_-]{4,32}$/).describe("e.g. 'MJWHp9en'"),
    width: z.number().int().min(100).max(4000).default(800),
    height: z.number().int().min(100).max(4000).default(600),
  }),
  handler: async ({ material_id, width, height }, _driver) => {
    return ok(makeMaterialsIframe(material_id, { width, height }));
  },
});

// -------------------------------- Misc --------------------------------

const versionTool = def({
  name: "geogebra_version",
  description: "Return the GeoGebra version running inside the headless applet.",
  inputSchema: z.object({}),
  handler: async (_a, driver) => okJSON({ version: await driver.getVersion() }),
});

// -------------------------------- Registry --------------------------------

export const ALL_TOOLS: ToolDef<any>[] = [
  evalCommandTool,
  setValueTool,
  setCoordsTool,
  deleteObjectTool,
  setVisibleTool,
  setColorTool,
  setCaptionTool,
  renameObjectTool,
  resetTool,
  setAppTool,
  setCoordSystemTool,
  setAxesVisibleTool,
  setGridVisibleTool,
  showAllObjectsTool,
  getValueTool,
  getValueStringTool,
  getDefinitionTool,
  getLatexTool,
  getObjectTypeTool,
  existsTool,
  listObjectsTool,
  getCoordsTool,
  casEvalTool,
  solveTool,
  factorTool,
  simplifyTool,
  derivativeTool,
  integralTool,
  exportPngTool,
  exportSvgTool,
  exportPdfTool,
  saveGgbTool,
  loadGgbTool,
  getXmlTool,
  setXmlTool,
  makeEmbedHtmlTool,
  makeEmbedMarkdownTool,
  makeMaterialsIframeTool,
  versionTool,
];
