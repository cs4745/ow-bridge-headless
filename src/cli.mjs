#!/usr/bin/env node
// OW Bridge headless —— 运维 CLI
// 直接复用运行时模块，不经过 HTTP 服务，也不需要 api-key。
// 用法：node src/cli.mjs <update|models|test>
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataDirectory } from './platform.js';
import { findRuntime, runtimeVersion, startBackend } from './runtime.js';
import { systemProxyEnvironment } from './system-proxy.js';
import { clientModelID } from './model-status.js';
import { prepare } from './protocol.js';

const exec = promisify(execFile);
const dataDir = process.env.BUDDY_DATA_DIR || dataDirectory();
const logFile = path.join(dataDir, 'cli.log');
const logStream = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
const fileLog = m => { logStream.write(`${new Date().toISOString()} ${m}\n`); };

async function boot() {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const proxyEnv = await systemProxyEnvironment(false);
  const binary = await findRuntime(dataDir, msg => console.log(msg), { proxyEnv, log: fileLog });
  console.log(`OpenCode 运行时：${binary}`);
  const runtime = await startBackend(binary, dataDir, logStream, proxyEnv);
  console.log(`OpenCode 已就绪 v${runtime.version}\n`);
  return runtime;
}

async function cmdUpdate() {
  const proxyEnv = await systemProxyEnvironment(false);
  const binary = await findRuntime(dataDir, msg => console.log(msg), { update: true, proxyEnv, log: fileLog });
  const version = runtimeVersion((await exec(binary, ['--version'], { timeout: 15000, windowsHide: true })).stdout);
  console.log(`\nOpenCode 已更新/就绪：${version}`);
  console.log(`路径：${binary}`);
  console.log('（若已是最新版本则不会重新下载）');
}

async function cmdModels() {
  const runtime = await boot();
  try {
    const models = await runtime.backend.models();
    console.log(`发现 ${models.length} 个免费模型：`);
    for (const m of models) console.log(`  - ${clientModelID(m)}`);
  } finally {
    await runtime.stop();
  }
}

async function cmdTest() {
  const runtime = await boot();
  try {
    const models = await runtime.backend.models();
    console.log(`测试 ${models.length} 个免费模型的对话能力...\n`);
    let pass = 0, fail = 0;
    for (const m of models) {
      const id = clientModelID(m);
      const start = Date.now();
      try {
        const body = { model: id, messages: [{ role: 'user', content: 'Reply with the single word: OK' }], stream: false };
        const request = prepare(body, models);
        const result = await runtime.backend.complete(request, AbortSignal.timeout(90000), { probe: true, model: request.model.id });
        const msg = result.choices?.[0]?.message;
        const content = (msg?.content || '').trim();
        const calls = msg?.tool_calls?.length || 0;
        const ms = Date.now() - start;
        if (content || calls) {
          console.log(`  PASS  ${id}  (${ms}ms)  ${content.slice(0, 36).replace(/\s+/g, ' ')}`);
          pass++;
        } else {
          console.log(`  FAIL  ${id}  (${ms}ms)  空响应`);
          fail++;
        }
      } catch (e) {
        console.log(`  FAIL  ${id}  (${Date.now() - start}ms)  ${e.message}`);
        fail++;
      }
    }
    console.log(`\n结果：${pass} 通过 / ${fail} 失败 / 共 ${models.length}`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    await runtime.stop();
  }
}

function usage() {
  console.log(`OW Bridge headless 运维 CLI
用法：node src/cli.mjs <命令>

命令：
  update   更新 OpenCode 运行时（已最新则跳过下载）
  models   读取并列出当前可用的免费模型
  test     逐个测试免费模型的对话能力（含耗时与通过/失败）

环境变量：
  BUDDY_DATA_DIR   数据目录（默认 %APPDATA%\\Buddy Bridge 或 ~/.config/Buddy Bridge）
  BUDDY_PORT       仅在使用 HTTP 服务时生效（CLI 不走 HTTP）

说明：CLI 直接驱动 OpenCode 运行时，不经过本地 HTTP 服务，也不需要 api-key。
首次运行会自动下载 OpenCode 运行时（约数十 MB），请保持联网。`);
}

async function run() {
  const cmd = process.argv[2];
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') return usage();
  if (cmd === 'update') return await cmdUpdate();
  if (cmd === 'models') return await cmdModels();
  if (cmd === 'test') return await cmdTest();
  console.error(`未知命令：${cmd}\n`);
  usage();
  process.exitCode = 2;
}

run().catch(e => { console.error(`\n错误：${e.message}`); process.exitCode = 1; });
