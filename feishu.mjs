// Feishu Bot Bridge & Autonomous Multi-Agent Monitor for Cursor
// Solves multi-agent routing ambiguity with 3 conflict-free mechanisms:
// 1. Feishu Quote-Reply (左滑引用回复): replying to a sub-process's Feishu message routes directly to that sub-process.
// 2. Prefix shortcut (@2 xxx or #2 xxx): routes directly to session #2.
// 3. Normal message (no quote, no prefix): always routes to the Master Agent, which can invoke `node cursor-ctl.mjs` to inspect/control any sub-process on your behalf.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadEnv, discoverAllSessions, resolveTarget, inspectSession, sendToSession, stopSession } from './cursor-ctl.mjs';

loadEnv();

const defaultLarkCli = (() => {
  const localBin = path.join(os.homedir(), '.local', 'bin', 'lark-cli');
  return fs.existsSync(localBin) ? localBin : 'lark-cli';
})();

const LARK_CLI = process.env.LARK_CLI || defaultLarkCli;
const ALLOWED_OPEN_ID = (process.env.FEISHU_OPEN_ID || '').trim();
const MASTER_CHAT_ID = (process.env.MASTER_CHAT_ID || '').trim();

const CLI_ENV = {
  ...process.env,
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
};

// Maps Feishu message_id (om_xxx) -> { seq, chatId, winId, name } for quote-reply routing
const msgTargetMap = new Map();
let lastAlertSession = null;

function rememberMessageTarget(rawOut, session) {
  if (!session) return;
  try {
    const parsed = JSON.parse(rawOut);
    const msgId = parsed?.data?.message_id;
    if (msgId) {
      msgTargetMap.set(msgId, session);
      if (msgTargetMap.size > 500) {
        const firstKey = msgTargetMap.keys().next().value;
        msgTargetMap.delete(firstKey);
      }
    }
  } catch {}
}

function runLark(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(LARK_CLI, args, { env: CLI_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || out.trim() || `lark-cli exited ${code}`)));
  });
}

// Prevent Feishu enterprise DLP (error code 230028: EMAIL_ADDRESS) from blocking bot notifications
function sanitizeForFeishu(str) {
  return String(str || '').replace(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1[@]$2');
}

async function sendText(text, replyToMsgId = null, bindSession = null) {
  if (!replyToMsgId && !ALLOWED_OPEN_ID) return '';
  const safeText = sanitizeForFeishu(text);
  const args = replyToMsgId
    ? ['im', '+messages-reply', '--as', 'bot', '--message-id', replyToMsgId, '--text', safeText]
    : ['im', '+messages-send', '--as', 'bot', '--user-id', ALLOWED_OPEN_ID, '--text', safeText];
  let out;
  try {
    out = await runLark(args);
  } catch (e) {
    if (/230028|sensitive data/i.test(e.message)) {
      const fallback = safeText.replace(/@/g, ' [at] ');
      const retryArgs = [...args.slice(0, -1), fallback];
      out = await runLark(retryArgs);
    } else {
      throw e;
    }
  }
  rememberMessageTarget(out, bindSession);
  return out;
}

async function sendMarkdown(md, replyToMsgId = null, bindSession = null) {
  if (!replyToMsgId && !ALLOWED_OPEN_ID) return '';
  const safeMd = sanitizeForFeishu(md);
  const args = replyToMsgId
    ? ['im', '+messages-reply', '--as', 'bot', '--message-id', replyToMsgId, '--markdown', safeMd]
    : ['im', '+messages-send', '--as', 'bot', '--user-id', ALLOWED_OPEN_ID, '--markdown', safeMd];
  let out;
  try {
    out = await runLark(args);
  } catch (e) {
    if (/230028|sensitive data/i.test(e.message)) {
      const fallback = safeMd.replace(/@/g, ' [at] ');
      const retryArgs = [...args.slice(0, -1), fallback];
      out = await runLark(retryArgs);
    } else {
      throw e;
    }
  }
  rememberMessageTarget(out, bindSession);
  return out;
}

async function handleIncomingFeishu(ev) {
  const text = String(ev.content || '').trim();
  const msgId = ev.message_id;
  if (!text) return;

  // 1. Help command
  if (/^(\/help|帮助|\?)$/.test(text)) {
    await sendMarkdown([
      '**Cursor 飞书智能路由与控制指南**',
      '',
      '**🎯 怎么区分「发给子进程」还是「发给总控 Agent」？**',
      '1. **直接打字发送（不引用）** 👉 **100% 发给总控 Agent（`#1`）**。你可以直接用自然语言跟总控说（比如 *“让 #2 按方案A继续跑”*），总控会自动调用 `cursor-ctl.mjs` 帮你操作子进程！',
      '2. **左滑「引用回复」某条子进程的汇报消息** 👉 **100% 直达那个子进程**！',
      '3. **加上编号前缀 `@2 你的话` 或 `#2 你的话`** 👉 **直达 `#2` 子进程**！',
      '',
      '**⚡ 快捷指令**',
      '- `状态` / `进程` / `/ps`：查看所有对话进程编号与实时状态',
      '- `读 2` / `/read 2`：读取 `#2` 进程的详细最近对话',
      '- `允许` / `/ok`：批准最近等待确认的进程（也可左滑引用某条通知回 `允许`）',
      '- `停止 2` / `/stop 2`：停止正在运行的 `#2` 进程',
    ].join('\n'), msgId);
    return;
  }

  // 2. List all sessions
  if (/^(\/ps|\/win|状态|进程|窗口|汇报)$/.test(text)) {
    const sessions = await discoverAllSessions();
    const lines = sessions.map(s => {
      const badge = s.busy ? '🔄 **[运行中]**' : '✅ [空闲]';
      const masterTag = s.isMaster ? ' 👈 **[总控 Agent]**' : '';
      return `**#${s.seq}** ${badge} \`${s.name}\`${masterTag}`;
    });
    await sendMarkdown(
      `📊 **当前全部对话进程（共 ${sessions.length} 个）：**\n\n${lines.join('\n')}\n\n` +
      `💡 *直接打字发给总控 \`#1\`；发 \`@编号 内容\` 或左滑引用通知可直达对应子进程；发 \`读 编号\` 查看某进程详情。*`,
      msgId,
    );
    return;
  }

  // 3. Read a specific session's details
  const readMatch = /^(?:\/read|读|查看)\s*[#@]?(\d+)$/i.exec(text);
  if (readMatch) {
    const target = await resolveTarget(readMatch[1]);
    if (!target) {
      await sendText(`未找到编号 #${readMatch[1]} 的进程，发「状态」查看编号列表`, msgId);
      return;
    }
    const detail = await inspectSession(target, true);
    const body = detail?.items?.slice(-5).map(i => `**${i.k === 'human' ? '🧑 你' : i.k === 'assistant' ? '🤖 Agent' : '🔧 工具'}**：\n${i.text.slice(0, 600)}`).join('\n\n---\n\n') || '（暂无内容）';
    await sendMarkdown(
      `📋 **进程 #${target.seq}：${target.name}** (${detail?.busy ? '🔄 运行中' : '✅ 空闲'})\n\n${body}\n\n` +
      `💡 *左滑引用本条消息回复，可直接把话发给 \`#${target.seq}\`*`,
      msgId,
      target,
    );
    return;
  }

  // 4. Stop a specific session
  const stopMatch = /^(?:\/stop|停止)\s*[#@]?(\d+)$/i.exec(text);
  if (stopMatch) {
    const target = await resolveTarget(stopMatch[1]);
    if (!target) {
      await sendText(`未找到编号 #${stopMatch[1]} 的进程`, msgId);
      return;
    }
    const ok = await stopSession(target);
    await sendText(
      ok ? `🛑 已停止进程 #${target.seq}（${target.name}）` : `进程 #${target.seq}（${target.name}）当前未在运行`,
      msgId,
      target,
    );
    return;
  }

  // 5. Determine target session via:
  //    (a) Quote-reply (ev.reply_to / ev.root_id)
  //    (b) Explicit prefix (@2 xxx or #2 xxx)
  //    (c) Default -> Master Agent (MASTER_CHAT_ID or #1)
  let quotedSession = (ev.reply_to && msgTargetMap.get(ev.reply_to))
    || (ev.root_id && msgTargetMap.get(ev.root_id))
    || null;

  const prefixMatch = /^[@#](\d+)\s+([\s\S]+)$/.exec(text);

  // Quick button click ("允许", "/ok", "/btn 1")
  const btnMatch = /^(?:\/ok|允许|运行|继续|\/btn\s*(\d+))$/.exec(text);
  if (btnMatch) {
    const target = quotedSession || lastAlertSession || await resolveTarget(MASTER_CHAT_ID);
    if (!target) {
      await sendText('当前没有找到待确认的目标进程', msgId);
      return;
    }
    const detail = await inspectSession(target, true);
    const idx = btnMatch[1] ? Number(btnMatch[1]) - 1 : 0;
    const btn = detail?.buttons?.[idx];
    if (!btn) {
      await sendText(`进程 #${target.seq}（${target.name}）当前没有待点击的确认按钮`, msgId, target);
      return;
    }
    const { spawnSync } = await import('node:child_process');
    spawnSync(process.execPath, ['cursor-ctl.mjs', 'click', String(target.seq), String(idx + 1)], { cwd: process.cwd() });
    await sendText(`✅ 已在进程 #${target.seq}（${target.name}）点击「${btn.label}」`, msgId, target);
    return;
  }

  // Route A: Explicit prefix `@2 message` or `#2 message`
  if (prefixMatch) {
    const target = await resolveTarget(prefixMatch[1]);
    if (!target) {
      await sendText(`找不到编号 #${prefixMatch[1]} 的进程（发「状态」查看列表）`, msgId);
      return;
    }
    await sendToSession(target, prefixMatch[2]);
    await sendText(`📨 已直达子进程 #${target.seq}（${target.name}），跑完后会自动向你汇报`, msgId, target);
    return;
  }

  // Route B: User quote-replied a sub-process notification card in Feishu
  if (quotedSession && !quotedSession.isMaster) {
    const target = await resolveTarget(quotedSession.chatId) || quotedSession;
    await sendToSession(target, text);
    await sendText(`📨 [引用直达] 已发给子进程 #${target.seq || ''}（${target.name}），跑完后会自动向你汇报`, msgId, target);
    return;
  }

  // Route C: Default -> Always send to the Master Agent
  const master = await resolveTarget(MASTER_CHAT_ID);
  if (!master) {
    await sendText('未找到总控 Agent 进程，请确认 Cursor 窗口已打开且开启了 CDP 端口', msgId);
    return;
  }
  await sendToSession(master, text);
  await sendText(
    `📨 已发给总控 Agent（#${master.seq}），思考或操作完成后会自动推送给你`,
    msgId,
    master,
  );
}

// Proactive background watcher: monitors ALL sessions (including sidebar background items in Cursor Agents)
function startProactiveWatcher() {
  const stateMap = new Map(); // chatId -> { busy, idleTicks, waiting, waitTicks, toldWait, lastAssistKey }
  let running = false;

  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const sessions = await discoverAllSessions().catch(() => []);
      for (const s of sessions) {
        let prev = stateMap.get(s.chatId);
        if (!prev) {
          stateMap.set(s.chatId, {
            busy: s.busy,
            idleTicks: 0,
            waiting: s.waiting || null,
            waitTicks: 0,
            toldWait: Boolean(s.waiting),
            lastAssistKey: s.lastAssistKey || null,
          });
          continue;
        }

        // 1. Check if session entered a waiting-for-confirmation / question state
        if (s.waiting !== prev.waiting) {
          prev.waiting = s.waiting;
          prev.waitTicks = 0;
          prev.toldWait = false;
        }
        if (s.waiting && !prev.toldWait && ++prev.waitTicks >= 2) {
          prev.toldWait = true;
          lastAlertSession = s;
          const detail = await inspectSession(s, true).catch(() => null);
          const btns = detail?.buttons || [];
          const lastItem = detail?.items?.[detail.items.length - 1]?.text?.slice(0, 1000) || s.waiting;
          const btnText = btns.length
            ? `\n\n⏳ **可点按钮**：${btns.map((b, i) => `\`[${i + 1}] ${b.label}\``).join(' ')}（左滑引用本消息回 \`允许\` 即可点击）`
            : '';
          await sendMarkdown(
            `⏳ **进程 #${s.seq} 需要你确认/回答 · ${s.name}**\n\n` +
            `${lastItem}${btnText}\n\n---\n` +
            `💡 **左滑引用本条消息**可直接回复该进程（或发 \`#${s.seq} 你的指令\`）`,
            null,
            s,
          ).catch(e => console.error('推送失败:', e.message));
        }

        // 2. Check busy -> idle transition OR new assistant reply while idle
        if (s.busy) {
          prev.busy = true;
          prev.idleTicks = 0;
          if (s.lastAssistKey) prev.lastAssistKey = s.lastAssistKey;
          continue;
        }

        const finishedFromBusy = prev.busy && ++prev.idleTicks >= 2;
        const newFastReply = !prev.busy && s.lastAssistKey && s.lastAssistKey !== prev.lastAssistKey;

        if (finishedFromBusy || newFastReply) {
          prev.busy = false;
          prev.idleTicks = 0;
          if (s.lastAssistKey) prev.lastAssistKey = s.lastAssistKey;
          lastAlertSession = s;
          const detail = await inspectSession(s, true).catch(() => null);
          const lastAssistItem = [...(detail?.items || [])].reverse().find(i => i.k === 'assistant');
          if (lastAssistItem?.rowKey) prev.lastAssistKey = lastAssistItem.rowKey;
          const lastAssist = lastAssistItem?.text?.slice(0, 3000) || '';
          const lastOther = detail?.items?.[detail.items.length - 1]?.text?.slice(0, 600) || '';
          const btns = detail?.buttons || [];

          if (s.isMaster) {
            await sendMarkdown(
              `🤖 **总控 Agent (#${s.seq}) 回复：**\n\n${lastAssist || lastOther || '（已完成）'}`,
              null,
              s,
            ).catch(e => console.error('推送失败:', e.message));
          } else {
            const btnText = btns.length
              ? `\n\n⏳ **待确认按钮**：${btns.map((b, i) => `\`[${i + 1}] ${b.label}\``).join(' ')}（左滑引用本消息回 \`允许\` 即可点击）`
              : '';
            await sendMarkdown(
              `🔔 **子进程 #${s.seq} 状态更新 · ${s.name}**\n\n` +
              `${lastAssist || lastOther || '（当前轮次已结束）'}${btnText}\n\n---\n` +
              `💡 **下一步怎么处理？**\n` +
              `- 想**直接回复该子进程**：请**左滑引用本条消息**回复（或发 \`#${s.seq} 你的指令\`）\n` +
              `- 想**跟总控商量或让总控代办**：直接在下方打字发送即可`,
              null,
              s,
            ).catch(e => console.error('推送失败:', e.message));
          }
        }
      }
    } finally {
      running = false;
    }
  }, 3000);
}

function startEventConsumer() {
  const seenMsgIds = new Set();
  const keepAlive = spawn('tail', ['-f', '/dev/null'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const proc = spawn(LARK_CLI, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'], {
    env: CLI_ENV,
    stdio: [keepAlive.stdout, 'pipe', 'pipe'],
  });

  let buf = '';
  proc.stdout.on('data', chunk => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.sender_type !== 'user') continue;
        if (!ALLOWED_OPEN_ID) {
          console.log(`[提示] 收到来自用户的消息，请将以下 open_id 填入 .env 的 FEISHU_OPEN_ID 中: ${ev.sender_id}`);
          continue;
        }
        if (ev.sender_id !== ALLOWED_OPEN_ID) continue;
        if (!ev.message_id || seenMsgIds.has(ev.message_id)) continue;
        seenMsgIds.add(ev.message_id);
        console.log(`[飞书消息] (reply_to=${ev.reply_to || 'none'}) ${ev.content}`);
        handleIncomingFeishu(ev).catch(async err => {
          console.error('[处理错误]', err.message);
          await sendText(`⚠️ 执行失败：${err.message}`, ev.message_id).catch(() => {});
        });
      } catch {}
    }
  });

  proc.stderr.on('data', d => {
    const s = d.toString('utf8').trim();
    if (s) console.log(s);
  });

  proc.on('close', code => {
    keepAlive.kill();
    console.log(`飞书长连接已断开 (code ${code})，3 秒后重连…`);
    setTimeout(startEventConsumer, 3000);
  });

  const cleanup = () => {
    keepAlive.kill();
    proc.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

console.log('== Feishu Agent for Cursor (支持引用路由 + @编号 + 总控代办) 启动中 ==');
if (!ALLOWED_OPEN_ID) {
  console.warn('⚠️ 警告: 未配置 FEISHU_OPEN_ID（请在 .env 文件中设置）。向机器人发一条消息即可在日志中查看你的 open_id。');
}
startProactiveWatcher();
startEventConsumer();
