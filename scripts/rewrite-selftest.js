// 查询改写自检（运行 dist/main/api-client）
// 跑法：node scripts/rewrite-selftest.js
//
// 测试两类：
// (A) 纯进程内：跳过判定（无需 LLM 凭据）
//     - 长度 ≥ 6 且无指代词 → 跳过，返回原 query
//     - 长度 < 6 或含指代词 → 走 LLM
// (B) 端到端：真调 LLM 验证改写效果（需要环境变量）
//     - REWRITER_API_KEY / REWRITER_BASE_URL / REWRITER_MODEL
//     - 不设则跳过
const { rewriteQuery, clearRewriteCache, buildRewriteHistory } = require('../dist/main/api-client');

// 与 src/main/api-client.ts 的 ANAPHORIC_RE 保持一致
// 故意不列"上/的/个/们/其"——它们在自包含句里出现频率太高，假阳性会很多
const ANAPHORIC = '那这它他她';
const ANAPHORIC_PHRASES = ['刚才', '那个'];

// ====== A) 进程内：跳过判定 ======
console.log('\n===== A) 跳过判定（无 LLM 调用）=====');

const skipCases = [
  // [query, expected是否跳过, 原因]
  ['5G 和 4G 的区别是什么', true, '长度 11 + 无指代词'],
  ['北京国际科技创新中心建设条例', true, '长度 13 + 无指代词'],
  ['qwen-turbo 模型的上下文窗口多大？', true, '长度 17 + 无指代词（"上"、"的" 是常见字）'],
  ['RAG 和 fine-tuning 的区别', true, '长度 12 + 无指代词'],
  ['是哪一章？', false, '长度 5 < 6'],
  ['它', false, '长度 1 < 6'],
  ['那条款呢？', false, '长度 5 < 6'],
  ['它是什么？', false, '长度 5 < 6'],
  ['那关于第二条呢？', false, '长度 8 + 含"那"'],
  ['刚才那个文件在哪？', false, '长度 9 + 含"刚才"+"那个"'],
  ['他和她的区别是？', false, '长度 8 + 含"他"+"她"'],
];

let aPass = 0, aFail = 0;
for (const [q, shouldSkip, reason] of skipCases) {
  // 与 src/main/api-client.ts 的 ANAPHORIC_RE 同步：
  // 长度 < 6 或含 [它他她这那] 或含短语 [刚才/那个]
  const isAnaphoric =
    q.length < 6 ||
    [...q].some((c) => ANAPHORIC.includes(c)) ||
    ANAPHORIC_PHRASES.some((p) => q.includes(p));
  const willSkip = !isAnaphoric;
  const ok = willSkip === shouldSkip;
  console.log(
    `  ${ok ? '✓' : '✗'} "${q}" (${reason}) → ${willSkip ? '跳过改写' : '走 LLM 改写'}`,
  );
  ok ? aPass++ : aFail++;
}
console.log(`\n跳过判定：${aPass} 通过 / ${aFail} 失败`);

// ====== C) buildRewriteHistory：构造历史序列的逻辑（无需 LLM）=====
console.log('\n===== C) buildRewriteHistory 构造历史 =====');

// 工具：造 N 条 user/assistant 交替 + 一条可选"当前 user msg"
function mkMessages(n, currentUserContent) {
  const msgs = [];
  for (let i = 0; i < n; i++) {
    msgs.push({
      id: `msg_${i}`,
      sessionId: 'selftest',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i % 2 === 0 ? '用户' : '助手'}问/答 #${i}: ${'Lorem ipsum dolor sit amet. '.repeat(5).trim()}`,
      createdAt: i,
    });
  }
  if (currentUserContent) {
    msgs.push({
      id: 'msg_current',
      sessionId: 'selftest',
      role: 'user',
      content: currentUserContent,
      createdAt: n,
    });
  }
  return msgs;
}

const cCases = [
  {
    name: '短 session（3 条）—— 全部保留',
    msgs: mkMessages(3),
    currentId: 'msg_current',
    expect: (out) => out.length === 3, // 3 条历史（无 current 占位）
  },
  {
    name: '首条 user 必带：20 条 session 中首条出现',
    msgs: mkMessages(20),
    currentId: 'msg_current',
    expect: (out) => {
      const first = out[0];
      // 第一条 user msg 应该出现（按 buildRewriteHistory 的"必带首条 user"）
      return out.some((m) => m.content.startsWith('用户问/答 #0:'));
    },
  },
  {
    name: 'assistant 截断：长 assistant 内容 > 500 字被截到 300 字 + …',
    msgs: (() => {
      const m = mkMessages(2);
      m[1] = {
        ...m[1],
        content: '助手答#1: ' + 'a'.repeat(800),  // 800 字
      };
      return m;
    })(),
    currentId: 'msg_current',
    expect: (out) => {
      const assistant = out.find((m) => m.role === 'assistant');
      return assistant.content.endsWith('…') && assistant.content.length < 500;
    },
  },
  {
    name: 'token 预算：30 条 session 总字符数 ≤ 2500',
    msgs: mkMessages(30),
    currentId: 'msg_current',
    expect: (out) => {
      const totalChars = out.reduce((s, m) => s + (m.content?.length || 0), 0);
      return totalChars <= 2600; // 留点余量
    },
  },
  {
    name: '排除当前 user msg：currentId 对应的内容不出现',
    msgs: mkMessages(3, 'CURRENT_QUERY_HERE'),
    currentId: 'msg_current',
    expect: (out) => !out.some((m) => m.content === 'CURRENT_QUERY_HERE'),
  },
];

let cPass = 0, cFail = 0;
for (const tc of cCases) {
  const out = buildRewriteHistory(tc.msgs, tc.currentId);
  const ok = tc.expect(out);
  console.log(`  ${ok ? '✓' : '✗'} ${tc.name} (输出 ${out.length} 条)`);
  if (!ok) {
    console.log('    内容:');
    out.forEach((m, i) => console.log(`      [${i}] ${m.role}: ${(m.content ?? '').slice(0, 60)}…`));
  }
  ok ? cPass++ : cFail++;
}
console.log(`\nbuildRewriteHistory：${cPass} 通过 / ${cFail} 失败`);

// ====== B) 端到端：真 LLM ======
const apiKey = process.env.REWRITER_API_KEY;
const baseUrl = process.env.REWRITER_BASE_URL || 'https://api.openai.com/v1';
const model = process.env.REWRITER_MODEL || 'gpt-4o-mini';

if (!apiKey) {
  console.log('\n===== B) 端到端 LLM 改写：跳过（未设 REWRITER_API_KEY）=====');
  console.log('   启用方法（在 bash 里）：');
  console.log('     export REWRITER_API_KEY=sk-...');
  console.log('     export REWRITER_BASE_URL=https://api.openai.com/v1   # 可选');
  console.log('     export REWRITER_MODEL=gpt-4o-mini                    # 可选');
  console.log('     node scripts/rewrite-selftest.js');
  process.exit(aFail === 0 ? 0 : 1);
}

const provider = {
  id: 'selftest',
  label: 'Self-Test',
  baseUrl,
  chatModel: model,
  embeddingModel: 'unused',
  hasApiKey: true,
};

const e2eCases = [
  {
    name: '指代消解：哪一章？',
    history: [
      { role: 'user', content: '为了落实首都城市战略定位，推进北京国际科技创新中心建设……制定本条例；是哪个条例的内容？' },
      { role: 'assistant', content: '这是《北京国际科技创新中心建设条例》第一条的内容。' },
    ],
    query: '哪一章？',
    expect: (out) => out.includes('条例') || out.includes('章'),
  },
  {
    name: '实体省略：那第二节呢？',
    history: [
      { role: 'user', content: '《网络安全法》第一条说了什么？' },
      { role: 'assistant', content: '第一条讲了立法目的……' },
    ],
    query: '那第二节呢？',
    expect: (out) => out.includes('网络安全法') || out.includes('第二条'),
  },
  {
    name: '指代：它是什么意思？',
    history: [
      { role: 'user', content: '什么是 RAG？' },
      { role: 'assistant', content: 'RAG 是检索增强生成（Retrieval-Augmented Generation）。' },
    ],
    query: '它和普通的 LLM 有什么区别？',
    expect: (out) => out.includes('RAG') || out.includes('检索增强'),
  },
  {
    name: '自包含：应原样返回',
    history: [
      { role: 'user', content: '前面聊了什么？' },
      { role: 'assistant', content: '我们聊了 RAG 的基本概念。' },
    ],
    query: 'qwen-turbo 模型的上下文窗口多大？',
    expect: (out) => out === 'qwen-turbo 模型的上下文窗口多大？',
  },
];

(async () => {
  console.log('\n===== B) 端到端 LLM 改写 =====');
  console.log(`   provider: ${baseUrl}  model: ${model}\n`);

  // v1.2.3 包装 history 为 Message[]（带 id）
  const wrapHistory = (hist) => hist.map((m, i) => ({
    id: `msg_${i}`,
    sessionId: 'selftest',
    role: m.role,
    content: m.content,
    createdAt: i,
  }));

  let bPass = 0, bFail = 0;
  for (const tc of e2eCases) {
    clearRewriteCache();
    const t0 = Date.now();
    const messages = wrapHistory(tc.history);
    // currentMsgId 用一个不存在的 id（history 里没有"当前 user msg"）
    const out = await rewriteQuery(provider, apiKey, undefined, messages, 'msg_current', tc.query, 'selftest');
    const ms = Date.now() - t0;
    const ok = tc.expect(out);
    console.log(`  ${ok ? '✓' : '✗'} ${tc.name} (${ms}ms)`);
    console.log(`    query:    "${tc.query}"`);
    console.log(`    rewritten: "${out}"`);
    ok ? bPass++ : bFail++;
  }
  console.log(`\nLLM 改写：${bPass} 通过 / ${bFail} 失败`);

  // 缓存命中验证：第二次调同 (lastUser, currentQuery) 应该走 cache
  clearRewriteCache();
  const messages = wrapHistory(e2eCases[0].history);
  const t0 = Date.now();
  await rewriteQuery(provider, apiKey, undefined, messages, 'msg_current', e2eCases[0].query, 'selftest-cache');
  const first = Date.now() - t0;
  const t1 = Date.now();
  await rewriteQuery(provider, apiKey, undefined, messages, 'msg_current', e2eCases[0].query, 'selftest-cache');
  const second = Date.now() - t1;
  console.log(`\n缓存：首次 ${first}ms, 二次 ${second}ms (二次应当 < 5ms)`);
  const cacheOk = second < 5;
  cacheOk ? bPass++ : bFail++;

  process.exit(aFail + bFail === 0 ? 0 : 1);
})();
