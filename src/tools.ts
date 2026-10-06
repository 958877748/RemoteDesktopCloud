/**
 * Step 3 — ChatGPT 侧看到的全部 29 个工具的静态注册表。
 *
 * 25 个 = 真实设备端 `tools/list` 的抓取结果（`scripts/capture-tools.mjs` →
 * `tools.captured.json`）去掉 `get_prompts`（remote 模式不展示）；
 * 4 个 = remote 专属（`list_devices` / `ping` / `who_am_i` / `shutdown`），
 * 由本文件自行定义，`device.ts` 对 `ping`/`shutdown` 有设备侧特判。
 *
 * 零手抄：抓取脚本重跑即可与设备端保持同步。
 */
import type { Tool } from "@modelcontextprotocol/server";
import raw from "../tools.captured.json";

/** 设备端抓来的 26 个（含 `get_prompts`） */
const CAPTURED = raw as unknown as Tool[];

const CAPTURED_EXCLUDED = new Set(["get_prompts"]);

/** remote 模式不展示的设备端工具 */
export const REMOTE_EXCLUDED_TOOLS = CAPTURED_EXCLUDED;

const REMOTE_TOOLS: Tool[] = [
  {
    name: "list_devices",
    description:
      "List the machines paired with this Desktop Commander account, together with their online status and last-seen time. " +
      "Use it to discover which machine is available before running other remote tools.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List Devices", readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "ping",
    description:
      "Check that the remote machine running Desktop Commander is reachable. " +
      "Returns the device response and round-trip latency; call it before other remote tools if you are unsure the machine is online.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Ping Remote Machine", readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "who_am_i",
    description:
      "Return the identity of the currently authenticated remote session (user id and email).",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Who Am I", readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "shutdown",
    description:
      "Shut down the Desktop Commander server running on the remote machine. " +
      "The machine goes offline for remote control until the server is started again.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Shutdown Remote Server", readOnlyHint: false, openWorldHint: true },
  },
];

/** 全部 29 个工具定义，按 name 升序，供 `tools/list` 原样返回。 */
export const TOOLS: Tool[] = [
  ...CAPTURED.filter((t) => !CAPTURED_EXCLUDED.has(t.name)),
  ...REMOTE_TOOLS,
].sort((a, b) => a.name.localeCompare(b.name));

export const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name));
