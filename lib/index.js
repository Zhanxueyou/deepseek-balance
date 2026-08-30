/**
 * dsh-balance-panel — host half.
 *
 * Serves a single same-origin JSON endpoint `/dsh-balance-api/stats` with:
 *   - balance:  DeepSeek 账户余额（key 来自 DSH credentials 服务，不出进程）
 *   - usage:    从本地会话日志（~/.dsh/sessions 下各会话的 session.jsonl.zstd）聚合的
 *               今日 / 本月 / 全部 的 token 用量与缓存命中（prompt_cache_hit）
 *
 * 路由仅允许 loopback + 同源请求（防 DNS rebinding）。
 * 数据带 TTL 缓存，避免每次打开面板都重扫日志 / 重查余额。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

export const name = "dsh-balance-panel";
export const inject = ["webServer", "credentials"];

const BALANCE_URL = "https://api.deepseek.com/user/balance";
const BALANCE_TTL_MS = 60_000; // 余额缓存 1 分钟
const USAGE_TTL_MS = 30_000; // 用量缓存 30 秒（日志随会话增长）
const BALANCE_TIMEOUT_MS = 15_000;
const MAX_LOG_BYTES = 64 * 1024 * 1024; // 单文件过大直接跳过
const SESSIONS_ROOT = process.env.DSH_BALANCE_SESSIONS_ROOT || join(homedir(), ".dsh", "sessions");
const API_KEY_REF = "DEEPSEEK_API_KEY";

/* ---------------- 小工具 ---------------- */

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** loopback + 同源守卫：非本机 / 跨站请求一律拒绝。 */
function isLoopbackRequest(req) {
  const addr = req.socket?.remoteAddress;
  if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") return false;
  const host = req.headers?.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/* ---------------- 余额 ---------------- */

async function fetchBalance(apiKey) {
  const res = await fetch(BALANCE_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error(`余额接口 HTTP ${res.status}`);
  return res.json();
}

/* ---------------- 用量聚合（本地会话日志） ---------------- */

/** zstd 帧魔数（小端 0xFD2FB528 = 28 b5 2f fd）。 */
const ZSTD_MAGIC_LE = 0xfd2fb528;

/**
 * 扫描 zstd 容器中的完整帧区间。DSH 的会话日志是「每批写入一帧」的
 * 多帧拼接容器，而 Node 的 zstdDecompressSync 一次只解第一帧，因此必须
 * 先按帧结构定位边界，再逐帧解码。算法与 DSH 自身持久化层一致。
 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC_LE) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) break; // 保留位
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    let complete = true;
    for (;;) {
      if (buffer.length - offset < 3) {
        complete = false;
        break;
      }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        complete = false;
        break;
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        complete = false;
        break;
      }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (!complete) break;
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

function readSessionFile(file) {
  let buf;
  try {
    const st = statSync(file);
    if (st.size > MAX_LOG_BYTES) return "";
    buf = readFileSync(file);
  } catch {
    return "";
  }
  if (buf.length < 4 || buf.readUInt32LE(0) !== ZSTD_MAGIC_LE) {
    // 明文 JSONL（压缩关闭时的兜底）
    return buf.toString("utf8");
  }
  let out = "";
  for (const frame of scanZstdFrames(buf)) {
    try {
      out += zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString("utf8");
    } catch {
      // 跳过损坏帧，不中断整体读取
    }
  }
  return out;
}

/** 扫描所有会话日志，收集每条 usage 记录。 */
function collectUsageRows() {
  const rows = [];
  let workspaceDirs;
  try {
    workspaceDirs = readdirSync(SESSIONS_ROOT, { withFileTypes: true });
  } catch {
    return rows;
  }
  for (const ws of workspaceDirs) {
    if (!ws.isDirectory()) continue;
    const wsDir = join(SESSIONS_ROOT, ws.name);
    let sessionDirs;
    try {
      sessionDirs = readdirSync(wsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sd of sessionDirs) {
      if (!sd.isDirectory()) continue;
      const text = readSessionFile(join(wsDir, sd.name, "session.jsonl.zstd")) ||
        readSessionFile(join(wsDir, sd.name, "session.jsonl"));
      for (const line of text.split("\n")) {
        if (!line) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const chunk = rec?.data?.chunk;
        if (rec.type !== "assistant/chunk" || chunk?.type !== "usage" || !chunk.usage) continue;
        const u = chunk.usage;
        rows.push({
          time: Number(rec.time) || 0,
          inputTokens: Number(u.inputTokens) || 0,
          outputTokens: Number(u.outputTokens) || 0,
          cacheReadTokens: Number(u.cacheReadTokens) || 0,
        });
      }
    }
  }
  return rows;
}

function sumWindow(rows, fromMs) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let requests = 0;
  for (const r of rows) {
    if (r.time < fromMs) continue;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    cacheReadTokens += r.cacheReadTokens;
    requests += 1;
  }
  const totalInput = inputTokens + cacheReadTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    requests,
    cacheHitRatio: totalInput > 0 ? cacheReadTokens / totalInput : 0,
  };
}

function aggregateUsage() {
  const rows = collectUsageRows();
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  // 最早一条记录的时间（全部用量的起始点，便于前端标注「自 X 起」）
  let earliestAt = null;
  if (rows.length > 0) {
    let min = rows[0].time;
    for (const r of rows) if (r.time < min) min = r.time;
    earliestAt = min;
  }
  return {
    today: sumWindow(rows, todayStart),
    month: sumWindow(rows, monthStart),
    all: sumWindow(rows, 0),
    earliestAt,
  };
}

/* ---------------- 插件入口 ---------------- */

export function apply(ctx) {
  const usageCache = { at: 0, data: null };
  const balanceCache = { at: 0, data: null, error: null };

  const handler = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (!isLoopbackRequest(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const now = Date.now();

      // 用量（本地日志聚合）
      let usage = usageCache.data;
      if (!usage || now - usageCache.at > USAGE_TTL_MS) {
        usage = aggregateUsage();
        usageCache.at = now;
        usageCache.data = usage;
      }

      // 余额（DeepSeek API，凭证不出进程）
      let balance = balanceCache.data;
      let balanceError = balanceCache.error;
      if (balanceCache.data === null && balanceCache.error === null) {
        // 冷启动占位：立即查一次
      }
      if (now - balanceCache.at > BALANCE_TTL_MS || (balanceCache.data === null && balanceCache.error === null)) {
        try {
          const credentials = ctx.get("credentials");
          let apiKey;
          if (credentials !== void 0) {
            const hit = await credentials.resolve(API_KEY_REF);
            apiKey = hit?.value;
          }
          if (!apiKey) throw new Error("未找到 DEEPSEEK_API_KEY 凭证（请在 Web 设置 Models 页配置，或导出环境变量）");
          balance = await fetchBalance(apiKey);
          balanceCache.data = balance;
          balanceCache.error = null;
        } catch (e) {
          balance = null;
          balanceError = String(e?.message ?? e);
          balanceCache.data = null;
          balanceCache.error = balanceError;
        }
        balanceCache.at = now;
      }

      json(res, 200, {
        ok: true,
        fetchedAt: new Date().toISOString(),
        balance,
        balanceError,
        usage,
      });
    } catch (e) {
      json(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/dsh-balance-api/stats", handler }),
    "dsh-balance-panel: stats route",
  );
}

/* 导出纯函数便于测试（对插件加载无影响） */
export { aggregateUsage, collectUsageRows };
