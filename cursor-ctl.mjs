#!/usr/bin/env node
// CLI tool & SDK for the Master Agent (and Feishu bridge) to inspect, send messages to,
// click confirmation buttons in, or stop any Cursor conversation/window via CDP.
//
// Usage:
//   node cursor-ctl.mjs list
//   node cursor-ctl.mjs read <index_or_chatId>
//   node cursor-ctl.mjs send <index_or_chatId> "<message>"
//   node cursor-ctl.mjs click <index_or_chatId> [buttonIndex=1]
//   node cursor-ctl.mjs stop <index_or_chatId>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadEnv() {
  try {
    const content = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1];
      const val = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {}
}

loadEnv();

const CDP_URL = (process.env.CDP_URL || 'http://127.0.0.1:9222').replace(/\/$/, '');
const MASTER_CHAT_ID = (process.env.MASTER_CHAT_ID || '').trim();

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`CDP connect failed: ${this.wsUrl}`));
      ws.onclose = () => {
        for (const { reject } of this.pending.values()) reject(new Error('CDP closed'));
        this.pending.clear();
      };
      ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        }
      };
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.value;
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function listWindows() {
  const res = await fetch(`${CDP_URL}/json/list`).catch(() => {
    throw new Error(`Cannot connect to Cursor CDP (${CDP_URL}). Please run ./start-cursor.sh first.`);
  });
  const targets = await res.json();
  return targets
    .filter(t => t.type === 'page' && /workbench/.test(t.url))
    .map(t => ({
      id: t.id,
      title: t.title,
      ws: t.webSocketDebuggerUrl,
      kind: t.title === 'Cursor Agents' ? 'agents' : /\[SSH: /.test(t.title) ? 'ssh' : 'local',
    }));
}

async function tapCss(cdp, x, y) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

async function pressEnter(cdp) {
  const ev = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ev });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
}

export async function discoverAllSessions() {
  const wins = await listWindows();
  const sessions = [];
  let seq = 1;

  for (const win of wins) {
    const cdp = new Cdp(win.ws);
    try {
      await cdp.connect();
      if (win.kind === 'agents') {
        const items = await cdp.evaluate(`(() => {
          const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
          const ROW_SEL = '[data-flat-index], .virtualized-composer-messages-row[data-index]';
          const STOP_SEL = 'button[aria-label="Stop generation"], .stop-button, .composer-button-area .codicon-debug-stop, .send-with-mode .codicon-debug-stop';
          const SKIP = /ui-collapsible-header|md-clickable-code|ui-markdown__inline-code|output-preview|codicon-find|widget-close|model-picker|stop-button|ui-prompt-input-submit-button/;
          const WAIT_EXACT = /^(run(\\s+command)?|allow|accept|approve|continue|yes|运行|允许|接受|批准|继续)$/i;
          const out = [];
          const seen = new Set();
          for (const li of document.querySelectorAll('li.ui-sidebar-menu-item[data-sidebar-item-key]')) {
            const chatId = (li.dataset.sidebarItemKey || '').replace(/^row:/, '');
            if (!chatId || seen.has(chatId)) continue;
            seen.add(chatId);
            const sec = li.closest('section.ui-sidebar-section');
            const repo = sec ? (sec.innerText.split('\\n')[0]?.trim() || '') : '';
            const title = (li.innerText || '').trim().replace(/\\s+/g, ' ');
            const spinning = !!li.querySelector('.ui-dot-grid-loader, [aria-label="In progress"]');
            const bubble = document.querySelector('[id^="bubble-' + chatId + '-"]');
            const mounted = !!bubble;
            let paneBusy = false;
            let waiting = null;
            let lastAssistKey = null;
            if (bubble) {
              const panel = bubble.closest('.agent-panel-conversation-shell')
                || bubble.closest('.agent-conversation-composer__viewport')?.parentElement
                || bubble.closest('.composer-messages-container');
              if (panel) {
                paneBusy = [...panel.querySelectorAll(STOP_SEL)].some(vis);
                const allRows = [...panel.querySelectorAll('[data-find-row-key]')];
                const lastHumanIdx = allRows.reduce((acc, r, i) => (r.dataset.findRowKey || '').startsWith('human:') ? i : acc, -1);
                const lastAssistIdx = allRows.reduce((acc, r, i) => (r.dataset.findRowKey || '').startsWith('assistant-markdown:') ? i : acc, -1);
                if (lastAssistIdx >= 0 && lastAssistIdx > lastHumanIdx) {
                  lastAssistKey = allRows[lastAssistIdx].dataset.findRowKey || null;
                }
                const qn = panel.querySelector('.composer-questionnaire-toolbar');
                if (qn && vis(qn)) {
                  waiting = 'question:' + (qn.innerText || '').trim().slice(0, 120);
                } else {
                  const rows = [...panel.querySelectorAll(ROW_SEL)].filter(e => !e.parentElement.closest(ROW_SEL));
                  const btns = [];
                  for (const r of rows.slice(-5)) {
                    for (const b of r.querySelectorAll('button, [role=button], .anysphere-button, .composer-run-button')) {
                      if (!vis(b) || SKIP.test(b.className) || /^stop/i.test(b.getAttribute('aria-label') || '') || b.parentElement.closest('button, [role=button]')) continue;
                      const l = ((b.innerText || '').trim() || b.getAttribute('aria-label') || '').split('\\n')[0].trim().slice(0, 30);
                      if (l && WAIT_EXACT.test(l)) btns.push(l);
                    }
                  }
                  if (btns.length) waiting = 'btn:' + btns.join('/');
                }
              }
            }
            out.push({ chatId, repo, title, spinning: spinning || paneBusy, waiting, lastAssistKey, mounted });
          }
          return out;
        })()`);
        for (const it of items) {
          sessions.push({
            seq: seq++,
            winId: win.id,
            winTitle: win.title,
            winKind: win.kind,
            ws: win.ws,
            chatId: it.chatId,
            name: it.repo ? `${it.repo} / ${it.title}` : it.title,
            busy: it.spinning,
            waiting: it.waiting || null,
            lastAssistKey: it.lastAssistKey || null,
            mounted: it.mounted,
            isMaster: MASTER_CHAT_ID ? it.chatId.startsWith(MASTER_CHAT_ID) : false,
          });
        }
      } else {
        const info = await cdp.evaluate(`(() => {
          const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
          const hasEd = [...document.querySelectorAll('.aislash-editor-input[contenteditable="true"], .ui-prompt-input-editor__input[contenteditable="true"]')].some(vis);
          const busy = [...document.querySelectorAll('button[aria-label="Stop generation"], .composer-button-area .codicon-debug-stop, .send-with-mode .codicon-debug-stop')].some(vis);
          const b = document.querySelector('[id^="bubble-"]');
          const m = b && /^bubble-([0-9a-f-]{36})-/.exec(b.id);
          return { hasEd, busy, chatId: m ? m[1] : 'win:' + document.title };
        })()`);
        sessions.push({
          seq: seq++,
          winId: win.id,
          winTitle: win.title,
          winKind: win.kind,
          ws: win.ws,
          chatId: info.chatId,
          name: `[窗口] ${win.title}`,
          busy: info.busy,
          mounted: info.hasEd,
          isMaster: MASTER_CHAT_ID ? info.chatId.startsWith(MASTER_CHAT_ID) : false,
        });
      }
    } finally {
      cdp.close();
    }
  }

  // If MASTER_CHAT_ID was not configured or not found, default session #1 as Master
  if (sessions.length > 0 && !sessions.some(s => s.isMaster)) {
    sessions[0].isMaster = true;
  }

  return sessions;
}

export async function resolveTarget(targetArg) {
  const sessions = await discoverAllSessions();
  if (!targetArg) return sessions.find(x => x.isMaster) || sessions[0] || null;
  const s = String(targetArg || '').replace(/^[#@]/, '').trim();
  if (!s) return sessions.find(x => x.isMaster) || sessions[0] || null;
  const bySeq = /^\d+$/.test(s) ? sessions.find(x => x.seq === Number(s)) : null;
  if (bySeq) return bySeq;
  return sessions.find(x => x.chatId.startsWith(s) || x.name.toLowerCase().includes(s.toLowerCase())) || null;
}

async function ensureMounted(cdp, target) {
  if (target.winKind !== 'agents') return;
  const mounted = await cdp.evaluate(`!!document.querySelector('[id^="bubble-${target.chatId}-"]')`);
  if (!mounted) {
    const pos = await cdp.evaluate(`(() => {
      const el = document.querySelector('li.ui-sidebar-menu-item[data-sidebar-item-key="row:${target.chatId}"] .ui-sidebar-menu-button');
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    })()`);
    if (pos) {
      await tapCss(cdp, pos.x, pos.y);
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 150));
        const ok = await cdp.evaluate(`!!document.querySelector('[id^="bubble-${target.chatId}-"]')`);
        if (ok) break;
      }
    }
  }
}

export async function inspectSession(target, mountIfNeeded = true) {
  const cdp = new Cdp(target.ws);
  await cdp.connect();
  try {
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    if (mountIfNeeded) await ensureMounted(cdp, target);

    return await cdp.evaluate(`((chatId, winKind) => {
      const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const cleanText = el => (el?.innerText || el?.textContent || '').trim();
      const ROW_SEL = '[data-flat-index], .virtualized-composer-messages-row[data-index]';
      const STOP_SEL = 'button[aria-label="Stop generation"], .stop-button, .composer-button-area .codicon-debug-stop, .send-with-mode .codicon-debug-stop';
      const SKIP = /ui-collapsible-header|md-clickable-code|ui-markdown__inline-code|output-preview|codicon-find|widget-close|model-picker|stop-button|ui-prompt-input-submit-button/;
      const ACTION = /^(run(\\s+command)?|skip|allow|accept|reject|deny|approve|keep|undo|continue|cancel|build|retry|yes|no|运行|跳过|允许|接受|拒绝|继续|取消)$/i;
      const center = el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };

      const eds = [...document.querySelectorAll('.aislash-editor-input[contenteditable="true"], .ui-prompt-input-editor__input[contenteditable="true"], .composer-bar [contenteditable="true"]')];
      let panel = null;
      if (winKind === 'agents' && chatId) {
        const b = document.querySelector('[id^="bubble-' + chatId + '-"]');
        if (b) {
          panel = b.closest('.agent-panel-conversation-shell')
            || b.closest('.agent-conversation-composer__viewport')?.parentElement
            || b.closest('.composer-messages-container');
        }
      }
      if (!panel) {
        for (const ed of eds) {
          let p = ed;
          while (p && p !== document.body) {
            if (p.querySelectorAll(ROW_SEL).length > 0) { panel = p; break; }
            p = p.parentElement;
          }
          if (panel) break;
        }
      }
      if (!panel) return null;

      const rows = [...panel.querySelectorAll(ROW_SEL)].filter(e => !e.parentElement.closest(ROW_SEL));
      const summary = el => {
        const head = el.querySelector('.ui-tool-call-card__header, .ui-collapsible-header, [class*="header"]') || el;
        return cleanText(head).replace(/\\s*\\n\\s*/g, ' · ').slice(0, 300);
      };
      const items = rows.map(el => {
        const kindEl = el.matches('[data-message-kind]') ? el : el.querySelector('[data-message-kind]');
        const rowKey = el.dataset.findRowKey || '';
        const k = kindEl?.dataset.messageKind
          || (rowKey.startsWith('human:') ? 'human' : rowKey.startsWith('assistant-markdown:') ? 'assistant' : 'other');
        const text = k === 'human'
          ? cleanText(el.querySelector('.aislash-editor-input-readonly, .composer-human-message, [data-message-kind="human"]') || el)
          : k === 'assistant'
            ? cleanText(el.querySelector('.markdown-root') || el)
            : summary(el);
        return { k, rowKey, text };
      }).filter(x => x.text && !/^\\d+[smhd] ago$|^New messages below$/i.test(x.text));

      const buttonsIn = (root, strict) => [...root.querySelectorAll('button, [role=button], .anysphere-button, .anysphere-secondary-button, .composer-run-button, .composer-skip-button')]
        .filter(b => vis(b) && !SKIP.test(b.className) && !/^stop/i.test(b.getAttribute('aria-label') || '') && !b.parentElement.closest('button, [role=button]'))
        .map(b => ({ el: b, label: (cleanText(b) || b.getAttribute('aria-label') || b.title || '').split('\\n')[0].trim().slice(0, 30) }))
        .filter(x => x.label && x.label !== 'Shell command options' && (!strict || ACTION.test(x.label)));

      const btns = [];
      for (const el of rows.slice(-5)) {
        for (const b of buttonsIn(el, true)) {
          if (!/background|后台|copy|复制|^stop\\b/i.test(b.label)) {
            btns.push({ label: b.label, context: summary(el), pos: center(b.el) });
          }
        }
      }
      const stopEl = [...panel.querySelectorAll(STOP_SEL)].filter(vis).pop();
      const stopPos = stopEl ? center(stopEl.closest('button, [role=button], .anysphere-icon-button') || stopEl) : null;
      return { busy: Boolean(stopEl), stopPos, items: items.slice(-8), buttons: btns };
    })(${JSON.stringify(target.chatId)}, ${JSON.stringify(target.winKind)})`);
  } finally {
    cdp.close();
  }
}

export async function sendToSession(target, messageText) {
  const cdp = new Cdp(target.ws);
  await cdp.connect();
  try {
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await ensureMounted(cdp, target);

    const focused = await cdp.evaluate(`((chatId, winKind) => {
      const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const eds = [...document.querySelectorAll('.aislash-editor-input[contenteditable="true"], .ui-prompt-input-editor__input[contenteditable="true"], .composer-bar [contenteditable="true"]')].filter(vis);
      let editor = null;
      if (winKind === 'agents' && chatId) {
        const b = document.querySelector('[id^="bubble-' + chatId + '-"]');
        const pane = b && (
          b.closest('.agent-panel-conversation-shell')
          || b.closest('.agent-conversation-composer__viewport')?.parentElement
          || b.closest('.composer-messages-container')?.parentElement
        );
        if (pane) editor = [...pane.querySelectorAll('.ui-prompt-input-editor__input[contenteditable="true"]')].find(vis);
      }
      if (!editor) editor = eds[0];
      if (!editor) return false;
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    })(${JSON.stringify(target.chatId)}, ${JSON.stringify(target.winKind)})`);

    if (!focused) throw new Error(`找不到「${target.name}」的输入框`);
    const lines = String(messageText).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        const ev = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8 };
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ev });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
      }
      if (lines[i]) await cdp.send('Input.insertText', { text: lines[i] });
    }
    await pressEnter(cdp);
    return true;
  } finally {
    cdp.close();
  }
}

export async function stopSession(target) {
  const detail = await inspectSession(target, true);
  if (!detail?.stopPos) return false;
  const cdp = new Cdp(target.ws);
  await cdp.connect();
  try {
    await tapCss(cdp, detail.stopPos.x, detail.stopPos.y);
    return true;
  } finally {
    cdp.close();
  }
}

// CLI entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd = 'list', arg1, ...rest] = process.argv.slice(2);
  if (cmd === 'list') {
    const list = await discoverAllSessions();
    for (const s of list) {
      console.log(`#${s.seq} [${s.busy ? 'RUNNING' : 'IDLE'}] ${s.name} (id=${s.chatId.slice(0, 8)}${s.isMaster ? ', MASTER' : ''})`);
    }
  } else if (cmd === 'read') {
    const t = await resolveTarget(arg1);
    if (!t) { console.error('Target not found'); process.exit(1); }
    const detail = await inspectSession(t, true);
    console.log(JSON.stringify({ target: t, detail }, null, 2));
  } else if (cmd === 'send') {
    const t = await resolveTarget(arg1);
    if (!t) { console.error('Target not found'); process.exit(1); }
    await sendToSession(t, rest.join(' '));
    console.log(`Sent to #${t.seq} (${t.name})`);
  } else if (cmd === 'click') {
    const t = await resolveTarget(arg1);
    if (!t) { console.error('Target not found'); process.exit(1); }
    const idx = (Number(rest[0]) || 1) - 1;
    const detail = await inspectSession(t, true);
    const btn = detail?.buttons?.[idx];
    if (!btn) { console.error('Button not found'); process.exit(1); }
    const cdp = new Cdp(t.ws);
    await cdp.connect();
    await tapCss(cdp, btn.pos.x, btn.pos.y);
    cdp.close();
    console.log(`Clicked [${btn.label}] on #${t.seq} (${t.name})`);
  } else if (cmd === 'stop') {
    const t = await resolveTarget(arg1);
    if (!t) { console.error('Target not found'); process.exit(1); }
    const ok = await stopSession(t);
    if (!ok) { console.error(`Session #${t.seq} (${t.name}) is not currently running`); process.exit(1); }
    console.log(`Stopped #${t.seq} (${t.name})`);
  } else {
    console.log('Usage: node cursor-ctl.mjs <list|read|send|click|stop> [target] [args...]');
    process.exit(1);
  }
}
