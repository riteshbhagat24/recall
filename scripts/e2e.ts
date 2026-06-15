/**
 * End-to-end smoke test against a running API + worker (mock engine).
 * Exercises the spine and the two non-negotiables (financial-lock, workspace
 * isolation). Run: npx tsx scripts/e2e.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const BASE = process.env.BASE ?? 'http://localhost:3000';

// seeded users
const SUPER_ADMIN = '1';
const DESIGN_VIDEO = '7'; // must never see financial segments
const PERFORMANCE = '6'; // scoped to Acme (client 1) only

function h(userId: string): Record<string, string> {
  return { 'x-user-id': userId, 'content-type': 'application/json' };
}
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (path: string, user: string) => json(await fetch(`${BASE}${path}`, { headers: h(user) }));

async function main() {
  // 1. Upload (multipart) as super admin, with consent so it processes.
  const form = new FormData();
  form.append('client_id', '1');
  form.append('project_id', '1');
  form.append('consent_state', 'explicit');
  form.append('title', 'Acme Q3 sync');
  form.append('file', new Blob(['fake audio bytes for sample-01'], { type: 'audio/mpeg' }), 'sample-01.mp3');

  const upJson = await json(
    await fetch(`${BASE}/recordings/upload`, { method: 'POST', headers: { 'x-user-id': SUPER_ADMIN }, body: form }),
  );
  check('upload accepted + queued', upJson.ok && upJson.queued === 'transcription', JSON.stringify(upJson));
  const recordingId = upJson.recording_id;

  // 2. Poll status until ready.
  let status = '';
  let conversationId: number | null = null;
  for (let i = 0; i < 30; i++) {
    const sj = await get(`/recordings/${recordingId}/status`, SUPER_ADMIN);
    status = sj.status;
    conversationId = sj.conversation_id;
    if (status === 'ready' || status.endsWith('_failed')) break;
    await sleep(1000);
  }
  check('pipeline reached ready', status === 'ready', `status=${status}`);
  if (status !== 'ready' || !conversationId) {
    console.log('aborting downstream checks — pipeline did not complete');
    process.exit(1);
  }

  // 3. Conversation has structured outputs.
  const conv = await get(`/conversations/${conversationId}`, SUPER_ADMIN);
  check('conversation has summary', Boolean(conv.conversation?.summary));
  check('conversation has transcript turns', (conv.conversation?.transcript?.length ?? 0) > 0);
  const adminTurns = conv.conversation.transcript.length;

  // 4. FINANCIAL-LOCK: Design&Video sees fewer turns (financial segments hidden).
  const convDV = await get(`/conversations/${conversationId}`, DESIGN_VIDEO);
  const dvTurns = convDV.conversation.transcript.length;
  check('design/video sees fewer turns (financial hidden)', dvTurns < adminTurns, `admin=${adminTurns} dv=${dvTurns}`);
  check('design/video transcript has NO GST/invoice text', !convDV.conversation.transcript.some((t: any) => /gst|invoice/i.test(t.text)));
  check('design/video decisions have NO GST/invoice text', !convDV.conversation.decisions.some((d: any) => /gst|invoice/i.test(d.text)));

  // 5. SEARCH financial term: admin finds it, design/video does not (API-level).
  const adminSearch = await get(`/search?q=GST%20invoice`, SUPER_ADMIN);
  check('admin search finds GST passage', adminSearch.results.length > 0, `${adminSearch.results.length} hits`);
  const dvSearch = await get(`/search?q=GST%20invoice`, DESIGN_VIDEO);
  check('design/video search leaks NO financial passage', !dvSearch.results.some((r: any) => /gst|invoice/i.test(r.snippet)), `${dvSearch.results.length} hits`);

  // 6. Hybrid search returns ranked passages with timestamps.
  const budgetSearch = await get(`/search?q=budget%20reallocate`, SUPER_ADMIN);
  check('hybrid search returns ranked results', budgetSearch.results.length > 0 && Boolean(budgetSearch.results[0].timestamp));

  // 7. PERFORMANCE scope: client 1 visible, client 2 (Globex) forbidden.
  const perfOk = await fetch(`${BASE}/clients/1/summary`, { headers: h(PERFORMANCE) });
  const perfDenied = await fetch(`${BASE}/clients/2/summary`, { headers: h(PERFORMANCE) });
  check('performance can read assigned client (Acme)', perfOk.ok);
  check('performance is denied unassigned client (Globex)', perfDenied.status === 403);

  // 8. L2 living summary regenerated (async — poll a few times).
  let summary: any = {};
  for (let i = 0; i < 10; i++) {
    summary = await get(`/clients/1/summary`, SUPER_ADMIN);
    if (summary.version && summary.version >= 1) break;
    await sleep(1000);
  }
  check('L2 client summary exists + versioned', Boolean(summary.summary) && (summary.version ?? 0) >= 1, `v${summary.version}`);
  const sumDV = await get(`/clients/1/summary`, DESIGN_VIDEO);
  check('design/video L2 summary excludes GST/invoice', !/gst|invoice/i.test(sumDV.summary ?? ''));

  // 9. Context-pack export (permission-filtered, markdown).
  const pack = await get(`/projects/1/context-pack`, SUPER_ADMIN);
  check('context pack is markdown bundle', pack.format === 'markdown' && pack.content.includes('# Context Pack'));
  const packDV = await get(`/projects/1/context-pack`, DESIGN_VIDEO);
  check('design/video context pack excludes GST/invoice', !/gst|invoice/i.test(packDV.content));

  // 10. WORKSPACE isolation.
  const wsA = await get(`/workspace`, SUPER_ADMIN);
  const itemA = await json(
    await fetch(`${BASE}/workspace/items`, {
      method: 'POST', headers: h(SUPER_ADMIN),
      body: JSON.stringify({ type: 'note', content: 'private admin note', refs: { conversationId } }),
    }),
  );
  check('workspace item created (private)', Boolean(itemA.item?.id));
  const crossEdit = await fetch(`${BASE}/workspace/items/${itemA.item.id}`, {
    method: 'PUT', headers: h(DESIGN_VIDEO), body: JSON.stringify({ content: 'hijack' }),
  });
  check('workspace item NOT editable by another user', crossEdit.status === 403);
  const wsDV = await get(`/workspace`, DESIGN_VIDEO);
  check('admin workspace item invisible to other user', !(wsDV.items ?? []).some((i: any) => i.id === itemA.item.id));
  check('separate workspace per user (no shared-write path)', wsA.workspace.id !== wsDV.workspace.id);

  // 11. Engine swap via admin config (REQ-4.10).
  const swap = await fetch(`${BASE}/admin/engine-config`, { method: 'POST', headers: h(SUPER_ADMIN), body: JSON.stringify({ engine: 'openai' }) });
  const swapJson = await json(swap);
  check('engine swap via config works', swap.ok && swapJson.transcription_engine === 'openai');
  await fetch(`${BASE}/admin/engine-config`, { method: 'POST', headers: h(SUPER_ADMIN), body: JSON.stringify({ engine: 'mock' }) });

  console.log(`\n${failures === 0 ? 'ALL E2E CHECKS PASSED ✅' : `${failures} CHECK(S) FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
