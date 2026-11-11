import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runLookup } from '../src/mcp/jinhua-tools.mjs';
import { createStdioClient } from '../src/mcp/stdio.mjs';

test('批量事实按题返回，先解析 appid 和赛事再查询下游', async () => {
  const calls = [];
  const fixtures = {
    steam_find_game: [{ appid: 413150, name: '星露谷物语' }],
    steam_game_price: { current: '¥48', currency: 'CNY' },
    lol_resolve_event: { events: [{ event_id: 'esports-1', teams: ['T1', 'HLE'], start_time: '2026-11-13 18:00' }] },
    lol_event_vods: { vods: [{ url: 'https://www.youtube.com/watch?v=example' }] },
  };
  const result = await runLookup({ anchor: 'incoming', questions: [
    { id: '1', text: '星露谷物语多少钱', action: 'steam_game', game: '星露谷物语', fields: ['price'] },
    { id: '2', text: 'T1 下场打谁', action: 'lol_next', team: 'T1' },
    { id: '3', text: '录像呢', action: 'lol_vod', depends_on: '2' },
    { id: '4', text: 'CS2世界第一', action: 'hltv_ranking' },
  ] }, {
    names: Object.keys(fixtures),
    invoke: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true, result: fixtures[tool] };
    },
  });
  assert.equal(result.anchor, 'incoming');
  assert.deepEqual(result.questions.map(({ status }) => status), ['ok', 'ok', 'ok', 'unavailable']);
  assert.equal(calls.find(({ tool }) => tool === 'steam_game_price').args.appid, 413150);
  assert.equal(calls.find(({ tool }) => tool === 'lol_event_vods').args.event_id, 'esports-1');
  assert.match(result.questions[0].answer, /¥48/);
  assert.match(result.questions[1].answer, /T1 vs HLE/);
  assert.match(result.questions[2].answer, /youtube/);
  assert.equal(result.questions[3].sources.length, 0);
});

test('预算耗尽时保留其他题，实体有歧义时给候选', async () => {
  const result = await runLookup({ questions: [
    { id: '1', text: 'X 多少钱', action: 'steam_game', game: 'X' },
    { id: '2', text: '明天LPL赛程', action: 'lol_schedule', date: 'tomorrow', league: 'LPL' },
    { id: '3', text: '韩服中单强势英雄', action: 'opgg_lane', position: 'mid' },
  ] }, {
    names: ['steam_find_game', 'lol_matches_by_date', 'opgg_lane_meta'],
    invoke: async (tool) => {
      if (tool === 'steam_find_game') return { ok: true, result: [{ name: 'X demo' }, { name: 'X 2' }] };
      if (tool === 'lol_matches_by_date') return { ok: true, result: { matches: [] } };
      return { ok: false, code: 'timeout' };
    },
  });
  assert.deepEqual(result.questions.map(({ status }) => status), ['clarify', 'ok', 'timeout']);
  assert.equal(result.questions[0].candidates.length, 2);
  assert.match(result.questions[1].answer, /没查到比赛/);
});

test('真实 Node stdio 服务可握手、发现和执行白名单工具', async (t) => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jinhua-mcp-test-'));
  const client = createStdioClient({
    name: 'jinhua-fixture', command: process.execPath, args: [path.join(root, 'jinhua-mcp.mjs')],
    env: { JINHUA_TOOL_CWD: root, JINHUA_MCP_CONFIG: path.join(tmp, 'empty.json'), SEARCH_ENABLED: '0' },
  });
  t.after(() => {
    client.close();
    fs.rmdirSync(tmp);
  });
  assert.equal((await client.initialize()).serverInfo.name, 'jinhua-readonly');
  assert.deepEqual((await client.listTools()).map((tool) => tool.name), ['jinhua_lookup']);
  const result = await client.callTool('jinhua_lookup', { questions: [{ id: 'q1', text: '世界第一', action: 'hltv_ranking' }] });
  assert.equal(result.raw.structuredContent.questions[0].status, 'unavailable');
  await assert.rejects(client.callTool('send_message', {}), /Unknown tool/);
  await assert.rejects(client.callTool('jinhua_lookup', { questions: [] }), /查询参数有误/);
});
