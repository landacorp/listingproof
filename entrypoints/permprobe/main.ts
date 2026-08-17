/**
 * The `tabs`-permission probe: the page half (mode-gated entrypoint; built
 * only under `wxt --mode perm-probe`, so nothing here ships).
 *
 * All the measuring happens in the service worker — that is where the guards
 * under test live, and Chrome's rule is about the calling extension's
 * permissions, not the API. This page only asks for a run, renders the answer
 * so a human watching the browser can see it, and POSTs the raw report to the
 * capture server (`scripts/capture-server.mjs`) so the answer is readable from
 * the repo without touching the browser at all.
 */

import { browser } from 'wxt/browser';
import type { PermProbeReport } from '../../background/permprobe';

const CAPTURE_SERVER = 'http://127.0.0.1:8787/';

const runButton = document.getElementById('run') as HTMLButtonElement;
const verdictEl = document.getElementById('verdict') as HTMLElement;
const log = document.getElementById('log') as HTMLElement;

function note(text: string): void {
  log.textContent += `${text}\n`;
}

function cell(row: HTMLTableRowElement, text: string, className?: string): void {
  const td = document.createElement('td');
  td.textContent = text;
  if (className !== undefined) td.className = className;
  row.appendChild(td);
}

function renderReport(report: PermProbeReport): void {
  verdictEl.replaceChildren();
  const summary = document.createElement('p');
  summary.textContent = report.builtWithTabsPermission
    ? `CONTROL RUN — this build DOES hold "tabs". permissions: ${report.manifestPermissions.join(', ')}`
    : `permissions: ${report.manifestPermissions.join(', ')} — no "tabs"`;
  summary.className = report.builtWithTabsPermission ? 'blank' : 'visible';
  verdictEl.appendChild(summary);

  const stepsBody = document.getElementById('steps') as HTMLElement;
  (document.getElementById('steps-table') as HTMLTableElement).hidden = false;
  stepsBody.replaceChildren();
  for (const step of report.steps) {
    const row = document.createElement('tr');
    cell(row, step.step);
    const facts = step.facts;
    if (facts === undefined) {
      cell(row, '—');
      cell(row, '');
      cell(row, '');
    } else {
      cell(row, facts.urlVisible ? 'yes' : 'BLANK', facts.urlVisible ? 'visible' : 'blank');
      cell(row, facts.url ?? '', 'url');
      cell(
        row,
        `tab ${facts.tabId ?? '—'} / win ${facts.windowId ?? '—'}${facts.error === undefined ? '' : ` / ${facts.error}`}`,
      );
    }
    cell(row, step.note ?? step.asks);
    stepsBody.appendChild(row);
  }

  const updatesBody = document.getElementById('updates') as HTMLElement;
  (document.getElementById('updates-table') as HTMLTableElement).hidden = false;
  updatesBody.replaceChildren();
  for (const event of report.updateEvents) {
    const row = document.createElement('tr');
    cell(row, event.duringStep);
    cell(row, String(event.tabId));
    cell(row, event.keys.join(', '));
    cell(row, event.url ?? '—', event.url === undefined ? 'blank' : 'visible');
    updatesBody.appendChild(row);
  }

  const portsBody = document.getElementById('ports') as HTMLElement;
  (document.getElementById('ports-table') as HTMLTableElement).hidden = false;
  portsBody.replaceChildren();
  for (const event of report.portEvents) {
    const row = document.createElement('tr');
    cell(row, event.duringStep);
    cell(row, event.event, event.event === 'connect' ? 'visible' : 'blank');
    cell(row, String(event.tabId ?? '—'));
    cell(row, event.senderUrl ?? '—', 'url');
    portsBody.appendChild(row);
  }
}

async function upload(name: string, body: string): Promise<void> {
  try {
    await fetch(`${CAPTURE_SERVER}?name=${encodeURIComponent(name)}`, { method: 'POST', body });
    note(`uploaded ${name}`);
  } catch {
    note(`capture server not reachable — ${name} not saved`);
  }
}

let running = false;
let runCount = 0;

async function run(): Promise<void> {
  if (running) return;
  running = true;
  runButton.disabled = true;
  runCount += 1;
  try {
    log.textContent = '';
    note(`probe run ${runCount} started — this opens three tabs and takes ~30s`);
    const report = (await browser.runtime.sendMessage({ type: 'PERM_PROBE_RUN' })) as
      | PermProbeReport
      | undefined;
    if (report === undefined) {
      note('worker returned nothing — is this build in --mode perm-probe?');
      return;
    }
    renderReport(report);
    // The capture server only accepts *.html names; the report is JSON anyway.
    const withTabs = report.builtWithTabsPermission ? 'with-tabs' : 'no-tabs';
    const suffix = runCount === 1 ? '' : `-r${runCount}`;
    await upload(`permprobe-${withTabs}${suffix}.json.html`, JSON.stringify(report, null, 2));
    note(`probe run ${runCount} finished`);
  } finally {
    running = false;
    runButton.disabled = false;
  }
}

runButton.addEventListener('click', () => void run());
if (new URLSearchParams(location.search).get('auto') === '1') void run();
