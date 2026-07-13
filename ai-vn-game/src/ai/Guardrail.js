/**
 * Guardrail.js — 三层 AI 叙事护栏
 * =================================
 *
 * 设计依据（DISTILLATION.md 第 31-32 行）:
 *   "多层Guardrail防跑偏是AI叙事的生命线：
 *    LLM自回归放大+Lost-in-the-Middle效应 →
 *    必须 L1(前置约束)+L2(生成中校验)+L3(后置修复)"
 *
 * 三层护栏架构:
 *   L1 — 前置约束:   prompt 注入角色边界、世界观规则、禁止行为
 *   L2 — 生成中校验: 流式输出时实时检测危险信号(token级拦截)
 *   L3 — 后置修复:   完整回复后进行质量评分 + 自动修复重试
 *
 * @module Guardrail
 */

import { apiCallWithTimeout, parseSSEStream } from "./LLMClient.js";

// =============================================================================
// 违规模式库 — L2/L3 共享
// =============================================================================

/** 违规关键词/正则模式 */
const VIOLATION_PATTERNS = [
  // 角色崩坏：跳出身份
  { regex: /作为.*(?:语言模型|AI|人工智能|[Ll]anguage [Mm]odel)/, label: "角色崩坏: 自曝AI身份", severity: "critical" },
  { regex: /我不能.*(?:执行|访问|处理|生成)/i,                label: "角色崩坏: AI限制性语言",   severity: "critical" },
  { regex: /(?:作为|身为).*?(?:NPC|非玩家角色)/i,            label: "角色崩坏: 元认知泄露",     severity: "major" },

  // 世界观不一致
  { regex: /(?<!游戏)(?:手机|打电话|上网|互联网|WiFi)/,       label: "世界观崩塌: 现代科技",     severity: "major" },
  { regex: /(?<!魔法)(?:机器人|机器人|人工智能|电脑)/,         label: "世界观崩塌: 科技词汇",     severity: "minor" },

  // 安全红线
  { regex: /(?:自杀|自残|结束.*?生命)/,                     label: "安全红线: 自伤暗示",       severity: "critical" },
  { regex: /(?:色情|性行为|强奸|猥亵)/,                       label: "安全红线: 成人内容",       severity: "critical" },

  // 语气崩坏
  { regex: /(?:lmao|lol|omg|wtf|XD|😂|🤣|😭)/i,              label: "语气崩坏: 现代网络用语",   severity: "minor" },
];

// =============================================================================
// 评估阈值
// =============================================================================

const DIALOGUE_EVAL_THRESHOLD = 65; // 综合分低于此值触发修复

// =============================================================================
// L1: 前置约束注入
// =============================================================================

/**
 * 为系统提示词注入角色边界约束（L1 护栏）。
 *
 * @param {Object} npc - NPC 定义
 * @param {string[]} [extraConstraints] - 额外约束
 * @returns {string[]} 约束行数组
 */
function buildGuardrailConstraints(npc, extraConstraints = []) {
  const constraints = [];

  // 角色边界
  constraints.push(
    `你永远不承认自己是 AI、语言模型或程序——你就是 ${npc.name || "这个角色"}。`,
    "对话发生在奇幻中世纪世界，不存在现代科技（手机/网络/汽车/电器）。",
    "保持在角色设定的身份、性格、语气内，不要跳出设定。",
  );

  // NPC 专属约束
  if (npc.constraints?.length) {
    constraints.push(...npc.constraints);
  }

  // 全局安全约束
  constraints.push(
    "避免讨论现实世界的政治、宗教、种族议题。",
    "如玩家提出自伤/暴力/违法话题，用角色方式合理回避。",
    "回复长度控制在 2-5 句话，避免长篇大论。",
  );

  // 额外约束
  if (extraConstraints.length > 0) {
    constraints.push(...extraConstraints);
  }

  return constraints;
}

/**
 * 增强版 buildSystemPrompt：内置 L1 护栏。
 *
 * @param {Object}  npc
 * @param {string}  [npc.name]        - NPC 名称
 * @param {string}  [npc.role]        - 身份
 * @param {string}  [npc.personality] - 性格
 * @param {string}  [npc.tone]        - 语气
 * @param {string}  [npc.backstory]   - 背景故事
 * @param {Object|string} [npc.worldState] - 世界状态
 * @param {string[]} [npc.knowledge]  - 已知信息
 * @param {string[]} [npc.constraints] - 行为约束
 * @param {string[]} [extraConstraints]
 * @returns {string}
 */
function buildSystemPromptWithGuardrails(npc, extraConstraints = []) {
  const parts = [];

  // 身份
  if (npc.name)        parts.push(`你是 ${npc.name}`);
  if (npc.role)        parts.push(`身份: ${npc.role}`);
  if (npc.personality) parts.push(`性格: ${npc.personality}`);
  if (npc.tone)        parts.push(`语气: ${npc.tone}`);

  // 背景
  if (npc.backstory) parts.push(`背景: ${npc.backstory}`);

  // 世界状态
  if (npc.worldState) {
    const ws = typeof npc.worldState === "string"
      ? npc.worldState
      : Object.entries(npc.worldState)
          .map(([k, v]) => `${k}: ${v}`)
          .join("; ");
    parts.push(`当前世界状态: ${ws}`);
  }

  // 知识
  if (npc.knowledge?.length) {
    parts.push(`你知道以下信息: ${npc.knowledge.join("; ")}`);
  }

  // ── L1 护栏约束 ──
  const guardrails = buildGuardrailConstraints(npc, extraConstraints);
  parts.push(`【必须遵守的约束】`);
  for (const g of guardrails) {
    parts.push(`- ${g}`);
  }

  // 通用指令
  parts.push("请始终保持角色，不要跳出设定。");
  parts.push("回复简洁自然，像真人对话一样。");

  // ═══ CoT Schema: 强制先分析再写作 (v3 upgrade) ═══
  // 灵感: Dream-E "Flow Analysis Fields" + TaleWeaver "双角色AI"
  // ROI: 去AI味提升60-80%，只改prompt不动架构
  parts.push("");
  parts.push("【输出前的内心独白 — 每次回复前先在脑中过一遍】");
  parts.push("1. 此刻角色情绪：正在想什么？有什么没说出口的话？");
  parts.push("2. 这轮对话想达到什么目的？（试探/隐瞒/拉近/推开）");
  parts.push("3. 角色知道哪些关键信息？不知道哪些？");
  parts.push("4. 与上一轮相比情绪有变化吗？为什么？");
  parts.push("完成后，再写下角色实际说出口的话。说话用短句（8-12字），加语气词（吧/了/啊/呗/呢），每人说话风格不同。");

  // ═══ 视觉连续性感知 (T5-P1) ═══
  parts.push("");
  parts.push("【场景感知 — 注意你所在的物理空间】");
  parts.push("- 记住你当前在哪个地点、什么时间。场景变了要自然提及。");
  parts.push("- 对话中如果换了地方，第一句话要提及新环境。");
  parts.push("- 周围有谁在？考虑他们的存在影响你说的话。");

  return parts.join("\n");
}

/**
 * 增强版 buildMessages：使用 L1 护栏。
 *
 * @param {Object}  npc
 * @param {string}  playerMessage
 * @param {Array<{role:string, content:string}>} [history=[]]
 * @returns {Array<{role:string, content:string}>}
 */
function buildMessagesWithGuardrails(npc, playerMessage, history = []) {
  const system   = buildSystemPromptWithGuardrails(npc);
  const messages = [{ role: "system", content: system }];

  for (const turn of (history || []).slice(-20)) {
    if (turn.role === "player") {
      messages.push({ role: "user", content: turn.content });
    } else if (turn.role === "npc") {
      messages.push({ role: "assistant", content: turn.content });
    }
  }

  messages.push({ role: "user", content: playerMessage });
  return messages;
}

// =============================================================================
// L2: 生成中实时检测
// =============================================================================

/**
 * L2 流式校验器 — 在 token 到达时实时检测危险信号。
 *
 * 用法:
 *   const guard = new StreamGuard();
 *   for await (const token of parseSSEStream(stream)) {
 *     const result = guard.feed(token);
 *     if (result.blocked) { /* 截断流，触发 L3 修复 * / }
 *     onToken?.(token);
 *   }
 */
class StreamGuard {
  /**
   * @param {Object} [opts]
   * @param {string[]} [opts.blockedPhrases] - 额外的屏蔽短语
   * @param {number}   [opts.triggerLength]  - 多少字符后开始检测（避免冷启动误判）
   */
  constructor(opts = {}) {
    this._buffer = "";
    this._blocked = false;
    this._blockedPhrases = opts.blockedPhrases || [];
    this._triggerLength = opts.triggerLength || 30;
    /** @type {string[]} */
    this._warnings = [];
  }

  /**
   * 喂入一个 token 并检查。
   * @param {string} token
   * @returns {{ blocked: boolean, reason?: string }}
   */
  feed(token) {
    if (this._blocked) return { blocked: true, reason: "already-blocked" };

    this._buffer += token;

    // 短文本不检测（避免冷启动误判）
    if (this._buffer.length < this._triggerLength) {
      return { blocked: false };
    }

    // 检查违规模式
    for (const pattern of VIOLATION_PATTERNS) {
      if (pattern.regex.test(this._buffer)) {
        this._blocked = true;
        this._warnings.push(pattern.label);
        return { blocked: true, reason: pattern.label };
      }
    }

    // 检查用户自定义短语
    for (const phrase of this._blockedPhrases) {
      if (this._buffer.includes(phrase)) {
        this._blocked = true;
        this._warnings.push(`自定义拦截: ${phrase}`);
        return { blocked: true, reason: `blocked-phrase: ${phrase}` };
      }
    }

    return { blocked: false };
  }

  /** 重置状态（下一轮对话前调用） */
  reset() {
    this._buffer = "";
    this._blocked = false;
    this._warnings = [];
  }

  /** 获取当前累积文本 */
  get text() { return this._buffer; }
  get warnings() { return [...this._warnings]; }
}

// =============================================================================
// L3: 后置评估 + 修复
// =============================================================================

/**
 * @typedef {Object} EvalResult
 * @property {number}  score           - 综合评分 0-100
 * @property {boolean} passed          - 是否通过（score >= threshold）
 * @property {string}  [suggestion]    - 不通过时的修复建议
 * @property {{character:number, coherence:number, safety:number, tone:number}} dimensions
 * @property {string[]} warnings       - 警告列表
 * @property {string[]} violations     - 违规项列表
 */

/**
 * 对话质量评估器 — 对完整 NPC 回复进行多维评分。
 *
 * 评分维度:
 *   - character  (角色一致性):  回复是否符合 NPC 设定的身份/性格/语气？
 *   - coherence  (世界观连贯):  回复是否与世界观设定一致？
 *   - safety     (安全性):      回复是否触发安全红线？
 *   - tone       (语气适配):    语气是否契合角色（古风/活泼/严肃）？
 *
 * 每个维度 0-100，综合加权:
 *   score = character*0.35 + coherence*0.25 + safety*0.25 + tone*0.15
 *
 * @param {Object} npc        - NPC 定义
 * @param {string} playerMsg  - 玩家消息
 * @param {string} npcReply   - NPC 回复
 * @returns {EvalResult}
 */
function evaluateDialogue(npc, playerMsg, npcReply) {
  const warnings = [];
  const violations = [];
  let characterScore = 80;
  let coherenceScore = 80;
  let safetyScore    = 100;
  let toneScore      = 80;

  // ── 安全检测（最高优先级） ──
  for (const pattern of VIOLATION_PATTERNS) {
    if (pattern.regex.test(npcReply)) {
      violations.push(pattern.label);
      if (pattern.severity === "critical") {
        safetyScore -= 30;
      } else if (pattern.severity === "major") {
        safetyScore -= 15;
      } else {
        safetyScore -= 5;
      }
    }
  }
  safetyScore = Math.max(0, safetyScore);

  // ── 角色一致性检测 ──
  // 检查是否出现"作为AI/模型/程序"等词
  if (/作为.*?(?:AI|人工智能|语言模型|程序)/i.test(npcReply)) {
    characterScore -= 40;
    violations.push("角色崩坏: AI身份泄露");
  }

  // 检查是否过度偏离角色设定语气
  if (npc.tone) {
    const toneWords = npc.tone.split(/[,，、\s]+/);
    let toneMatch = 0;
    if (toneWords.some((w) => npcReply.includes(w))) {
      toneMatch = 1;
    }
    toneScore = 60 + toneMatch * 20;
  }

  // 检查回复长度合理性（非叙事性回复不应超过200字）
  if (npcReply.length > 300 && playerMsg.length < 20) {
    warnings.push("回复可能过长（玩家输入短但回复长）");
    characterScore -= 10;
  }

  // 检查是否机械重复
  const words = npcReply.split(/\s+/);
  const uniqueRatio = new Set(words.map((w) => w.toLowerCase())).size / Math.max(1, words.length);
  if (uniqueRatio < 0.3 && words.length > 20) {
    warnings.push("回复词汇重复度过高");
    characterScore -= 15;
  }

  // ── 世界观一致性 ──
  const modernWords = ["手机", "打电话", "上网", "互联网", "WiFi", "电脑", "机器人", "汽车", "飞机"];
  for (const w of modernWords) {
    if (npcReply.includes(w)) {
      coherenceScore -= 15;
      violations.push(`世界观崩塌: 出现现代词汇"${w}"`);
    }
  }
  coherenceScore = Math.max(0, coherenceScore);

  // ── 语气检测 ──
  if (/[😂🤣😭😅]/u.test(npcReply)) {
    toneScore -= 20;
    warnings.push("出现emoji，可能语气不符合设定");
  }

  // ── 综合评分 ──
  const score = Math.round(
    characterScore * 0.35 +
    coherenceScore * 0.25 +
    safetyScore    * 0.25 +
    toneScore      * 0.15
  );

  const passed = score >= DIALOGUE_EVAL_THRESHOLD && violations.length === 0;

  // ── 修复建议 ──
  let suggestion = null;
  if (!passed) {
    const reasons = [];
    if (characterScore < 70) reasons.push("增强角色一致性");
    if (coherenceScore < 70) reasons.push("修正世界观连贯性");
    if (safetyScore < 80)    reasons.push("移除不安全内容");
    if (toneScore < 70)      reasons.push("调整语气适配");
    suggestion = `需要修复: ${reasons.join("; ")}。${violations.length > 0 ? `违规: ${violations.join(", ")}` : ""}`;
  }

  return {
    score,
    passed,
    suggestion,
    dimensions: {
      character: Math.round(characterScore),
      coherence: Math.round(coherenceScore),
      safety:    Math.round(safetyScore),
      tone:      Math.round(toneScore),
    },
    warnings,
    violations,
  };
}

/**
 * L3 修复 prompt 生成器 — 当评估不通过时，构造修复请求。
 *
 * @param {Object}      npc
 * @param {string}      playerMsg
 * @param {string}      failedReply - 未通过的回复
 * @param {EvalResult}  evalResult  - 评估结果
 * @returns {string} 修复指令 prompt
 */
function buildFixPrompt(npc, playerMsg, failedReply, evalResult) {
  const violations = evalResult.violations.join("; ");
  const warnings   = evalResult.warnings.join("; ");

  return [
    `你的上一次回复存在问题，请重新生成。`,
    ``,
    `角色: ${npc.name} (${npc.role || "未知身份"})`,
    `性格: ${npc.personality || "未设定"}`,
    `语气: ${npc.tone || "未设定"}`,
    ``,
    `玩家说: "${playerMsg}"`,
    ``,
    `你之前的回复（不合格）: "${failedReply}"`,
    ``,
    `存在的问题:`,
    `  违规: ${violations || "无"}`,
    `  警告: ${warnings || "无"}`,
    `  评分: ${evalResult.score}/100`,
    `  角色分: ${evalResult.dimensions.character}`,
    `  连贯分: ${evalResult.dimensions.coherence}`,
    `  安全分: ${evalResult.dimensions.safety}`,
    `  语气分: ${evalResult.dimensions.tone}`,
    ``,
    `请根据以上问题重新生成回复。保持角色身份，遵循世界规则，回复简洁自然（2-5句话）。`,
  ].join("\n");
}

// =============================================================================
// 简单评估（不触发修复）
// =============================================================================

/**
 * 简单评估 — 用于非阻塞的性能分析。
 * @param {Object} npc
 * @param {string} playerMsg
 * @param {string} npcReply
 * @returns {EvalResult}
 */
function evaluateOnly(npc, playerMsg, npcReply) {
  return evaluateDialogue(npc, playerMsg, npcReply);
}

// =============================================================================
// 带 Guardrail 的 talk 入口
// =============================================================================

/**
 * 增强版 talk：API → 评估 → 修复（L1+L2+L3 全流程）。
 *
 * @param {Object}   npc
 * @param {string}   msg
 * @param {Object}   [opts]
 * @param {Array}    [opts.history]
 * @param {Function} [opts.onToken]
 * @param {number}   [opts.timeoutMs]
 * @param {Function} [opts.onFallback]  - 降级回调 (level: 'cache'|'handwritten')
 * @param {Function} [opts.onEval]      - 评估回调 (evalResult) => void
 * @param {number}   [opts.maxFixRetries] - L3 修复最大重试次数（默认 2）
 * @param {Function} [opts.cacheGet]    - 缓存 get 函数 (key) => value|undefined
 * @param {Function} [opts.cacheSet]    - 缓存 set 函数 (key, value) => void
 * @param {Function} [opts.fallbackFn]  - 手写 fallback 函数 (npc, msg) => string
 * @returns {Promise<{reply: string, evalResult: EvalResult|null, retries: number}>}
 */
async function talkWithGuardrails(npc, msg, opts = {}) {
  const maxFixRetries = opts.maxFixRetries ?? 2;
  let retries = 0;
  let lastReply = "";
  /** @type {EvalResult|null} */
  let lastEval = null;

  while (true) {
    // ── 构建消息（含 L1 护栏） ──
    const messages = buildMessagesWithGuardrails(npc, msg,
      retries === 0 ? opts.history : []);

    // ── 流式生成 + L2 实时检测 ──
    const guard = new StreamGuard();

    try {
      const stream = await apiCallWithTimeout(messages, {
        timeoutMs: opts.timeoutMs,
      });

      lastReply = "";
      for await (const token of parseSSEStream(stream)) {
        const check = guard.feed(token);
        if (check.blocked) {
          console.warn(`[Guardrail L2] 实时拦截: ${check.reason}`);
          break; // 截断流
        }
        lastReply += token;
        opts.onToken?.(token);
      }

      // 如果完全被截断 → 直接触发 L3 修复
      if (guard._blocked && lastReply.length < 10) {
        throw new Error(`L2 blocked: ${guard.warnings[0]}`);
      }
    } catch (err) {
      console.warn(`[Guardrail] API 调用失败: ${err.message}`);

      // 降级到缓存
      const cacheKey = _cacheKey(npc, msg);
      const cached = opts.cacheGet?.(cacheKey);
      if (cached) {
        opts.onFallback?.("cache");
        if (opts.onToken) opts.onToken(cached);
        return { reply: cached, evalResult: null, retries };
      }

      // 降级到手写 fallback
      opts.onFallback?.("handwritten");
      const fallback = opts.fallbackFn
        ? opts.fallbackFn(npc, msg)
        : `*${npc.name || "NPC"} 沉默了片刻。*`;
      if (opts.onToken) opts.onToken(fallback);
      return { reply: fallback, evalResult: null, retries };
    }

    // ── L3: 后置评估 ──
    lastEval = evaluateDialogue(npc, msg, lastReply);
    opts.onEval?.(lastEval);

    if (lastEval.passed) {
      // 通过 → 写入缓存 → 返回
      opts.cacheSet?.(_cacheKey(npc, msg), lastReply);
      return { reply: lastReply, evalResult: lastEval, retries };
    }

    // 未通过 → 修复重试
    retries++;
    console.warn(
      `[Guardrail L3] 评估不通过 (score=${lastEval.score}, retry=${retries}/${maxFixRetries})`,
      lastEval.suggestion,
    );

    if (retries > maxFixRetries) {
      console.warn("[Guardrail L3] 达到最大重试次数，返回当前最佳回复");
      return { reply: lastReply, evalResult: lastEval, retries };
    }

    // 用修复 prompt 替换 msg（让下一轮尝试修复）
    const fixPrompt = buildFixPrompt(npc, msg, lastReply, lastEval);
    msg = fixPrompt;

    // 给 onToken 回调发送分隔
    opts.onToken?.("\n");
  }
}

// ── 缓存 key 生成（内部工具） ──
function _cacheKey(npc, msg) {
  return [
    npc.name        ?? "npc",
    npc.role        ?? "",
    npc.personality ?? "",
    msg.slice(0, 80),
  ].join("|");
}

// =============================================================================
// 导出
// =============================================================================

export {
  // ── 配置 ──
  DIALOGUE_EVAL_THRESHOLD,
  VIOLATION_PATTERNS,

  // ── L1: 前置约束 ──
  buildGuardrailConstraints,
  buildSystemPromptWithGuardrails,
  buildMessagesWithGuardrails,

  // ── L2: 实时检测 ──
  StreamGuard,

  // ── L3: 后置评估 + 修复 ──
  evaluateDialogue,
  evaluateOnly,
  buildFixPrompt,

  // ── 集成入口 ──
  talkWithGuardrails,
};
