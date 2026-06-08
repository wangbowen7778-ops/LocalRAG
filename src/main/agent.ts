/**
 * Agentic RAG 主循环
 *
 * 设计要点：
 * - 用 OpenAI 协议 tools（function_calling）—— LLM 调 search_kb / skip_search
 * - plan + critique 不分开：单轮 chatCompletion → 有 tool_calls 就执行再循环，finish_reason='stop' 才出 final
 * - 默认用 chatCompletion（非流式）跑中间步；final 答案用 chatStream 流式输出
 * - 防死循环：相同 subQuery+kbIds 命中短路；maxIterations 强制终止
 * - queryVec 复用：每个 unique sub_query 只 embed 一次
 * - 降级：Provider 不支持 tools（400/422）→ runSimpleChat 重试
 */
import { IPC, AGENT_TOOLS } from '../shared/constants';
import type {
  AgentStep,
  AgentTrace,
  Citation,
  KnowledgeBase,
  Message,
  ProviderConfig,
  ChatMessage,
} from '../shared/types';
import { chatStream, chatCompletion, embedText, type ChatDelta } from './api-client';
import { hybridSearchMulti } from './vector-store';
import { resolveEmbeddingProvider } from './document-processor';
import { SecureStore } from './secure-store';
import { listMessages, addMessage, touchSession, searchSessionSummaries } from './storage';

type Emit = (channel: string, data: unknown) => void;

export interface AgentInput {
  sessionId: string;
  userMsgId: string;
  userContent: string;
  /** v1.2.2 查询改写后的 userContent（IPCHandler 算出后传入）；用于 LLM 消息与提示。
   *  LLM 看到的是"自包含 query"，检索时也用它。userContent 仍保留作 fallback。 */
  effectiveUserContent?: string;
  /** UI 传入的候选 KB；selectKBs 可缩减（kbs>1 时才走） */
  kbIds: string[];
  provider: ProviderConfig;
  apiKey: string;
  model: string;
  temperature: number;
  /** 每次子问题检索的 topK（agentTopKPerQuery） */
  topK: number;
  /** Agent 循环最大次数 */
  maxIterations: number;
  /** 相似度阈值（citationScoreThreshold），0 关闭过滤 */
  scoreThreshold: number;
  enableBm25: boolean;
  /** 是否已经走过了 LLM 自选 KB（避免重复算） */
  didKBSelection: boolean;
}

/**
 * Agent 主入口。
 * 抛出任何错误会冒泡到 ipc-handlers，ipc-handlers 可以选择 catch 后回退到 simple 模式。
 */
export async function runAgent(
  emit: Emit,
  input: AgentInput,
): Promise<{ assistantMsgId: string; finalText: string; trace: AgentTrace }> {
  const t0 = Date.now();
  const sess = input.sessionId;
  const log = (...args: unknown[]) => console.log('[agent]', `session=${sess}`, ...args);

  // 1) 构造初始 messages：system + 近 8 条历史 + 当前 user
  const sysPrompt = AGENT_SYSTEM_PROMPT;
  const history = listMessages(sess)
    .filter((m) => m.id !== input.userMsgId && m.role !== 'tool')
    .slice(-8)
    .map((m) => toChatMessage(m));
  const userContent = input.effectiveUserContent ?? input.userContent;
  let messages: ChatMessage[] = [
    { role: 'system', content: sysPrompt },
    ...history,
    { role: 'user', content: userContent },
  ];

  // 2) 准备 embedding provider（Agent 模式下会按需调 embedText）
  const embedProvider = await resolveEmbeddingProvider();
  const embedKey = await SecureStore.getApiKey(embedProvider.id);
  if (!embedKey) {
    throw new Error('embedding Provider 缺少 API Key');
  }

  // 3) 循环
  const steps: AgentStep[] = [];
  const allCitations: Citation[] = [];
  const subQueryCache = new Set<string>(); // "subQuery|kbIds.join(',')" 去重
  const queryVecCache = new Map<string, number[]>(); // subQuery → vec
  let finalText = '';
  let iteration = 0;

  while (iteration < input.maxIterations) {
    iteration++;
    const isFirst = iteration === 1;
    emit(IPC.EVT_CHAT_AGENT_PHASE, {
      sessionId: sess,
      phase: isFirst ? 'planning' : 'critiquing',
      iteration,
    });
    log(`iter=${iteration} phase=${isFirst ? 'planning' : 'critiquing'}`);

    const tStep0 = Date.now();
    const result = await chatCompletion(
      input.provider,
      input.apiKey,
      input.model,
      messages,
      input.temperature,
      { tools: AGENT_TOOLS, toolChoice: 'auto' },
    );
    log(
      `iter=${iteration} finish_reason=${result.finishReason} ` +
        `content_len=${result.content.length} tool_calls=${result.toolCalls.length}`,
    );

    // 终止条件 1：模型给最终答案（finish_reason=stop 且有 content 或没 tool_calls）
    if (result.toolCalls.length === 0) {
      if (result.content) {
        finalText = result.content;
        steps.push({
          kind: 'critique',
          thought: result.content,
          latencyMs: Date.now() - tStep0,
        });
        emit(IPC.EVT_CHAT_AGENT_STEP, { sessionId: sess, step: steps[steps.length - 1], iteration });
        break;
      }
      // 都没内容也都没 tool_calls —— break 走兜底
      break;
    }

    // 终止条件 2：把 assistant 消息（含 tool_calls）回填到 messages
    messages.push({
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls,
    });

    // 终止条件 3：执行每个 tool_call
    for (const tc of result.toolCalls) {
      const args = safeJsonParse(tc.function.arguments);
      const stepBase: AgentStep = {
        kind: 'search',
        thought: result.content || undefined,
        toolName: tc.function.name,
        toolArgs: args ?? undefined,
      };

      if (tc.function.name === 'search_kb') {
        const sub = String(args?.sub_query ?? userContent).trim();
        // 限定检索 KB：参数 kb_ids 非空且与允许集相交 → 用它；否则用全部 kbIds
        const requestedKbIds = Array.isArray(args?.kb_ids) ? (args!.kb_ids as string[]) : [];
        const validRequested = requestedKbIds.filter((id) => input.kbIds.includes(id));
        const targets = validRequested.length > 0 ? validRequested : input.kbIds;

        // 重复 subQuery+kbIds 短路
        const cacheKey = sub + '|' + targets.slice().sort().join(',');
        if (subQueryCache.has(cacheKey)) {
          log(`sub_query repeated: "${sub}" (kbIds=${targets.join(',')}) → 短路`);
          steps.push({
            ...stepBase,
            kind: 'search',
            subQueries: [sub],
            kbIds: targets,
            hitCount: 0,
            latencyMs: 0,
          });
          emit(IPC.EVT_CHAT_AGENT_STEP, { sessionId: sess, step: steps[steps.length - 1], iteration });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: 'search_kb',
            content: '（此子问题已检索过，未发现新内容）',
          });
          continue;
        }
        subQueryCache.add(cacheKey);

        emit(IPC.EVT_CHAT_AGENT_PHASE, {
          sessionId: sess,
          phase: 'searching',
          iteration,
          subQuery: sub,
        });
        const tSearch0 = Date.now();
        let qvec = queryVecCache.get(sub);
        if (!qvec) {
          qvec = await embedText(embedProvider, embedKey, sub);
          queryVecCache.set(sub, qvec);
        }
        const rawHits = await hybridSearchMulti(targets, sub, qvec, input.topK, {
          enableBm25: input.enableBm25,
        });
        const filtered =
          input.scoreThreshold > 0 ? rawHits.filter((h) => h.score >= input.scoreThreshold) : rawHits;
        const searchLatency = Date.now() - tSearch0;
        log(
          `search sub="${sub}" kbIds=[${targets.join(',')}] hits=${rawHits.length} ` +
            `after_threshold=${filtered.length} (${searchLatency}ms)`,
        );

        // 累积去重
        for (const h of filtered) {
          const c: Citation = {
            docId: h.docId,
            filename: h.filename,
            chunk: h.text.slice(0, 200),
            score: h.score,
          };
          if (!allCitations.some((x) => x.docId === c.docId && x.chunk === c.chunk)) {
            allCitations.push(c);
          }
        }

        steps.push({
          ...stepBase,
          subQueries: [sub],
          kbIds: targets,
          hitCount: filtered.length,
          latencyMs: searchLatency,
        });
        emit(IPC.EVT_CHAT_AGENT_STEP, { sessionId: sess, step: steps[steps.length - 1], iteration });

        // 构造 tool 响应
        const toolContent =
          filtered.length === 0
            ? '（未检索到与该子问题相关的内容）'
            : filtered
                .map(
                  (h, i) =>
                    `[#${i + 1} ${h.filename} | score=${h.score.toFixed(2)}]\n${h.text}`,
                )
                .join('\n\n');
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: 'search_kb',
          content: toolContent,
        });
      } else if (tc.function.name === 'skip_search') {
        const reason = String(args?.reason ?? '').trim();
        steps.push({
          ...stepBase,
          kind: 'skip',
          thought: reason || undefined,
        });
        emit(IPC.EVT_CHAT_AGENT_STEP, { sessionId: sess, step: steps[steps.length - 1], iteration });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: 'skip_search',
          content: 'NO_RESULTS',
        });
      } else {
        // 未知 tool：回个错误让 LLM 知道
        log(`unknown tool: ${tc.function.name}`);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: `（错误：未知工具 ${tc.function.name}）`,
        });
      }
    }
    // 继续下一轮
  }

  // 4) 兜底：循环结束还没拿到 finalText（maxIter 用完 / 模型罢工）
  if (!finalText) {
    log(`fallback: no final after iter=${iteration}, forcing final via plain chatCompletion`);
    emit(IPC.EVT_CHAT_AGENT_PHASE, { sessionId: sess, phase: 'finalizing', iteration });
    const contextText =
      allCitations.length > 0
        ? allCitations.map((c, i) => `[#${i + 1} ${c.filename}]\n${c.chunk}`).join('\n\n')
        : '（未检索到相关文档）';
    // v1.2.3 历史对话摘要召回
    const pastSummaries = searchSessionSummaries(userContent, 2);
    const summaryBlock =
      pastSummaries.length > 0
        ? '【历史对话摘要】\n' +
          pastSummaries
            .map(
              (s, i) =>
                `[#H${i + 1} ${new Date(s.createdAt).toLocaleString('zh-CN')}] ${s.summary}`,
            )
            .join('\n\n') +
          '\n\n'
        : '';
    const finalUserPrompt =
      summaryBlock +
      `【已收集的参考资料】\n${contextText}\n\n【用户问题】\n${userContent}\n\n` +
      `请基于以上资料直接给出最终回答（不要再调用工具）。`;
    const fallback = await chatCompletion(
      input.provider,
      input.apiKey,
      input.model,
      [...messages, { role: 'user', content: finalUserPrompt }],
      input.temperature,
    );
    finalText = fallback.content;
  }

  // 5) 流式输出 finalText（不带 tools）
  emit(IPC.EVT_CHAT_AGENT_PHASE, { sessionId: sess, phase: 'finalizing', iteration });
  // v1.2.3 历史对话摘要
  const pastSummaries = searchSessionSummaries(userContent, 2);
  const summaryBlock =
    pastSummaries.length > 0
      ? '【历史对话摘要】\n' +
        pastSummaries
          .map(
            (s, i) =>
              `[#H${i + 1} ${new Date(s.createdAt).toLocaleString('zh-CN')}] ${s.summary}`,
          )
          .join('\n\n') +
        '\n\n'
      : '';
  const finalStreamMessages: ChatMessage[] = [
    { role: 'system', content: sysPrompt },
    // 复用 messages 里非 tool 的对话历史 + 累积的所有 citations 拼成 context user
    ...messages.filter((m) => m.role !== 'tool'),
    {
      role: 'user',
      content:
        allCitations.length > 0
          ? summaryBlock +
            `【参考资料】\n${allCitations
              .map((c, i) => `[#${i + 1} ${c.filename}]\n${c.chunk}`)
              .join('\n\n')}\n\n【用户问题】\n${userContent}\n\n请基于以上资料回答。`
          : summaryBlock + userContent,
    },
  ];

  let streamed = '';
  await chatStream(
    input.provider,
    input.apiKey,
    input.model,
    finalStreamMessages,
    input.temperature,
    (d: ChatDelta) => {
      if (d.content) {
        streamed += d.content;
        emit(IPC.EVT_CHAT_TOKEN, { sessionId: sess, delta: d.content, done: false });
      }
    },
  );
  if (streamed) finalText = streamed;

  // 6) 拼"引用来源"尾巴
  const citationTail = allCitations.length
    ? '\n\n---\n**引用来源**\n' +
      allCitations.map((c, i) => `${i + 1}. ${c.filename} · ${c.chunk}`).join('\n')
    : '';
  if (citationTail) {
    emit(IPC.EVT_CHAT_TOKEN, { sessionId: sess, delta: citationTail, done: false });
    finalText += citationTail;
  }

  // 7) 持久化
  const assistantMsgId = 'msg_' + (Date.now() + 1).toString(36);
  const trace: AgentTrace = {
    steps,
    totalLatencyMs: Date.now() - t0,
    kbIds: input.kbIds,
    iterations: iteration,
    didKBSelection: input.didKBSelection,
  };
  addMessage({
    id: assistantMsgId,
    sessionId: sess,
    role: 'assistant',
    content: finalText,
    citations: allCitations,
    agentTrace: trace,
  });
  touchSession(sess);

  emit(IPC.EVT_CHAT_TOKEN, { sessionId: sess, delta: '', done: true });
  emit(IPC.EVT_CHAT_DONE, { sessionId: sess, messageId: assistantMsgId });

  log(`done: iters=${iteration} citations=${allCitations.length} totalMs=${trace.totalLatencyMs}`);
  return { assistantMsgId, finalText, trace };
}

// ===== KB 自选（多 KB 场景，让 LLM 决定搜哪些） =====

/**
 * 把 KB 列表（含 description + chunkCount）喂给 LLM，让它从 userQuery 推断应该搜哪些 KB。
 * 返回的 kbIds 必须是 allKBs 中实际存在的；不合法或解析失败时回退到 caller 的原 kbIds。
 */
export async function selectKBs(
  userQuery: string,
  allKBs: KnowledgeBase[],
  candidateIds: string[],
  provider: ProviderConfig,
  apiKey: string,
  model: string,
): Promise<string[]> {
  if (allKBs.length === 0 || candidateIds.length <= 1) return candidateIds;

  const catalog = allKBs
    .map(
      (kb) =>
        `- id=${kb.id} | name=${kb.name} | ` +
        `desc=${kb.description ? kb.description.slice(0, 100) : '（无）'} | ` +
        `chunks=${kb.chunkCount}`,
    )
    .join('\n');
  const sysPrompt =
    `你是 KB 路由器。根据用户问题与下面的 KB 目录，决定需要检索哪些 KB。\n` +
    `严格输出 JSON：{"kb_ids":["kb_xxx"],"reason":"一句话"}。不要其他文字。\n` +
    `规则：(1) 与所有 KB 都无关时返回空数组；` +
    `(2) 涉及多个 KB 时全选；` +
    `(3) 只输出 JSON，可放在 \`\`\`json ... \`\`\` 代码块里。`;
  const userPrompt = `【KB 目录】\n${catalog}\n\n【用户问题】\n${userQuery}`;

  try {
    const r = await chatCompletion(
      provider,
      apiKey,
      model,
      [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userPrompt },
      ],
      0.2,
    );
    const jsonStr = extractJson(r.content);
    if (!jsonStr) {
      console.warn('[agent] [selectKBs] no JSON in LLM response, fallback to candidate');
      return candidateIds;
    }
    const parsed = JSON.parse(jsonStr);
    const ids: string[] = Array.isArray(parsed.kb_ids)
      ? parsed.kb_ids.filter((x: unknown): x is string => typeof x === 'string')
      : [];
    // 白名单 + 与 caller 传入的 candidateIds 求交
    const valid = ids.filter(
      (id) => allKBs.some((k) => k.id === id) && candidateIds.includes(id),
    );
    if (valid.length === 0) {
      console.warn('[agent] [selectKBs] no valid kb_ids, fallback to candidate');
      return candidateIds;
    }
    console.log('[agent] [selectKBs] selected', valid, 'reason:', parsed.reason);
    return valid;
  } catch (e) {
    console.warn('[agent] [selectKBs] failed, fallback to candidate', e);
    return candidateIds;
  }
}

// ===== 工具函数 =====

const AGENT_SYSTEM_PROMPT = `你是一个严谨的本地知识库助手。
你可以调用 search_kb 在已授权的知识库里检索相关片段。
- 拿到结果后请判断信息是否足够：足够就直接回答（不要调用工具），不够可用更精确的 sub_query 再搜
- 如果用户问题与知识库无关、属于闲聊/常识/数学/代码等，直接回答不要检索（可调用 skip_search 或直接答）
- 引用时请在回答末尾用 Markdown 列表形式标注 [#n]`;

function safeJsonParse(s: string | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractJson(s: string): string | null {
  // 容错：可能夹在 ```json ... ``` 里
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const bare = s.match(/\{[\s\S]*\}/);
  return bare ? bare[0] : null;
}

function toChatMessage(m: Message): ChatMessage {
  // 历史里只取 user/assistant/system（跳过 tool）
  return {
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content ?? '',
  };
}
