// ==UserScript==
// @name         PTA 收藏夹
// @name:zh-CN   PTA 收藏夹
// @namespace    https://github.com/UIM258/PTA-Pro
// @version      0.36.2
// @description  面向 PTA（拼题A）的收藏夹脚本：收藏分类、本地快照、判题记录、AI 解析与导入导出。
// @author       UIM258
// @homepageURL  https://github.com/UIM258/PTA-Pro
// @supportURL   https://github.com/UIM258/PTA-Pro/issues
// @license      MIT
// @match        https://*.pintia.cn/*
// @match        https://pintia.cn/*
// @match        http://*.pintia.cn/*
// @match        http://pintia.cn/*
// @icon         https://static.pintia.cn/sparkling-daydream/icons/default/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @connect      *
// @noframes
// ==/UserScript==

/* Core data model and pure helpers. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PTAF_CORE = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STORAGE_VERSION = 1;
  const DEFAULT_FOLDER_ID = 'default';

  const DEFAULT_SHORTCUTS = {
    toggleDrawer: 'Alt+Shift+F',
    toggleCurrentFavorite: 'Alt+Shift+S',
    toggleBatchMode: 'Alt+Shift+B',
    editSnapshotAnswer: 'Alt+Shift+E',
    snapshotPrev: 'Alt+ArrowLeft',
    snapshotNext: 'Alt+ArrowRight',
    snapshotSingle: 'Alt+Shift+1',
    snapshotSplit: 'Alt+Shift+2',
  };

  const TYPE_LABELS = {
    single_choice: '单选题',
    multiple_choice: '多选题',
    true_false: '判断题',
    fill_blank: '填空题',
    function: '函数题',
    programming: '编程题',
    short_answer: '简答题',
    other: '其他',
  };

  const STATUS_LABELS = {
    todo: '未做',
    doing: '在做',
    done: '已做',
  };

  const ANSWER_VISIBILITY_LABELS = {
    unknown: '答案状态未知',
    hidden: '答案未公布',
    'score-only': '仅公布成绩',
    revealed: '答案已公布',
  };

  const TYPE_PATTERNS = [
    ['single_choice', /单选|单项选择题|single\s*choice/i],
    ['multiple_choice', /多选|多项选择题|multiple\s*choice/i],
    ['true_false', /判断|正误|true\s*\/\s*false|true\s*or\s*false/i],
    ['fill_blank', /填空|fill\s*in\s*the\s*blank/i],
    ['function', /函数题|函数设计|function\s+problem|function\s+question/i],
    ['programming', /编程|程序设计|programming|code\s+problem/i],
    ['short_answer', /简答|问答|short\s*answer/i],
  ];

  function now() {
    return Date.now();
  }

  function uid(prefix) {
    const prefixText = prefix || 'id';
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
      const bytes = new Uint8Array(8);
      globalThis.crypto.getRandomValues(bytes);
      return `${prefixText}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    }
    return `${prefixText}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }

  function normalizeWhitespace(value) {
    return String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\r\f\v]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function safeJsonParse(value, fallback) {
    if (value == null || value === '') return fallback;
    try {
      return JSON.parse(value);
    } catch (error) {
      console.warn('[PTA 收藏夹] JSON 解析失败', error);
      return fallback;
    }
  }

  function numberOrNull(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function unique(values) {
    return Array.from(new Set((values || []).filter((value) => value !== undefined && value !== null && value !== '')));
  }

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function createInitialState() {
    const createdAt = now();
    return {
      schemaVersion: SCHEMA_VERSION,
      storageVersion: STORAGE_VERSION,
      createdAt,
      updatedAt: createdAt,
      settings: {
        defaultFolderId: DEFAULT_FOLDER_ID,
        snapshotByDefault: true,
        openDetailAfterCollect: false,
        maxSubmissions: 8,
        pageSize: 20,
        folderOrder: [DEFAULT_FOLDER_ID],
        bookmarkOrder: {},
        shortcuts: { ...DEFAULT_SHORTCUTS },
        nightMode: false,
        ai: { baseUrl: '', model: '', temperature: 0.2, maxTokens: 2500, timeoutMs: 60000 },
      },
      folders: {
        [DEFAULT_FOLDER_ID]: {
          id: DEFAULT_FOLDER_ID,
          name: '默认收藏夹',
          parentId: null,
          system: true,
          createdAt,
          updatedAt: createdAt,
        },
      },
      bookmarks: {},
    };
  }

  function migrateState(rawState) {
    const base = createInitialState();
    if (!rawState || typeof rawState !== 'object') return base;

    const state = {
      ...base,
      ...rawState,
      schemaVersion: SCHEMA_VERSION,
      storageVersion: STORAGE_VERSION,
      settings: { ...base.settings, ...(rawState.settings || {}) },
      folders: { ...(rawState.folders || {}) },
      bookmarks: {},
    };

    if (!state.folders[DEFAULT_FOLDER_ID]) {
      state.folders[DEFAULT_FOLDER_ID] = clone(base.folders[DEFAULT_FOLDER_ID]);
    }

    Object.entries(state.folders).forEach(([id, folder]) => {
      if (!folder || typeof folder !== 'object') {
        delete state.folders[id];
        return;
      }
      state.folders[id] = {
        id,
        name: normalizeWhitespace(folder.name) || '未命名收藏夹',
        parentId: folder.parentId || null,
        system: Boolean(folder.system),
        createdAt: Number(folder.createdAt) || now(),
        updatedAt: Number(folder.updatedAt) || now(),
      };
    });

    const rawBookmarks = Array.isArray(rawState.bookmarks)
      ? rawState.bookmarks
      : Object.values(rawState.bookmarks || {});

    rawBookmarks.forEach((rawBookmark) => {
      if (!rawBookmark || typeof rawBookmark !== 'object') return;
      const bookmark = createBookmark(rawBookmark, { preserveId: true, preserveTimes: true });
      if (!bookmark.id) return;
      state.bookmarks[bookmark.id] = mergeBookmark(bookmark, rawBookmark, { preserveTimes: true });
    });

    const validFolderIds = Object.keys(state.folders);
    const rawFolderOrder = Array.isArray(state.settings.folderOrder) ? state.settings.folderOrder : [];
    state.settings.folderOrder = unique(rawFolderOrder.filter((folderId) => validFolderIds.includes(folderId)))
      .concat(validFolderIds.filter((folderId) => !rawFolderOrder.includes(folderId)));
    if (!state.settings.bookmarkOrder || typeof state.settings.bookmarkOrder !== 'object') {
      state.settings.bookmarkOrder = {};
    }
    state.settings.shortcuts = { ...DEFAULT_SHORTCUTS, ...(state.settings.shortcuts || {}) };
    state.settings.ai = { baseUrl: '', model: '', temperature: 0.2, maxTokens: 2500, timeoutMs: 60000, ...(state.settings.ai || {}) };

    state.updatedAt = Number(rawState.updatedAt) || now();
    return state;
  }

  function normalizeProblemType(value) {
    if (!value) return 'other';
    if (TYPE_LABELS[value]) return value;
    const text = String(value);
    for (const [type, pattern] of TYPE_PATTERNS) {
      if (pattern.test(text)) return type;
    }
    return 'other';
  }

  function typeLabel(type) {
    return TYPE_LABELS[normalizeProblemType(type)] || TYPE_LABELS.other;
  }

  function statusLabel(status) {
    return STATUS_LABELS[status] || STATUS_LABELS.todo;
  }

  function answerVisibilityLabel(visibility) {
    return ANSWER_VISIBILITY_LABELS[visibility] || ANSWER_VISIBILITY_LABELS.unknown;
  }

  function inferProblemType(text) {
    return normalizeProblemType(text);
  }

  function inferProblemLabel(text) {
    const normalized = normalizeWhitespace(text);
    const matches = normalized.match(/\b(?:\d{1,4}[-–—]\d{1,4}|[A-Z]?\d{1,3})\b/g);
    if (!matches || !matches.length) return '';
    const preferred = matches.find((value) => /[-–—]/.test(value));
    return preferred || matches[0];
  }

  function cleanProblemTitle(value) {
    return normalizeWhitespace(value)
      .replace(/^题目详情\s*[-|·:：]?\s*/i, '')
      .replace(/\s*[-|·:：]\s*PTA.*$/i, '')
      .replace(/\s*[-|·:：]\s*拼题A.*$/i, '')
      .replace(/\s*[-|·:：]\s*题目详情$/i, '')
      .trim();
  }

  function parseProblemUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl, 'https://sduwh.pintia.cn/');
    } catch (error) {
      return {
        ok: false,
        url: String(rawUrl || ''),
        path: '',
        host: '',
        problemId: '',
        problemSetId: '',
        label: '',
      };
    }

    const path = url.pathname;
    let problemSetId = '';
    let problemId = '';

    let match = path.match(/\/problem-sets\/([^/]+)\/problems\/([^/?#]+)/i);
    if (match) {
      problemSetId = decodeURIComponent(match[1]);
      problemId = decodeURIComponent(match[2]);
    }

    if (!problemSetId) {
      match = path.match(/\/problem-sets\/([^/]+)(?:\/|$)/i);
      if (match) problemSetId = decodeURIComponent(match[1]);
    }

    if (!problemId) {
      match = path.match(/\/(?:exam|test|problem|problems)\/problems\/(?!type(?:\/|$))([^/?#]+)/i);
      if (match) problemId = decodeURIComponent(match[1]);
    }

    if (!problemId) {
      match = path.match(/\/problems\/(?!type(?:\/|$))([^/?#]+)/i);
      if (match) problemId = decodeURIComponent(match[1]);
    }

    if (!problemId) {
      const problemQueryKeys = ['problemSetProblemId', 'problemId', 'problem_set_problem_id'];
      for (const key of problemQueryKeys) {
        const value = url.searchParams.get(key);
        if (value) {
          problemId = value;
          break;
        }
      }
    }

    if (!problemSetId) {
      const queryKeys = ['problemSetId', 'problem_set_id', 'problemSet', 'setId'];
      for (const key of queryKeys) {
        if (url.searchParams.get(key)) {
          problemSetId = url.searchParams.get(key) || '';
          break;
        }
      }
    }

    return {
      ok: Boolean(problemId),
      url: url.href,
      origin: url.origin,
      host: url.host,
      path,
      problemId,
      problemSetId,
      label: '',
    };
  }

  function makeBookmarkKey(input) {
    const parsed = typeof input === 'string' ? parseProblemUrl(input) : parseProblemUrl(input && (input.url || input.href));
    const host = parsed.host || normalizeWhitespace(input && input.host) || 'pintia.cn';
    const problemSetId = parsed.problemSetId || normalizeWhitespace(input && input.problemSetId) || '_';
    const problemId = parsed.problemId || normalizeWhitespace(input && input.problemId) || normalizeWhitespace(input && input.title) || 'unknown';
    return `${host}|${problemSetId}|${problemId}`;
  }

  function ensureFolder(state, folderId) {
    if (!folderId) return;
    if (!state.folders[folderId]) {
      state.folders[folderId] = {
        id: folderId,
        name: folderId === DEFAULT_FOLDER_ID ? '默认收藏夹' : '未命名收藏夹',
        parentId: null,
        system: folderId === DEFAULT_FOLDER_ID,
        createdAt: now(),
        updatedAt: now(),
      };
    }
  }

  function createBookmark(input, options) {
    const source = input || {};
    const opts = options || {};
    const fallbackUrl = typeof location !== 'undefined' ? location.href : 'https://pintia.cn/';
    const parsed = parseProblemUrl(source.url || fallbackUrl);
    const url = parsed.url || normalizeWhitespace(source.url);
    const title = cleanProblemTitle(source.title) || '未命名题目';
    const type = normalizeProblemType(source.type || inferProblemType(`${title} ${source.typeLabel || ''}`));
    const timestamp = opts.preserveTimes ? Number(source.createdAt) || now() : now();
    const id = opts.preserveId && source.id
      ? source.id
      : makeBookmarkKey({
          url,
          host: parsed.host,
          problemSetId: source.problemSetId || parsed.problemSetId,
          problemId: source.problemId || parsed.problemId,
          title,
        });

    const folderIds = Array.isArray(source.folderIds)
      ? unique(source.folderIds)
      : [DEFAULT_FOLDER_ID];

    return {
      id,
      problemId: normalizeWhitespace(source.problemId) || parsed.problemId,
      problemSetId: normalizeWhitespace(source.problemSetId) || parsed.problemSetId,
      problemSetName: normalizeWhitespace(source.problemSetName) || '未命名题目集',
      host: parsed.host || normalizeWhitespace(source.host) || (typeof location !== 'undefined' ? location.host : 'pintia.cn'),
      url,
      title,
      label: normalizeWhitespace(source.label) || inferProblemLabel(title),
      type,
      folderIds,
      tags: unique(source.tags),
      note: normalizeWhitespace(source.note),
      status: STATUS_LABELS[source.status] ? source.status : 'todo',
      createdAt: timestamp,
      updatedAt: opts.preserveTimes ? Number(source.updatedAt) || timestamp : now(),
      content: normalizeContent(source.content),
      answer: normalizeAnswer(source.answer),
      submissions: Array.isArray(source.submissions) ? source.submissions.map(normalizeSubmission) : [],
    };
  }

  function normalizeContent(value) {
    const source = value && typeof value === 'object' ? value : {};
    const capturedAt = Number(source.capturedAt) || 0;
    return {
      status: ['full', 'partial', 'missing'].includes(source.status)
        ? source.status
        : capturedAt
          ? 'partial'
          : 'missing',
      capturedAt,
      contentHash: normalizeWhitespace(source.contentHash),
      url: normalizeWhitespace(source.url),
      title: normalizeWhitespace(source.title),
      answerVisibility: ANSWER_VISIBILITY_LABELS[source.answerVisibility] ? source.answerVisibility : 'unknown',
    };
  }

  function normalizeAi(value) {
    const source = value && typeof value === 'object' ? value : {};
    const complexity = source.complexity && typeof source.complexity === 'object' ? source.complexity : {};
    return {
      analysis: normalizeWhitespace(source.analysis),
      answer: normalizeWhitespace(source.answer),
      referenceCode: String(source.referenceCode || ''),
      knowledgePoints: unique(source.knowledgePoints),
      complexity: {
        time: normalizeWhitespace(complexity.time),
        space: normalizeWhitespace(complexity.space),
      },
      model: normalizeWhitespace(source.model),
      skillId: normalizeWhitespace(source.skillId),
      skillVersion: normalizeWhitespace(source.skillVersion),
      generatedAt: Number(source.generatedAt) || 0,
      basedOnSnapshotHash: normalizeWhitespace(source.basedOnSnapshotHash),
      reviewedByUser: source.reviewedByUser === true,
    };
  }

  function normalizeAnswer(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      visibility: ANSWER_VISIBILITY_LABELS[source.visibility] ? source.visibility : 'unknown',
      officialAnswer: normalizeWhitespace(source.officialAnswer),
      explanation: normalizeWhitespace(source.explanation),
      userAnswer: normalizeWhitespace(source.userAnswer),
      score: numberOrNull(source.score),
      maxScore: numberOrNull(source.maxScore),
      correct: source.correct === true ? true : source.correct === false ? false : null,
      submissionStatus: normalizeWhitespace(source.submissionStatus),
      submittedAt: Number(source.submittedAt) || 0,
      revealedAt: Number(source.revealedAt) || 0,
      source: source.source === 'pta' || source.source === 'user' ? source.source : '',
      lastCheckedAt: Number(source.lastCheckedAt) || 0,
      ai: normalizeAi(source.ai),
    };
  }

  function normalizeSubmission(value) {
    const source = value && typeof value === 'object' ? value : {};
    const submittedAt = Number(source.submittedAt) || now();
    const code = String(source.code || '');
    const submissionId = normalizeWhitespace(source.submissionId || source.id);
    return {
      id: normalizeWhitespace(source.id) || submissionId || `${submittedAt}_${computeContentHash(code).slice(0, 8)}`,
      submissionId,
      language: normalizeWhitespace(source.language) || '未知语言',
      compiler: normalizeWhitespace(source.compiler),
      code,
      codeHash: normalizeWhitespace(source.codeHash) || computeContentHash(code),
      status: normalizeSubmissionStatus(source.status),
      rawStatus: normalizeWhitespace(source.rawStatus || source.status),
      score: numberOrNull(source.score),
      maxScore: numberOrNull(source.maxScore),
      compileOutput: normalizeWhitespace(source.compileOutput),
      testPoints: Array.isArray(source.testPoints) ? source.testPoints.map((point) => ({
        id: normalizeWhitespace(point && (point.id || point.label)) || uid('point'),
        label: normalizeWhitespace(point && point.label),
        result: normalizeWhitespace(point && point.result),
        score: numberOrNull(point && point.score),
        maxScore: numberOrNull(point && point.maxScore),
        timeMs: Number.isFinite(Number(point && point.timeMs)) ? Number(point.timeMs) : null,
        memoryKb: Number.isFinite(Number(point && point.memoryKb)) ? Number(point.memoryKb) : null,
        message: normalizeWhitespace(point && point.message),
      })) : [],
      submittedAt,
      capturedAt: Number(source.capturedAt) || submittedAt,
      captureMode: source.captureMode === 'manual' ? 'manual' : 'auto',
    };
  }

  function mergeBookmark(existing, incoming, options) {
    const opts = options || {};
    if (!existing) return createBookmark(incoming, opts);
    if (!incoming) return existing;

    const merged = {
      ...existing,
      problemId: incoming.problemId || existing.problemId,
      problemSetId: incoming.problemSetId || existing.problemSetId,
      problemSetName: incoming.problemSetName && incoming.problemSetName !== '未命名题目集'
        ? incoming.problemSetName
        : existing.problemSetName,
      host: incoming.host || existing.host,
      url: incoming.url || existing.url,
      title: incoming.title && incoming.title !== '未命名题目' ? incoming.title : existing.title,
      label: incoming.label || existing.label,
      type: normalizeProblemType(incoming.type || existing.type),
      folderIds: unique([...(existing.folderIds || []), ...(incoming.folderIds || [])]),
      tags: unique([...(existing.tags || []), ...(incoming.tags || [])]),
      note: existing.note || incoming.note,
      status: incoming.status || existing.status,
      content: mergeContent(existing.content, incoming.content),
      answer: mergeAnswer(existing.answer, incoming.answer),
      submissions: mergeSubmissions(existing.submissions, incoming.submissions, opts.maxSubmissions),
      createdAt: Math.min(Number(existing.createdAt) || now(), Number(incoming.createdAt) || now()),
      updatedAt: opts.preserveTimes
        ? Math.max(Number(existing.updatedAt) || 0, Number(incoming.updatedAt) || 0)
        : now(),
    };

    return merged;
  }

  function mergeContent(existing, incoming) {
    const left = normalizeContent(existing);
    const right = normalizeContent(incoming);
    if (!right.capturedAt && right.status === 'missing') return left;
    if (!left.capturedAt) return right;
    return right.capturedAt >= left.capturedAt ? { ...left, ...right } : left;
  }

  function mergeAnswer(existing, incoming) {
    const left = normalizeAnswer(existing);
    const right = normalizeAnswer(incoming);
    const merged = { ...left };
    if (right.visibility !== 'unknown') merged.visibility = right.visibility;
    if (right.officialAnswer) merged.officialAnswer = right.officialAnswer;
    if (right.explanation) merged.explanation = right.explanation;
    if (right.userAnswer) merged.userAnswer = right.userAnswer;
    if (right.score != null) merged.score = right.score;
    if (right.maxScore != null) merged.maxScore = right.maxScore;
    if (right.correct != null) merged.correct = right.correct;
    if (right.submissionStatus) merged.submissionStatus = right.submissionStatus;
    if (right.submittedAt) merged.submittedAt = right.submittedAt;
    if (right.revealedAt) merged.revealedAt = right.revealedAt;
    if (right.source) merged.source = right.source;
    if (right.lastCheckedAt) merged.lastCheckedAt = right.lastCheckedAt;
    if (right.ai && right.ai.generatedAt && (!left.ai || right.ai.generatedAt >= (left.ai.generatedAt || 0))) {
      merged.ai = right.ai;
    }
    return merged;
  }

  function mergeSubmissions(existing, incoming, maxSubmissions) {
    const limit = Number(maxSubmissions) > 0 ? Number(maxSubmissions) : 8;
    const map = new Map();
    [...(existing || []), ...(incoming || [])].forEach((submission) => {
      const normalized = normalizeSubmission(submission);
      const key = normalized.code && normalized.code.trim().length >= 8 && normalized.codeHash
        ? normalized.codeHash
        : normalized.submissionId || normalized.id;
      const previous = map.get(key);
      if (!previous || normalized.capturedAt >= previous.capturedAt) {
        map.set(key, normalized);
      } else {
        map.set(key, { ...previous, ...normalized, capturedAt: previous.capturedAt });
      }
    });
    return Array.from(map.values())
      .sort((a, b) => b.submittedAt - a.submittedAt)
      .slice(0, limit);
  }

  function upsertBookmarkInState(state, bookmark, options) {
    const incoming = createBookmark(bookmark, options);
    ensureFolder(state, DEFAULT_FOLDER_ID);
    const existing = state.bookmarks[incoming.id];
    state.bookmarks[incoming.id] = mergeBookmark(existing, incoming, options);
    state.updatedAt = now();
    return state.bookmarks[incoming.id];
  }

  function removeBookmarkFromState(state, bookmarkId) {
    if (!state.bookmarks[bookmarkId]) return false;
    delete state.bookmarks[bookmarkId];
    state.updatedAt = now();
    return true;
  }

  function createFolder(state, name, parentId) {
    const cleanName = normalizeWhitespace(name);
    if (!cleanName) throw new Error('收藏夹名称不能为空');
    const parent = parentId ? state.folders[parentId] : null;
    const id = uid('folder');
    state.folders[id] = {
      id,
      name: cleanName,
      parentId: parent ? parentId : null,
      system: false,
      createdAt: now(),
      updatedAt: now(),
    };
    if (!Array.isArray(state.settings.folderOrder)) state.settings.folderOrder = [];
    state.settings.folderOrder.push(id);
    state.updatedAt = now();
    return state.folders[id];
  }

  function renameFolder(state, folderId, name) {
    const folder = state.folders[folderId];
    if (!folder) return false;
    if (folder.system) return false;
    const cleanName = normalizeWhitespace(name);
    if (!cleanName) return false;
    folder.name = cleanName;
    folder.updatedAt = now();
    state.updatedAt = now();
    return true;
  }

  function deleteFolder(state, folderId) {
    const folder = state.folders[folderId];
    if (!folder || folder.system || folderId === DEFAULT_FOLDER_ID) return false;
    Object.values(state.bookmarks).forEach((bookmark) => {
      bookmark.folderIds = (bookmark.folderIds || []).filter((id) => id !== folderId);
    });
    Object.values(state.folders).forEach((child) => {
      if (child.parentId === folderId) child.parentId = folder.parentId || null;
    });
    delete state.folders[folderId];
    if (Array.isArray(state.settings.folderOrder)) {
      state.settings.folderOrder = state.settings.folderOrder.filter((id) => id !== folderId);
    }
    state.updatedAt = now();
    return true;
  }

  function listOrderedFolders(state) {
    const order = Array.isArray(state.settings && state.settings.folderOrder) ? state.settings.folderOrder : [];
    const indexMap = new Map(order.map((folderId, index) => [folderId, index]));
    return Object.values(state.folders || {})
      .sort((a, b) => {
        const aIndex = indexMap.has(a.id) ? indexMap.get(a.id) : Number.MAX_SAFE_INTEGER;
        const bIndex = indexMap.has(b.id) ? indexMap.get(b.id) : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;
        if (Boolean(a.system) !== Boolean(b.system)) return Number(b.system) - Number(a.system);
        return a.name.localeCompare(b.name, 'zh-CN');
      });
  }

  function listUserFolders(state) {
    return listOrderedFolders(state).filter((folder) => !folder.system);
  }

  function isCollected(bookmark) {
    return Boolean(bookmark && Array.isArray(bookmark.folderIds) && bookmark.folderIds.length > 0);
  }

  function groupBookmarks(state) {
    const bookmarks = Object.values(state.bookmarks || {}).filter(isCollected);
    const setMap = new Map();
    bookmarks.forEach((bookmark) => {
      const setId = bookmark.problemSetId || `title:${bookmark.problemSetName || '未命名题目集'}`;
      if (!setMap.has(setId)) {
        setMap.set(setId, {
          id: setId,
          name: bookmark.problemSetName || '未命名题目集',
          count: 0,
          types: new Map(),
        });
      }
      const problemSet = setMap.get(setId);
      problemSet.count += 1;
      const type = normalizeProblemType(bookmark.type);
      problemSet.types.set(type, (problemSet.types.get(type) || 0) + 1);
    });

    return {
      total: bookmarks.length,
      problemSets: Array.from(setMap.values())
        .map((problemSet) => ({
          id: problemSet.id,
          name: problemSet.name,
          count: problemSet.count,
          types: Array.from(problemSet.types.entries())
            .map(([type, count]) => ({ type, label: typeLabel(type), count }))
            .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN')),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
      orderedFolders: listOrderedFolders(state).map((folder) => ({
        ...folder,
        count: bookmarks.filter((bookmark) => (bookmark.folderIds || []).includes(folder.id)).length,
      })),
      userFolders: listUserFolders(state).map((folder) => ({
        ...folder,
        count: bookmarks.filter((bookmark) => (bookmark.folderIds || []).includes(folder.id)).length,
      })),
    };
  }

  function matchesSelection(bookmark, selection) {
    const selected = selection || { kind: 'all' };
    if (selected.kind === 'smart-set') return bookmark.problemSetId === selected.problemSetId;
    if (selected.kind === 'smart-type') {
      return bookmark.problemSetId === selected.problemSetId && normalizeProblemType(bookmark.type) === selected.type;
    }
    if (selected.kind === 'user') return (bookmark.folderIds || []).includes(selected.folderId);
    if (selected.kind === 'unsnapshotted') return !bookmark.content || bookmark.content.status === 'missing';
    if (selected.kind === 'unpublished-answer') {
      return !bookmark.answer || !['revealed'].includes(bookmark.answer.visibility);
    }
    return true;
  }

  function bookmarkOrderKey(selection) {
    const selected = selection || { kind: 'all' };
    if (selected.kind === 'user') return `folder:${selected.folderId}`;
    if (selected.kind === 'smart-set') return `set:${selected.problemSetId}`;
    if (selected.kind === 'smart-type') return `type:${selected.problemSetId}|${selected.type}`;
    return 'all';
  }

  function sortBookmarksByStoredOrder(items, state, selection) {
    const order = state.settings && state.settings.bookmarkOrder && state.settings.bookmarkOrder[bookmarkOrderKey(selection)];
    const orderList = Array.isArray(order) ? order : [];
    const indexMap = new Map(orderList.map((bookmarkId, index) => [bookmarkId, index]));
    return items.slice().sort((a, b) => {
      const aIndex = indexMap.has(a.id) ? indexMap.get(a.id) : Number.MAX_SAFE_INTEGER;
      const bIndex = indexMap.has(b.id) ? indexMap.get(b.id) : Number.MAX_SAFE_INTEGER;
      if (aIndex !== bIndex) return aIndex - bIndex;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  function filterBookmarks(state, selection, query) {
    const selected = selection || { kind: 'all' };
    const search = normalizeWhitespace(query).toLocaleLowerCase('zh-CN');
    const filtered = Object.values(state.bookmarks || {})
      .filter(isCollected)
      .filter((bookmark) => matchesSelection(bookmark, selected))
      .filter((bookmark) => {
        if (!search) return true;
        const haystack = [
          bookmark.title,
          bookmark.label,
          bookmark.problemSetName,
          typeLabel(bookmark.type),
          bookmark.note,
          ...(bookmark.tags || []),
        ].join('\n').toLocaleLowerCase('zh-CN');
        return haystack.includes(search);
      });
    return sortBookmarksByStoredOrder(filtered, state, selected);
  }

  function normalizeSubmissionStatus(value) {
    const text = normalizeWhitespace(value);
    if (!text) return 'pending';
    if (/等待|评测中|判题中|pending|queuing|judging/i.test(text)) return 'pending';
    if (/编译错误|compile\s*error|\bCE\b/i.test(text)) return 'CE';
    if (/运行超时|时间超限|time\s*limit|\bTLE\b/i.test(text)) return 'TLE';
    if (/内存超限|memory\s*limit|\bMLE\b/i.test(text)) return 'MLE';
    if (/运行错误|运行时错误|runtime\s*error|\bRE\b/i.test(text)) return 'RE';
    if (/格式错误|presentation\s*error|\bPE\b/i.test(text)) return 'PE';
    if (/部分正确|部分通过|partial|partially\s*accepted|\bPA\b/i.test(text)) return 'partial';
    if (/答案正确|全部正确|满分|通过|accepted|\bAC\b/i.test(text)) return 'AC';
    if (/答案错误|wrong\s*answer|\bWA\b/i.test(text)) return 'WA';
    return text.slice(0, 32);
  }

  function extractScore(text) {
    const normalized = normalizeWhitespace(text);
    const labeledRatio = normalized.match(/(?:本题)?(?:得分|分数|成绩)[：:\s]*(\d+(?:\.\d+)?)\s*[/／]\s*(\d+(?:\.\d+)?)/i);
    if (labeledRatio) return { score: Number(labeledRatio[1]), maxScore: Number(labeledRatio[2]) };
    const score = normalized.match(/(?:本题)?(?:得分|分数|成绩)[：:\s]*(\d+(?:\.\d+)?)/i);
    if (score) return { score: Number(score[1]), maxScore: null };
    return { score: null, maxScore: null };
  }

  function detectAnswerVisibility(text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return 'unknown';
    if (/答案[^。\n]{0,12}(未公布|不公布)|不公布[^。\n]{0,12}答案|不予公布|答案未公开/i.test(normalized)) {
      return 'hidden';
    }
    if (/正确答案|参考答案|标准答案|答案与解析|答案解析|参考代码|official\s+answer/i.test(normalized)) {
      return 'revealed';
    }
    if (/仅[^。\n]{0,12}(成绩|分数)|只[^。\n]{0,12}(成绩|分数)|成绩[^。\n]{0,12}(不公布|未公布)|得分/i.test(normalized)) {
      return 'score-only';
    }
    return 'unknown';
  }

  function computeContentHash(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function escapeMarkdown(value) {
    return String(value == null ? '' : value).replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
  }

  function formatDate(timestamp) {
    const value = Number(timestamp);
    if (!value) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(value));
    } catch (error) {
      return new Date(value).toLocaleString();
    }
  }

  function statusSummary(bookmark) {
    const submissions = bookmark.submissions || [];
    if (!submissions.length) return '无提交记录';
    const latest = submissions[0];
    const scoreText = latest.score != null
      ? `${latest.score}${latest.maxScore != null ? `/${latest.maxScore}` : ''}`
      : latest.rawStatus || latest.status;
    return `${latest.status}${scoreText ? ` · ${scoreText}` : ''}`;
  }

  function buildAnswerSummary(answer) {
    const normalized = normalizeAnswer(answer);
    if (normalized.officialAnswer) return normalized.officialAnswer;
    if (normalized.userAnswer && normalized.visibility === 'score-only') return `我的答案：${normalized.userAnswer}`;
    if (normalized.visibility === 'hidden') return '答案未公布';
    if (normalized.visibility === 'score-only') return 'PTA 仅公布成绩，未提供具体答案';
    if (normalized.visibility === 'revealed') return '答案已公布';
    return '答案状态未知';
  }

  function toMarkdown(state, snapshots, options) {
    const opts = options || {};
    const snapshotMap = snapshots || {};
    const includeAnswers = opts.includeAnswers !== false;
    const includeCode = Boolean(opts.includeCode);
    const lines = [
      '---',
      'title: PTA 收藏夹',
      `generated: ${new Date().toISOString()}`,
      `bookmarks: ${Object.keys(state.bookmarks || {}).length}`,
      '---',
      '',
      '# PTA 收藏夹',
      '',
    ];

    const collectedBookmarks = Object.values(state.bookmarks || {}).filter(isCollected);
    lines.push('## 收藏夹组织', '');
    listOrderedFolders(state).forEach((folder) => {
        lines.push(`### ${escapeMarkdown(folder.name)}`, '');
        const items = sortBookmarksByStoredOrder(
          collectedBookmarks.filter((bookmark) => (bookmark.folderIds || []).includes(folder.id)),
          state,
          { kind: 'user', folderId: folder.id },
        );
        if (!items.length) {
          lines.push('暂无题目', '');
          return;
        }
        items.forEach((bookmark) => {
            const checkbox = bookmark.status === 'done' ? 'x' : ' ';
            const label = bookmark.label ? `\`${escapeMarkdown(bookmark.label)}\` ` : '';
            lines.push(`- [${checkbox}] ${label}[${escapeMarkdown(bookmark.title)}](${bookmark.url})`);
          });
        lines.push('');
      });

    lines.push('## 按题目集', '');
    const sets = new Map();
    Object.values(state.bookmarks || {}).filter(isCollected).forEach((bookmark) => {
      const key = bookmark.problemSetId || bookmark.problemSetName || '未命名题目集';
      if (!sets.has(key)) sets.set(key, { name: bookmark.problemSetName || '未命名题目集', items: [] });
      sets.get(key).items.push(bookmark);
    });

    Array.from(sets.values())
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      .forEach((problemSet) => {
        lines.push(`### ${escapeMarkdown(problemSet.name)}`, '');
        const types = new Map();
        problemSet.items.forEach((bookmark) => {
          const type = normalizeProblemType(bookmark.type);
          if (!types.has(type)) types.set(type, []);
          types.get(type).push(bookmark);
        });

        Array.from(types.entries())
          .sort((a, b) => typeLabel(a[0]).localeCompare(typeLabel(b[0]), 'zh-CN'))
          .forEach(([type, items]) => {
            lines.push(`#### ${typeLabel(type)}`, '');
            items
              .sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-CN', { numeric: true }))
              .forEach((bookmark) => {
                const checkbox = bookmark.status === 'done' ? 'x' : ' ';
                const label = bookmark.label ? `\`${escapeMarkdown(bookmark.label)}\` ` : '';
                lines.push(`- [${checkbox}] ${label}[${escapeMarkdown(bookmark.title)}](${bookmark.url})`);
                lines.push(`  - 状态：${statusLabel(bookmark.status)}`);
                if (bookmark.tags && bookmark.tags.length) {
                  lines.push(`  - 标签：${bookmark.tags.map((tag) => `\`${escapeMarkdown(tag)}\``).join('、')}`);
                }
                if (bookmark.content && bookmark.content.capturedAt) {
                  lines.push(`  - 快照：${formatDate(bookmark.content.capturedAt)} · ${bookmark.content.status === 'full' ? '完整' : '部分'}`);
                }
                lines.push(`  - 判题：${statusSummary(bookmark)}`);
                if (includeAnswers) lines.push(`  - 答案：${buildAnswerSummary(bookmark.answer)}`);
                if (bookmark.note) lines.push(`  - 备注：${bookmark.note.replace(/\n/g, '\n    ')}`);
                const snapshot = snapshotMap[bookmark.id];
                if (snapshot && snapshot.markdown) {
                  lines.push('', '<details>', '<summary>本地题目快照</summary>', '', snapshot.markdown.trim(), '', '</details>');
                }
                if (includeCode) {
                  (bookmark.submissions || []).forEach((submission, index) => {
                    lines.push('', `<details>`, `<summary>提交 ${index + 1} · ${escapeMarkdown(submission.language)} · ${escapeMarkdown(submission.status)}</summary>`, '');
                    lines.push('```' + String(submission.language || '').replace(/[^\w+#.-]/g, '').toLowerCase());
                    lines.push(submission.code || '');
                    lines.push('```', '', '</details>');
                  });
                }
                lines.push('');
              });
          });
      });

    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  function toPortableJson(state, snapshots) {
    const memberships = {};
    const orderedFolders = listOrderedFolders(state);
    orderedFolders.forEach((folder) => {
      const items = sortBookmarksByStoredOrder(
        Object.values(state.bookmarks || {}).filter((bookmark) => isCollected(bookmark) && (bookmark.folderIds || []).includes(folder.id)),
        state,
        { kind: 'user', folderId: folder.id },
      );
      memberships[folder.id] = items.map((bookmark) => bookmark.id);
    });
    const folders = {};
    orderedFolders.forEach((folder) => {
      folders[folder.id] = { ...folder, bookmarkIds: memberships[folder.id] || [] };
    });
    return JSON.stringify({
      format: 'pta-favorites-export',
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      state,
      folders,
      memberships,
      snapshots: snapshots || {},
    }, null, 2);
  }

  function fromPortableJson(value) {
    const parsed = typeof value === 'string' ? safeJsonParse(value, null) : value;
    if (!parsed || typeof parsed !== 'object') throw new Error('不是有效的收藏备份文件');
    if (parsed.format === 'pta-favorites-export') {
      return {
        state: migrateState(parsed.state),
        snapshots: parsed.snapshots && typeof parsed.snapshots === 'object' ? parsed.snapshots : {},
      };
    }
    return {
      state: migrateState(parsed.state || parsed),
      snapshots: parsed.snapshots && typeof parsed.snapshots === 'object' ? parsed.snapshots : {},
    };
  }

  return {
    SCHEMA_VERSION,
    STORAGE_VERSION,
    DEFAULT_FOLDER_ID,
    TYPE_LABELS,
    STATUS_LABELS,
    ANSWER_VISIBILITY_LABELS,
    DEFAULT_SHORTCUTS,
    now,
    uid,
    unique,
    clone,
    normalizeWhitespace,
    safeJsonParse,
    createInitialState,
    migrateState,
    normalizeProblemType,
    normalizeAi,
    typeLabel,
    statusLabel,
    answerVisibilityLabel,
    inferProblemType,
    inferProblemLabel,
    cleanProblemTitle,
    parseProblemUrl,
    makeBookmarkKey,
    createBookmark,
    ensureFolder,
    mergeBookmark,
    mergeSubmissions,
    upsertBookmarkInState,
    removeBookmarkFromState,
    createFolder,
    renameFolder,
    deleteFolder,
    listOrderedFolders,
    listUserFolders,
    groupBookmarks,
    isCollected,
    matchesSelection,
    bookmarkOrderKey,
    sortBookmarksByStoredOrder,
    filterBookmarks,
    normalizeSubmissionStatus,
    extractScore,
    detectAnswerVisibility,
    computeContentHash,
    escapeMarkdown,
    formatDate,
    statusSummary,
    buildAnswerSummary,
    toMarkdown,
    toPortableJson,
    fromPortableJson,
  };
});

/* PTA page integration and UI. */
(function () {
  'use strict';

  const Core = globalThis.PTAF_CORE;
  if (!Core) {
    console.error('[PTA 收藏夹] 核心模块加载失败');
    return;
  }

  if (globalThis.__PTA_FAVORITES_LOADED__) return;
  globalThis.__PTA_FAVORITES_LOADED__ = true;

  const STORAGE_KEY = 'pta-favorites:state:v1';
  const SNAPSHOT_STORAGE_PREFIX = 'pta-favorites:snapshot:';
  const DB_NAME = 'pta-favorites-content';
  const DB_VERSION = 1;
  const DB_STORE = 'snapshots';
  const APP_VERSION = '0.36.2';
  const HOST_ID = 'ptaf-root';
  const STAR_ATTR = 'data-ptaf-star';
  const LOG_PREFIX = '[PTA 收藏夹]';
  const AI_KEY_STORAGE = 'pta-favorites:ai-key:v1';
  const PROJECT_LINKS = {
    repository: 'https://github.com/UIM258/PTA-Pro',
    script: 'https://raw.githubusercontent.com/UIM258/PTA-Pro/main/outputs/pta-favorites.user.js',
    issues: 'https://github.com/UIM258/PTA-Pro/issues',
    greasyfork: 'https://greasyfork.org/zh-CN/scripts/595643-pta-%E6%94%B6%E8%97%8F%E5%A4%B9',
  };
  const AI_PROVIDERS = {
    '': { label: '自定义', baseUrl: '' },
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
    deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
    openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
    aliyun: { label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
    lmstudio: { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  };
  const AI_SKILLS = {
    'analyze-problem': { label: '简要解析', category: 'reference', persist: true, target: 'analysis', prompt: '请根据提供的题目资料给出简洁、严谨的题意解析。说明关键条件、解题方向和常见错误。不要编造隐藏条件。' },
    'reference-solution': { label: '参考答案', category: 'reference', persist: true, target: 'answer', prompt: '请生成适合复习的参考答案。先给结论和思路，再给必要推导或参考实现、复杂度与边界情况。不要声称一定能通过隐藏测试。' },
    'knowledge-points': { label: '知识点', category: 'reference', persist: true, target: 'knowledgePoints', prompt: '请提取题目涉及的核心知识点、辅助知识点、易错点和复习建议。使用简明 Markdown。' },
    'review-my-code': { label: '检查我的代码', category: 'personal', persist: false, target: 'ephemeral', prompt: '请检查用户当前答案或代码。只指出具体问题、最小修改建议和可能遗漏的边界，不要默认重写全部代码。' },
    'hint-progression': { label: '渐进提示', category: 'personal', persist: false, target: 'ephemeral', prompt: '请按三个层次给出提示：思考方向、关键结构或算法、接近实现的步骤。不要直接给完整答案，除非题目已经无法继续推进。' },
    'debug-compile-error': { label: '解释编译错误', category: 'personal', persist: false, target: 'ephemeral', prompt: '请解释编译器输出中的错误，指出具体代码位置和根本原因，并给出最小修改方案。' },
    'generate-edge-cases': { label: '生成边界测试', category: 'personal', persist: false, target: 'ephemeral', prompt: '请根据题目和当前代码生成边界测试思路，覆盖空输入、极值、重复和特殊格式，并说明每个测试验证什么。' },
  };

  const SHORTCUT_ACTIONS = {
    toggleDrawer: '打开/关闭收藏夹',
    toggleCurrentFavorite: '收藏/取消收藏当前题目',
    toggleBatchMode: '切换批量管理',
    editSnapshotAnswer: '编辑快照中的我的作答',
    snapshotPrev: '快照上一题',
    snapshotNext: '快照下一题',
    snapshotSingle: '快照单栏查看',
    snapshotSplit: '快照并排查看',
  };

  function log() {
    console.debug(LOG_PREFIX, ...arguments);
  }

  function warn() {
    console.warn(LOG_PREFIX, ...arguments);
  }

  function storageGet(key, fallbackValue) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallbackValue);
      const value = localStorage.getItem(key);
      return value == null ? fallbackValue : value;
    } catch (error) {
      warn('读取存储失败', error);
      return fallbackValue;
    }
  }

  function storageSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }
      localStorage.setItem(key, value);
    } catch (error) {
      warn('写入存储失败', error);
      throw error;
    }
  }

  function storageDelete(key) {
    try {
      if (typeof GM_deleteValue === 'function') {
        GM_deleteValue(key);
        return;
      }
      localStorage.removeItem(key);
    } catch (error) {
      warn('删除存储失败', error);
    }
  }

  function getAiKey() {
    return String(storageGet(AI_KEY_STORAGE, '') || '');
  }

  function setAiKey(value) {
    storageSet(AI_KEY_STORAGE, String(value || ''));
  }

  function aiEndpoint(baseUrl) {
    const value = String(baseUrl || '').replace(/\/+$/, '');
    if (!value) return '';
    return /\/chat\/completions$/i.test(value) ? value : value + '/chat/completions';
  }

  function normalizeAiBaseUrl(value) {
    let url = String(value || '').trim();
    if (!url) return '';
    url = url.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
    if (/^api\.openai\.com$/i.test(url)) url = 'https://api.openai.com/v1';
    if (/^api\.deepseek\.com$/i.test(url)) url = 'https://api.deepseek.com/v1';
    if (/^openrouter\.ai$/i.test(url)) url = 'https://openrouter.ai/api/v1';
    try {
      const parsed = new URL(url);
      const knownHosts = ['api.openai.com', 'api.deepseek.com', 'openrouter.ai'];
      if (knownHosts.includes(parsed.hostname) && !/\/v1$/i.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(/\/$/, '') + '/v1';
        return parsed.toString().replace(/\/$/, '');
      }
    } catch (error) {}
    return url;
  }

  function requestAiModels(settings, apiKey) {
    const baseUrl = normalizeAiBaseUrl(settings.baseUrl);
    if (!baseUrl) return Promise.reject(new Error('请先填写 API Base URL'));
    const endpoint = baseUrl.replace(/\/+$/, '') + '/models';
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;

    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: endpoint,
          headers,
          timeout: Number(settings.timeoutMs) || 60000,
          onload: (response) => {
            try {
              const data = JSON.parse(response.responseText || '{}');
              if (response.status < 200 || response.status >= 300) {
                reject(new Error(data.error && data.error.message ? data.error.message : `HTTP ${response.status}`));
                return;
              }
              const models = (data.data || data.models || []).map((item) => typeof item === 'string' ? item : item.id || item.name).filter(Boolean);
              resolve(Array.from(new Set(models)));
            } catch (error) {
              reject(error);
            }
          },
          onerror: () => reject(new Error('获取模型列表失败')),
          ontimeout: () => reject(new Error('获取模型列表超时')),
        });
      });
    }

    return fetch(endpoint, { headers }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error && data.error.message ? data.error.message : `HTTP ${response.status}`);
      return Array.from(new Set((data.data || data.models || []).map((item) => typeof item === 'string' ? item : item.id || item.name).filter(Boolean)));
    });
  }

  function requestAiCompletion(action, contextText, options) {
    const opts = options || {};
    const settings = opts.settings || {};
    const endpoint = aiEndpoint(settings.baseUrl);
    if (!endpoint) return Promise.reject(new Error('请先配置 AI API 地址'));
    if (!settings.model) return Promise.reject(new Error('请先配置 AI 模型名称'));
    const skill = AI_SKILLS[action];
    if (!skill) return Promise.reject(new Error('未知的 AI 操作'));
    const systemPrompt = [
      '你是程序设计课程的学习助手。',
      '只根据用户提供的题目、作答、代码和 PTA 可见评测结果分析。',
      '不要编造隐藏测试点，不要声称代码一定通过 PTA。',
      '输出使用清晰、简洁的中文 Markdown。',
      skill.prompt,
    ].join('\n');
    const payload = {
      model: settings.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: contextText },
      ],
      temperature: Number(settings.temperature) >= 0 ? Number(settings.temperature) : 0.2,
      max_tokens: Number(settings.maxTokens) || 2500,
    };
    const headers = { 'Content-Type': 'application/json' };
    if (opts.apiKey) headers.Authorization = 'Bearer ' + opts.apiKey;

    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url: endpoint,
          headers,
          data: JSON.stringify(payload),
          timeout: Number(settings.timeoutMs) || 60000,
          onload: (response) => {
            try {
              const data = JSON.parse(response.responseText || '{}');
              if (response.status < 200 || response.status >= 300) {
                reject(new Error(data.error && data.error.message ? data.error.message : `HTTP ${response.status}`));
                return;
              }
              const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
              if (!content) reject(new Error('模型没有返回有效内容'));
              else resolve(String(content));
            } catch (error) {
              reject(error);
            }
          },
          onerror: () => reject(new Error('AI API 请求失败')),
          ontimeout: () => reject(new Error('AI API 请求超时')),
        });
      });
    }

    return fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error && data.error.message ? data.error.message : `HTTP ${response.status}`);
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('模型没有返回有效内容');
      return String(content);
    });
  }

  class AppStore {
    constructor() {
      const raw = storageGet(STORAGE_KEY, '');
      this.state = Core.migrateState(Core.safeJsonParse(raw, null));
      this.listeners = new Set();
      this.saveTimer = null;
    }

    get bookmarkCount() {
      return Object.values(this.state.bookmarks || {}).filter(Core.isCollected).length;
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    emit() {
      this.listeners.forEach((listener) => listener(this.state));
    }

    save(immediate) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      const commit = () => {
        this.saveTimer = null;
        this.state.updatedAt = Date.now();
        storageSet(STORAGE_KEY, JSON.stringify(this.state));
        this.emit();
      };
      if (immediate) commit();
      else this.saveTimer = setTimeout(commit, 180);
    }

    upsert(bookmark, options) {
      const saved = Core.upsertBookmarkInState(this.state, bookmark, options || {});
      bookmark.folderIds.forEach((folderId) => Core.ensureFolder(this.state, folderId));
      this.save(true);
      return saved;
    }

    remove(bookmarkId) {
      const removed = Core.removeBookmarkFromState(this.state, bookmarkId);
      if (removed) this.save(true);
      return removed;
    }

    addFolder(name, parentId) {
      const folder = Core.createFolder(this.state, name, parentId);
      this.save(true);
      return folder;
    }

    renameFolder(folderId, name) {
      const changed = Core.renameFolder(this.state, folderId, name);
      if (changed) this.save(true);
      return changed;
    }

    deleteFolder(folderId) {
      const changed = Core.deleteFolder(this.state, folderId);
      if (changed) this.save(true);
      return changed;
    }

    setStatuses(bookmarkIds, status) {
      const ids = Core.unique(bookmarkIds || []);
      ids.forEach((bookmarkId) => {
        const bookmark = this.state.bookmarks[bookmarkId];
        if (!bookmark || !Core.isCollected(bookmark)) return;
        bookmark.status = Core.STATUS_LABELS[status] ? status : 'todo';
        bookmark.updatedAt = Date.now();
      });
      this.state.updatedAt = Date.now();
      this.save(true);
    }

    toggleSetting(key) {
      this.state.settings[key] = !this.state.settings[key];
      this.save(true);
      return this.state.settings[key];
    }

    updateBookmark(bookmarkId, patch) {
      const bookmark = this.state.bookmarks[bookmarkId];
      if (!bookmark) return null;
      Object.assign(bookmark, patch || {});
      bookmark.folderIds = Core.unique(bookmark.folderIds || []);
      bookmark.tags = Core.unique(bookmark.tags || []);
      bookmark.updatedAt = Date.now();
      this.state.updatedAt = Date.now();
      this.save(true);
      return bookmark;
    }
  }

  class SnapshotStore {
    constructor() {
      this.dbPromise = null;
      this.fallback = typeof indexedDB === 'undefined';
    }

    open() {
      if (this.fallback) return Promise.resolve(null);
      if (this.dbPromise) return this.dbPromise;
      this.dbPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.fallback = true;
          resolve(null);
        }, 1500);
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(DB_STORE)) {
            db.createObjectStore(DB_STORE, { keyPath: 'bookmarkId' });
          }
        };
        request.onsuccess = () => {
          clearTimeout(timeout);
          resolve(request.result);
        };
        request.onerror = () => {
          clearTimeout(timeout);
          reject(request.error);
        };
      }).catch((error) => {
        this.fallback = true;
        warn('IndexedDB 不可用，将回退到 GM 存储', error);
        return null;
      });
      return this.dbPromise;
    }

    async put(snapshot) {
      if (!snapshot || !snapshot.bookmarkId) return;
      const db = await this.open();
      if (!db) {
        storageSet(SNAPSHOT_STORAGE_PREFIX + snapshot.bookmarkId, JSON.stringify(snapshot));
        return;
      }
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(DB_STORE, 'readwrite');
        transaction.objectStore(DB_STORE).put(snapshot);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    }

    async get(bookmarkId) {
      const db = await this.open();
      if (!db) {
        const raw = storageGet(SNAPSHOT_STORAGE_PREFIX + bookmarkId, '');
        return Core.safeJsonParse(raw, null);
      }
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(DB_STORE, 'readonly');
        const request = transaction.objectStore(DB_STORE).get(bookmarkId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    }

    async remove(bookmarkId) {
      const db = await this.open();
      if (!db) {
        storageDelete(SNAPSHOT_STORAGE_PREFIX + bookmarkId);
        return;
      }
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(DB_STORE, 'readwrite');
        transaction.objectStore(DB_STORE).delete(bookmarkId);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    }

    async all() {
      const db = await this.open();
      if (!db) {
        const result = {};
        Object.keys(localStorage).forEach((key) => {
          if (!key.startsWith(SNAPSHOT_STORAGE_PREFIX)) return;
          const snapshot = Core.safeJsonParse(localStorage.getItem(key), null);
          if (snapshot && snapshot.bookmarkId) result[snapshot.bookmarkId] = snapshot;
        });
        return result;
      }
      return new Promise((resolve, reject) => {
        const result = {};
        const transaction = db.transaction(DB_STORE, 'readonly');
        const request = transaction.objectStore(DB_STORE).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(result);
            return;
          }
          const value = cursor.value;
          if (value && value.bookmarkId) result[value.bookmarkId] = value;
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    }

    async importMany(snapshots) {
      const entries = Object.entries(snapshots || {});
      for (const [bookmarkId, snapshot] of entries) {
        await this.put({ ...snapshot, bookmarkId: snapshot.bookmarkId || bookmarkId });
      }
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function highlightCode(code, language) {
    const languageText = String(language || '').toLowerCase();
    const keywords = new Set([
      'auto', 'break', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'delete',
      'do', 'double', 'else', 'enum', 'explicit', 'extern', 'false', 'float', 'for', 'friend',
      'if', 'inline', 'int', 'long', 'namespace', 'new', 'nullptr', 'private', 'protected', 'public',
      'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw',
      'true', 'try', 'typedef', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile',
      'while', 'bool', 'String', 'System', 'print', 'println', 'def', 'elif', 'except', 'finally',
      'from', 'import', 'lambda', 'None', 'not', 'or', 'and', 'in', 'is', 'with', 'yield', 'async',
      'await', 'package', 'extends', 'implements', 'interface', 'is', 'func', 'range', 'make', 'map',
    ]);
    const isPython = /python|py\b/i.test(languageText);
    const tokenPattern = isPython
      ? /(#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g
      : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[A-Za-z_]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g;
    let result = '';
    let lastIndex = 0;
    let match;
    while ((match = tokenPattern.exec(code)) !== null) {
      result += escapeHtml(code.slice(lastIndex, match.index));
      const token = match[0];
      let className = '';
      if (token.startsWith('//') || token.startsWith('/*') || (isPython && token.startsWith('#'))) className = 'token-comment';
      else if (token.startsWith('#')) className = 'token-preprocessor';
      else if (/^["']/.test(token)) className = 'token-string';
      else if (/^\d/.test(token)) className = 'token-number';
      else if (keywords.has(token)) className = 'token-keyword';
      else if (/^[A-Za-z_]/.test(token)) {
        const next = code.slice(tokenPattern.lastIndex).match(/^\s*\(/);
        className = next ? 'token-function' : 'token-identifier';
      }
      result += className ? `<span class="${className}">${escapeHtml(token)}</span>` : escapeHtml(token);
      lastIndex = tokenPattern.lastIndex;
    }
    result += escapeHtml(code.slice(lastIndex));
    return result;
  }

  function codeBlockHtml(code, language) {
    const codeText = String(code || '');
    const languageLabel = language || '代码';
    const lineNumbers = codeText.split('\n').map((line, index) => index + 1).join('\n');
    return `<div class="ptaf-code-viewer">
      <div class="ptaf-code-viewer-head"><span>[ ${escapeHtml(languageLabel)} ]</span><button class="ptaf-btn small" type="button" data-ptaf-copy-code>复制</button></div>
      <div class="ptaf-code-viewer-body">
        <pre class="ptaf-code-line-numbers" aria-hidden="true">${lineNumbers}</pre>
        <pre class="ptaf-code-content"><code>${highlightCode(codeText, languageLabel)}</code></pre>
      </div>
    </div>`;
  }
  function snapshotCodeBlockHtml(code, language) {
    const codeText = String(code || '');
    const label = language || '代码';
    const lineNumbers = codeText.split('\n').map((line, index) => index + 1).join('\n');
    return `<div class="ptaf-snapshot-code">
      <div class="ptaf-snapshot-code-head">[ ${escapeHtml(label)} ]</div>
      <div class="ptaf-snapshot-code-body">
        <pre class="ptaf-snapshot-line-numbers">${lineNumbers}</pre>
        <pre class="ptaf-snapshot-code-content"><code>${highlightCode(codeText, label)}</code></pre>
      </div>
    </div>`;
  }

  function safeFileName(value) {
    return String(value || 'export')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'export';
  }

  function renderInlineMarkdown(value) {
    let html = escapeHtml(value);
    html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return html;
  }

  function renderMarkdownHtml(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }
      if (/^\s*```/.test(line)) {
        const language = line.replace(/^\s*```/, '').trim();
        index += 1;
        const code = [];
        while (index < lines.length && !/^\s*```/.test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        output.push(`<pre class="ptaf-md-code"><code data-language="${escapeHtml(language)}">${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = Math.min(6, heading[1].length);
        output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
          items.push(`<li>${renderInlineMarkdown(lines[index].replace(/^\s*[-*]\s+/, ''))}</li>`);
          index += 1;
        }
        output.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        const quote = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          quote.push(lines[index].replace(/^\s*>\s?/, ''));
          index += 1;
        }
        output.push('<blockquote>' + quote.map(renderInlineMarkdown).join('<br>') + '</blockquote>');
        continue;
      }
      const paragraph = [line];
      index += 1;
      while (index < lines.length && lines[index].trim() && !/^(#{1,6})\s+/.test(lines[index]) && !/^\s*[-*]\s+/.test(lines[index]) && !/^\s*```/.test(lines[index]) && !/^\s*>\s?/.test(lines[index])) {
        paragraph.push(lines[index]);
        index += 1;
      }
      output.push('<p>' + paragraph.map(renderInlineMarkdown).join('<br>') + '</p>');
    }
    return output.join('');
  }

  function aiReferenceHtml(value) {
    const ai = Core.normalizeAi(value);
    if (!ai.analysis && !ai.answer && !ai.referenceCode && !ai.knowledgePoints.length && !ai.complexity.time && !ai.complexity.space) return "";
    const parts = [];
    const section = (field, title, content) => `<section class="ptaf-ai-reference-section"><div class="ptaf-ai-reference-section-head"><strong>${title}</strong><button class="ptaf-btn small danger" type="button" data-ptaf-ai-delete-field="${field}">删除</button></div>${content}</section>`;
    if (ai.analysis) parts.push(section("analysis", "题意解析", `<div class="ptaf-markdown">${renderMarkdownHtml(ai.analysis)}</div>`));
    if (ai.answer) parts.push(section("answer", "参考答案", `<div class="ptaf-markdown">${renderMarkdownHtml(ai.answer)}</div>`));
    if (ai.referenceCode) parts.push(section("referenceCode", "参考代码", `<pre>${escapeHtml(ai.referenceCode)}</pre>`));
    if (ai.knowledgePoints.length) parts.push(section("knowledgePoints", "知识点", `<div class="ptaf-markdown"><ul>${ai.knowledgePoints.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul></div>`));
    const complexityText = [ai.complexity.time ? `时间：${ai.complexity.time}` : "", ai.complexity.space ? `空间：${ai.complexity.space}` : ""].filter(Boolean).join("；");
    if (complexityText) parts.push(section("complexity", "复杂度", escapeHtml(complexityText)));
    return `<div class="ptaf-ai-reference"><div class="ptaf-ai-reference-head"><span class="ptaf-badge warning">AI 生成</span><span>${escapeHtml(ai.model || "未知模型")} · ${escapeHtml(Core.formatDate(ai.generatedAt))}</span><button class="ptaf-btn small danger" type="button" data-ptaf-ai-reference-delete>删除全部</button></div><div class="ptaf-ai-reference-body">${parts.join("")}</div></div>`;
  }
  function debounce(fn, delay) {
    let timer = null;
    return function debounced() {
      const args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn.apply(null, args);
      }, delay);
    };
  }

  function nextFrame() {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 120);
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function isOurElement(element) {
    if (!element) return false;
    return Boolean(element.closest && element.closest(`#${HOST_ID}, [${STAR_ATTR}]`));
  }

  function downloadText(filename, content, type) {
    const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.documentElement.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      anchor.remove();
    }, 1000);
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file, 'utf-8');
    });
  }

  function visibleText(element) {
    if (!element) return '';
    return Core.normalizeWhitespace(element.innerText || element.textContent || '');
  }

  function uniqueSelectorRoots(selectors) {
    const roots = [];
    selectors.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((element) => {
          if (!roots.includes(element) && !isOurElement(element)) roots.push(element);
        });
      } catch (error) {
        // Ignore invalid selectors supplied by future site variants.
      }
    });
    return roots;
  }

  function findContentRoot(title, problemId) {
    if (problemId) {
      const exactCard = document.getElementById(problemId);
      if (exactCard) return exactCard;
    }

    const titleText = Core.normalizeWhitespace(title);
    const splitContent = document.querySelector('[data-split-area="true"] > [class*="left_"]');
    if (splitContent && (!titleText || visibleText(splitContent).includes(titleText))) return splitContent;
    const leftContent = document.querySelector('main [class*="left_"]');
    if (leftContent && (!titleText || visibleText(leftContent).includes(titleText))) return leftContent;

    const preferred = uniqueSelectorRoots([
      '[data-split-area="true"] > [class*="left_"]',
      '[class*="left_"]',
      '[class*="problem-content"]',
      '[class*="problemContent"]',
      '[class*="problem-detail"]',
      '[class*="problemDetail"]',
      '[class*="question-content"]',
      '[class*="questionContent"]',
      'article',
      'main',
      '[role="main"]',
    ]);

    if (preferred.length) {
      const withTitle = preferred.filter((element) => visibleText(element).includes(titleText));
      const candidates = withTitle.length ? withTitle : preferred;
      return candidates
        .map((element) => ({ element, length: visibleText(element).length }))
        .sort((a, b) => b.length - a.length)[0].element;
    }

    const fallback = document.querySelector('#app main, #app article, body');
    return fallback || document.body;
  }

  function sanitizedClone(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('script, style, link, noscript, template, iframe, object, embed, form, [data-ptaf], #ptaf-root').forEach((node) => node.remove());
    clone.querySelectorAll('button, [role="button"], .pc-button').forEach((node) => {
      const label = Core.normalizeWhitespace(visibleText(node));
      if (['复制内容', '格式', '全屏', '收起'].some((value) => label.includes(value))) node.remove();
    });
    clone.querySelectorAll('*').forEach((node) => {
      Array.from(node.attributes || []).forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const value = String(attribute.value || '').trim();
        if (name.startsWith('on') || name === 'srcdoc') node.removeAttribute(attribute.name);
        if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^javascript:/i.test(value)) node.removeAttribute(attribute.name);
      });
    });
    clone.querySelectorAll('[aria-hidden="true"]').forEach((node) => {
      if (!visibleText(node)) node.remove();
    });

    const replacedEditors = new Set();
    clone.querySelectorAll('.codeEditor_WDyZc, .cm-editor').forEach((editor) => {
      const holder = editor.closest('[data-code]') || editor.closest('.codeEditor_WDyZc') || editor;
      if (replacedEditors.has(holder)) return;
      replacedEditors.add(holder);
      const code = readCodeElement(editor);
      if (!code.trim()) return;
      let label = holder.getAttribute && holder.getAttribute('data-lang') || '';
      const context = holder.parentElement ? String(holder.parentElement.innerText || holder.parentElement.textContent || '') : '';
      const languageMatch = context.match(/\[\s*((?:C\+\+|C|Java|Python|Go|JavaScript)[^\]]*)\s*\]/i);
      if (!label && languageMatch) label = languageMatch[1];
      const template = document.createElement('template');
      template.innerHTML = snapshotCodeBlockHtml(code, label || '代码');
      const replacement = template.content.firstElementChild;
      if (replacement) holder.replaceWith(replacement);
    });
    return clone;
  }

  function prepareSnapshotHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html || '';
    template.content.querySelectorAll('script, iframe, object, embed, form').forEach((node) => node.remove());
    template.content.querySelectorAll('button, [role="button"], .pc-button').forEach((node) => {
      const label = Core.normalizeWhitespace(visibleText(node));
      if (['复制内容', '格式', '全屏', '收起'].some((value) => label.includes(value))) node.remove();
    });
    template.content.querySelectorAll('*').forEach((node) => {
      Array.from(node.attributes || []).forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const value = String(attribute.value || '').trim();
        if (name.startsWith('on') || name === 'srcdoc') node.removeAttribute(attribute.name);
        if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^javascript:/i.test(value)) node.removeAttribute(attribute.name);
      });
    });
    return template.innerHTML;
  }

  function inlineMarkdown(text) {
    return Core.normalizeWhitespace(text)
      .replace(/\*\*(.*?)\*\*/g, '**$1**')
      .replace(/`([^`]+)`/g, '`$1`');
  }

  function markdownForNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    const children = () => Array.from(node.childNodes).map(markdownForNode).join('');

    if (tag === 'br') return '\n';
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return '';
    if (tag === 'img') {
      const alt = node.getAttribute('alt') || '图片';
      const src = node.getAttribute('src') || '';
      return src ? `![${alt}](${new URL(src, location.href).href})` : `[${alt}]`;
    }
    if (tag === 'a') {
      const text = Core.normalizeWhitespace(children());
      const href = node.getAttribute('href');
      if (!href) return text;
      try {
        return `[${text || new URL(href, location.href).href}](${new URL(href, location.href).href})`;
      } catch (error) {
        return text;
      }
    }
    if (tag === 'pre') {
      const code = node.innerText || node.textContent || '';
      const language = node.querySelector('code');
      const languageClass = language && language.className ? String(language.className).match(/language-([\w+#.-]+)/) : null;
      return `\n\n\`\`\`${languageClass ? languageClass[1] : ''}\n${code.trim()}\n\`\`\`\n\n`;
    }
    if (tag === 'code' && node.parentElement && node.parentElement.tagName.toLowerCase() !== 'pre') {
      return `\`${(node.textContent || '').replace(/`/g, '\\`')}\``;
    }
    if (tag === 'table') {
      const lines = [];
      node.querySelectorAll('tr').forEach((row) => {
        const cells = Array.from(row.querySelectorAll('th,td')).map((cell) => Core.normalizeWhitespace(cell.innerText || cell.textContent || ''));
        if (cells.length) lines.push(`| ${cells.join(' | ')} |`);
      });
      return `\n\n${lines.join('\n')}\n\n`;
    }
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${Core.normalizeWhitespace(children())}\n\n`;
    if (tag === 'li') return `\n- ${children().trim()}`;
    if (tag === 'ul' || tag === 'ol') return `\n${children()}\n`;
    if (tag === 'blockquote') return `\n> ${children().trim().replace(/\n/g, '\n> ')}\n`;
    if (tag === 'strong' || tag === 'b') return `**${children().trim()}**`;
    if (tag === 'em' || tag === 'i') return `*${children().trim()}*`;
    if (['div', 'section', 'article', 'main', 'p', 'tr'].includes(tag)) return `${children()}\n`;
    return children();
  }

  function htmlToMarkdown(element) {
    return Core.normalizeWhitespace(markdownForNode(element));
  }

  function choiceLabelText(element) {
    if (!element) return '';
    const clone = element.cloneNode(true);
    clone.querySelectorAll('.katex').forEach((katex) => {
      const annotation = katex.querySelector('annotation[encoding="application/x-tex"], annotation');
      const formula = annotation ? annotation.textContent : katex.textContent;
      katex.replaceWith(document.createTextNode(formula || ''));
    });
    return Core.normalizeWhitespace(clone.textContent);
  }

  function compactChoiceAnswer(labelText, input) {
    const textValue = Core.normalizeWhitespace(labelText);
    const optionMatch = textValue.match(/^([A-Z])[.、:：]\s*/i);
    if (optionMatch) {
      const body = textValue.slice(optionMatch[0].length).replace(/\s+/g, '');
      return `${optionMatch[1].toUpperCase()}.${body}`;
    }
    return textValue || input.value || '已选择';
  }

  function extractChoiceGroupsFromDom(root) {
    const groups = new Map();
    const promptRoot = root.querySelector('.rendered-markdown p, .rendered-markdown');
    const prompt = Core.normalizeWhitespace(visibleText(promptRoot)).slice(0, 500);
    root.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((input) => {
      const groupName = input.name || input.id || `group-${groups.size + 1}`;
      if (!groups.has(groupName)) groups.set(groupName, { name: groupName, kind: input.type, prompt, options: [] });
      let label = null;
      if (input.id) label = root.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (!label) label = input.closest('label');
      const labelText = choiceLabelText(label);
      const answer = compactChoiceAnswer(labelText, input);
      groups.get(groupName).options.push({
        value: input.value || answer,
        answer,
        label: answer,
        checked: input.checked,
      });
    });
    return Array.from(groups.values()).filter((group) => group.options.length);
  }

  function extractChoiceGroupsFromHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html || '';
    return extractChoiceGroupsFromDom(template.content);
  }

  function extractAnswersFromDom(root) {
    const answers = [];
    const usedInputs = new Set();
    const firstParagraph = root.querySelector('.rendered-markdown p, .rendered-markdown');
    const questionPrompt = Core.normalizeWhitespace(visibleText(firstParagraph)).slice(0, 500);

    root.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked').forEach((input) => {
      if (usedInputs.has(input)) return;
      usedInputs.add(input);
      let label = null;
      if (input.id) label = root.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (!label && input.closest('label')) label = input.closest('label');
      const labelText = choiceLabelText(label);
      const optionMatch = labelText.match(/^([A-Z])[.、:：]\s*/i);
      let answer = input.value || '已选择';
      if (optionMatch) {
        const optionBody = labelText.slice(optionMatch[0].length).replace(/\s+/g, '');
        answer = `${optionMatch[1].toUpperCase()}.${optionBody}`;
      }
      answers.push({
        kind: input.type,
        prompt: questionPrompt || '选择题',
        answer,
      });
    });

    root.querySelectorAll('textarea, input[type="text"], input[type="number"], select').forEach((field) => {
      if (field.closest(`#${HOST_ID}`)) return;
      const fieldContext = `${field.className || ''} ${field.id || ''} ${field.getAttribute('aria-label') || ''} ${field.closest('[class]') ? field.closest('[class]').className : ''}`;
      if (/code|editor|monaco|codemirror|source/i.test(fieldContext)) return;
      const value = field.tagName === 'SELECT'
        ? visibleText(field.options[field.selectedIndex])
        : field.value;
      if (!value) return;
      const container = field.closest('label, .form-item, [class*="question"], [class*="problem"], tr, li');
      const nearbyText = Core.normalizeWhitespace(visibleText(container));
      const prompt = questionPrompt || nearbyText.slice(0, 500);
      answers.push({
        kind: field.tagName.toLowerCase(),
        prompt: prompt || '填空题',
        answer: Core.normalizeWhitespace(value),
      });
    });

    return answers.filter((answer, index, items) => {
      const key = `${answer.kind}|${answer.prompt}|${answer.answer}`;
      return items.findIndex((item) => `${item.kind}|${item.prompt}|${item.answer}` === key) === index;
    });
  }
  function excerptAround(text, pattern, radius) {
    const normalized = Core.normalizeWhitespace(text);
    const match = normalized.match(pattern);
    if (!match || match.index == null) return '';
    const start = Math.max(0, match.index - 20);
    const end = Math.min(normalized.length, match.index + match[0].length + (radius || 260));
    return normalized.slice(start, end).trim();
  }

  function detectLanguage(text) {
    const source = String(text || '');
    const patterns = [
      ['C++', /\bC\+\+|\bCPP\b/i],
      ['C', /\bC\s*(?:语言|语言版本|编译器)\b|GCC/i],
      ['Java', /\bJava\b/i],
      ['Python', /\bPython\b/i],
      ['JavaScript', /\bJavaScript\b|\bNode\.js\b/i],
      ['Go', /\bGolang\b|\bGo\s*(?:语言|语言版本)\b/i],
    ];
    for (const [language, pattern] of patterns) {
      if (pattern.test(source)) return language;
    }
    return '未知语言';
  }

  function detectCompiler(text) {
    const normalized = Core.normalizeWhitespace(text);
    const match = normalized.match(/编译器[：:\s]*([^\n]+)/);
    if (match) return Core.normalizeWhitespace(match[1]);
    const bracketMatch = normalized.match(/\[\s*((?:C|C\+\+|Java|Python|Go|JavaScript)[^\]]*)\s*\]/i);
    return bracketMatch ? Core.normalizeWhitespace(bracketMatch[1]) : '';
  }

  function extractJudgeConstraints(root) {
    const text = visibleText(root || document.body);
    const valueAfter = (label) => {
      const match = text.match(new RegExp(label + '[：:\\s]*([^\\n]+)'));
      return match ? Core.normalizeWhitespace(match[1]) : '';
    };
    return {
      codeLengthLimit: valueAfter('代码长度限制'),
      timeLimit: valueAfter('时间限制'),
      memoryLimit: valueAfter('内存限制'),
      stackLimit: valueAfter('栈限制'),
    };
  }

  function readCodeElement(element) {
    if (!element) return '';
    if (element.tagName === 'TEXTAREA') return String(element.value || '').replace(/\r\n?/g, '\n');
    const lines = Array.from(element.querySelectorAll('.cm-line, .CodeMirror-line, .view-line'));
    const source = lines.length
      ? lines.map((line) => String(line.textContent || '')).join('\n')
      : String(element.textContent || '');
    return source.replace(/\u200b/g, '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
  }

  function findEditableCodeInPage(root) {
    const scope = root || document.body;
    const selectors = [
      '[class*="CodingProblemAnswerForm"] .cm-content[contenteditable="true"]',
      '.cm-content[contenteditable="true"]',
      '[class*="CodingProblemAnswerForm"] textarea',
      'textarea[class*="editor"]',
      'textarea[class*="code"]',
    ];
    const candidates = [];
    const seen = new Set();
    selectors.forEach((selector) => {
      let elements = [];
      try {
        elements = Array.from(scope.querySelectorAll(selector));
      } catch (error) {
        return;
      }
      elements.forEach((element) => {
        if (seen.has(element) || isOurElement(element)) return;
        seen.add(element);
        if (element.disabled || element.readOnly) return;
        const code = readCodeElement(element);
        if (!code.trim()) return;
        const inAnswerForm = element.closest('[class*="CodingProblemAnswerForm"]');
        candidates.push({ code, score: (inAnswerForm ? 100000 : 0) + code.length });
      });
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].code : '';
  }

  function findCodeInPage(root) {
    const scope = root || document.body;
    const selectors = [
      '[class*="CodingProblemAnswerForm"] .cm-content',
      '.cm-content[contenteditable="true"]',
      '.cm-content',
      'textarea',
      'pre code',
      '.CodeMirror-code',
      '.view-lines',
      '[class*="editor"] [class*="code"]',
    ];
    const candidates = [];
    const seen = new Set();
    selectors.forEach((selector) => {
      let elements = [];
      try {
        elements = Array.from(scope.querySelectorAll(selector));
      } catch (error) {
        return;
      }
      elements.forEach((element) => {
        if (seen.has(element) || isOurElement(element)) return;
        seen.add(element);
        const text = readCodeElement(element);
        if (text.trim().length < 8) return;
        const parentClass = element.parentElement ? String(element.parentElement.className || '') : '';
        const context = `${element.className || ''} ${element.id || ''} ${element.getAttribute('aria-label') || ''} ${parentClass}`;
        let score = text.length;
        if (element.closest('[class*="CodingProblemAnswerForm"]')) score += 100000;
        if (element.closest('.pc-modal[data-e2e="modal-mask"], .pc-modal')) score += 90000;
        if (/codeEditor|monaco|codemirror|source|editor/i.test(context)) score += 10000;
        if (element.closest('.readOnly_p3QDZ, [class*="readOnly"]')) score -= 1000;
        candidates.push({ text, score });
      });
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].text : '';
  }
  function extractTestPoints(root) {
    const points = [];
    (root || document.body).querySelectorAll('table').forEach((table) => {
      const headerCells = Array.from(table.querySelectorAll('thead th, thead td')).map((cell) => visibleText(cell));
      if (!headerCells.some((text) => /测试点|test\s*point/i.test(text))) return;
      const normalizedHeaders = headerCells.map((text) => text.replace(/\s+/g, '').toLowerCase());
      const findColumn = (pattern) => normalizedHeaders.findIndex((text) => pattern.test(text));
      const idIndex = findColumn(/测试点|testpoint/);
      const hintIndex = findColumn(/提示|hint/);
      const memoryIndex = findColumn(/内存|memory/);
      const timeIndex = findColumn(/用时|时间|time/);
      const resultIndex = findColumn(/结果|result/);
      const scoreIndex = findColumn(/得分|score/);

      table.querySelectorAll('tbody tr').forEach((row, rowIndex) => {
        const cells = Array.from(row.querySelectorAll('td, th')).map((cell) => visibleText(cell));
        if (!cells.length) return;
        const scoreText = scoreIndex >= 0 ? cells[scoreIndex] || '' : '';
        const scoreMatch = scoreText.match(/(\d+(?:\.\d+)?)\s*[/／]\s*(\d+(?:\.\d+)?)/);
        const numericScore = scoreText.match(/^(\d+(?:\.\d+)?)$/);
        points.push({
          id: idIndex >= 0 ? cells[idIndex] || String(rowIndex) : String(rowIndex),
          label: hintIndex >= 0 ? cells[hintIndex] || `测试点 ${rowIndex + 1}` : `测试点 ${rowIndex + 1}`,
          result: resultIndex >= 0 ? cells[resultIndex] || '' : '',
          score: scoreMatch ? Number(scoreMatch[1]) : numericScore ? Number(numericScore[1]) : null,
          maxScore: scoreMatch ? Number(scoreMatch[2]) : null,
          timeMs: timeIndex >= 0 && /^\d+$/.test(cells[timeIndex] || '') ? Number(cells[timeIndex]) : null,
          memoryKb: memoryIndex >= 0 && /^\d+$/.test(cells[memoryIndex] || '') ? Number(cells[memoryIndex]) : null,
          message: '',
        });
      });
    });
    return points.slice(0, 100);
  }
  function findSubmissionModal() {
    return Array.from(document.querySelectorAll('.pc-modal[data-e2e="modal-mask"], .pc-modal, [role="dialog"], [class*="modal"]'))
      .find((element) => /提交结果|评测详情|测试点/.test(visibleText(element))) || null;
  }

  function elementDepth(element) {
    let depth = 0;
    let node = element;
    while (node && node.parentElement) {
      depth += 1;
      node = node.parentElement;
    }
    return depth;
  }

  function extractTextSection(scope, headingText) {
    const candidates = Array.from((scope || document.body).querySelectorAll('*'))
      .filter((element) => Core.normalizeWhitespace(visibleText(element)) === headingText)
      .filter((element) => !Array.from(element.children).some((child) => Core.normalizeWhitespace(visibleText(child)) === headingText))
      .sort((a, b) => elementDepth(b) - elementDepth(a));
    const heading = candidates[0];
    if (!heading) return '';
    let node = heading;
    while (node && node.parentElement && node.parentElement !== scope) {
      node = node.parentElement;
      const sibling = node.nextElementSibling;
      if (sibling) {
        const text = Core.normalizeWhitespace(visibleText(sibling));
        if (text) return text;
      }
    }
    return '';
  }

  function findLastSubmissionButton() {
    return Array.from(document.querySelectorAll('button'))
      .find((button) => /查看上次提交|上次提交|Last Submission/i.test(visibleText(button))) || null;
  }

  function closeSubmissionModal() {
    const closeButton = document.querySelector('.pc-modal[data-e2e="modal-mask"] [data-e2e="modal-close-btn"], .pc-modal [data-e2e="modal-close-btn"]');
    if (closeButton) closeButton.click();
  }

  async function openLastSubmissionForCapture(bookmark, timeoutMs) {
    if (!bookmark || !['function', 'programming'].includes(Core.normalizeProblemType(bookmark.type))) return false;
    if ((bookmark.submissions || []).length || findSubmissionModal()) return false;
    const button = findLastSubmissionButton();
    if (!button) return false;
    button.click();
    const deadline = Date.now() + (timeoutMs || 6000);
    while (Date.now() < deadline) {
      if (findSubmissionModal()) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  function extractSubmissionFromPage(contentRoot, bookmark, captureMode) {
    const problemType = Core.normalizeProblemType(bookmark && bookmark.type);
    if (!['function', 'programming'].includes(problemType)) return null;
    const modal = findSubmissionModal();
    const scope = modal || contentRoot || document.body;
    const code = findCodeInPage(scope);
    const bodyText = visibleText(scope);
    const resultText = modal ? bodyText : bodyText.slice(-6000);
    const score = Core.extractScore(resultText);
    const status = Core.normalizeSubmissionStatus(resultText);
    const rawStatusMatch = resultText.match(/状态[：:\s]*(答案正确|答案错误|部分正确|编译错误|运行超时|内存超限|运行错误|格式错误)/);
    const rawStatus = rawStatusMatch ? rawStatusMatch[1] : status;
    const dateTimeMatch = resultText.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    const submittedAt = dateTimeMatch
      ? new Date(Number(dateTimeMatch[1]), Number(dateTimeMatch[2]) - 1, Number(dateTimeMatch[3]), Number(dateTimeMatch[4]), Number(dateTimeMatch[5]), Number(dateTimeMatch[6])).getTime()
      : Date.now();
    const compileOutput = extractTextSection(scope, '编译器输出')
      || excerptAround(resultText, /编译错误[\s\S]{0,1600}/i, 1600)
      || excerptAround(resultText, /compile\s*error[\s\S]{0,1600}/i, 1600);
    const testPoints = extractTestPoints(scope).slice(0, 100);
    const language = detectLanguage(resultText);
    const compiler = detectCompiler(resultText);
    const knownStatus = ['AC', 'partial', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'PE'].includes(status);
    const hasResultSignal = Boolean(modal)
      || knownStatus
      || /(?:得分|分数)\s*\d+(?:\.\d+)?\s*[/／]\s*\d+(?:\.\d+)?/.test(resultText)
      || testPoints.length > 0;
    const useful = hasResultSignal && (code.trim().length >= 8 || testPoints.length > 0 || knownStatus);

    if (!useful) return null;
    return {
      language,
      compiler,
      code,
      status,
      rawStatus,
      score: score.score,
      maxScore: score.maxScore,
      compileOutput,
      testPoints,
      submittedAt,
      capturedAt: Date.now(),
      captureMode: captureMode || 'manual',
    };
  }
  function extractAnswerMeta(root, problemId) {
    const text = visibleText(root);
    const classText = Array.from(root.querySelectorAll('[class]')).map((element) => String(element.className)).join(' ');
    const statusAnchor = problemId
      ? Array.from(document.querySelectorAll('a[href*="problemSetProblemId="]')).find((anchor) => {
          try {
            return new URL(anchor.href).searchParams.get('problemSetProblemId') === problemId;
          } catch (error) {
            return false;
          }
        })
      : null;
    const statusClassText = statusAnchor
      ? Array.from(statusAnchor.querySelectorAll('[class]')).map((element) => String(element.className)).join(' ')
      : '';
    const scored = text.match(/(?:本题)?得分[：:\s]*(\d+(?:\.\d+)?)/);
    const fullScore = text.match(/满分[：:\s]*(\d+(?:\.\d+)?)/);
    const totalScore = text.match(/分数[：:\s]*(\d+(?:\.\d+)?)/);
    const submissionStatus = /PROBLEM_SUBMITTED|已提交|submitted/i.test(`${classText} ${statusClassText} ${text}`) ? 'submitted' : '';
    let correct = null;
    const correctnessText = `${classText} ${statusClassText}`;
    if (/PROBLEM_CORRECT|回答正确|答案正确/.test(correctnessText)) correct = true;
    if (/PROBLEM_WRONG|回答错误|答案错误/.test(correctnessText)) correct = false;
    return {
      score: scored ? Number(scored[1]) : null,
      maxScore: fullScore ? Number(fullScore[1]) : totalScore ? Number(totalScore[1]) : null,
      correct,
      submissionStatus,
      submittedAt: submissionStatus ? Date.now() : 0,
    };
  }

  function collectPageStyles() {
    const hrefs = Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]'))
      .map((link) => {
        try {
          return new URL(link.getAttribute('href'), location.href).href;
        } catch (error) {
          return '';
        }
      })
      .filter(Boolean);
    const inline = Array.from(document.querySelectorAll('style'))
      .map((style) => String(style.textContent || ''))
      .filter(Boolean);
    return {
      baseUrl: location.href,
      hrefs: Array.from(new Set(hrefs)),
      inline: inline.slice(0, 80),
    };
  }

  async function captureSnapshot(bookmark, options) {
    const opts = options || {};
    const title = bookmark.title || document.title;
    const exactCard = bookmark.problemId ? document.getElementById(bookmark.problemId) : null;
    const currentProblem = extractCurrentProblem();
    const isCurrentProblem = currentProblem && Core.makeBookmarkKey(currentProblem) === bookmark.id;
    if (!exactCard && !isCurrentProblem) {
      throw new Error('当前页面不是这道题，已阻止保存错误快照。请先打开对应题目再更新快照。');
    }
    const contentRoot = exactCard || findContentRoot(title, bookmark.problemId);
    const clone = sanitizedClone(contentRoot);
    const html = clone.outerHTML || '';
    const pageStyles = collectPageStyles();
    const markdownClone = clone.cloneNode(true);
    markdownClone.querySelectorAll('button, [role="button"], .pc-button, [class*="cm-gutters"], [class*="cm-panel"], [class*="cm-foldGutter"]').forEach((node) => node.remove());
    const markdown = htmlToMarkdown(markdownClone);
    const text = visibleText(contentRoot);
    const answerScopeText = text;
    const answerVisibility = Core.detectAnswerVisibility(answerScopeText);
    const officialAnswer = excerptAround(answerScopeText, /(?:正确答案|参考答案|标准答案)(?:[：:\s]|$)/, 320);
    const explanation = excerptAround(answerScopeText, /(?:答案解析|题目解析|解析)(?:[：:\s]|$)/, 500);
    const answers = extractAnswersFromDom(contentRoot);
    const choiceGroups = extractChoiceGroupsFromDom(contentRoot);
    const userAnswer = answers.map((answer) => answer.answer).filter(Boolean).join('；');
    const problemType = Core.normalizeProblemType(bookmark.type);
    const isCodeProblem = ['function', 'programming'].includes(problemType);
    const isObjective = !isCodeProblem;
    const answerMeta = isObjective ? extractAnswerMeta(contentRoot, bookmark.problemId) : {
      score: null,
      maxScore: null,
      correct: null,
      submissionStatus: '',
      submittedAt: 0,
    };
    const judgeConstraints = extractJudgeConstraints(contentRoot);
    const codeDraft = isCodeProblem ? findEditableCodeInPage(document.querySelector('main') || document) : '';
    const submission = extractSubmissionFromPage(contentRoot, bookmark, opts.submissionCaptureMode);
    const now = Date.now();

    const snapshot = {
      bookmarkId: bookmark.id,
      capturedAt: now,
      url: bookmark.url || location.href,
      capturedFromUrl: location.href,
      capturedFromProblemId: currentProblem ? currentProblem.problemId : exactCard ? bookmark.problemId : '',
      title,
      html,
      markdown,
      text,
      answers,
      choiceGroups,
      codeDraft,
      judgeConstraints,
      pageStyles,
      snapshotVersion: 2,
      answerVisibility,
      officialAnswerExcerpt: officialAnswer,
      explanationExcerpt: explanation,
      contentHash: Core.computeContentHash(`${title}\n${text}\n${html}`.slice(0, 200000)),
      appVersion: APP_VERSION,
    };

    await snapshotStore.put(snapshot);

    const patch = Core.createBookmark({
      ...bookmark,
      content: {
        status: (bookmark.problemId && document.getElementById(bookmark.problemId)) || text.length > 200 ? 'full' : 'partial',
        capturedAt: now,
        contentHash: snapshot.contentHash,
        url: bookmark.url,
        title,
        answerVisibility,
      },
      answer: {
        ...bookmark.answer,
        visibility: answerVisibility,
        officialAnswer: officialAnswer || bookmark.answer.officialAnswer,
        explanation: explanation || bookmark.answer.explanation,
        userAnswer: userAnswer || bookmark.answer.userAnswer,
        score: answerMeta.score != null ? answerMeta.score : bookmark.answer.score,
        maxScore: answerMeta.maxScore != null ? answerMeta.maxScore : bookmark.answer.maxScore,
        correct: answerMeta.correct != null ? answerMeta.correct : bookmark.answer.correct,
        submissionStatus: answerMeta.submissionStatus || bookmark.answer.submissionStatus,
        submittedAt: answerMeta.submittedAt || bookmark.answer.submittedAt,
        revealedAt: answerVisibility === 'revealed' ? now : bookmark.answer.revealedAt,
        source: officialAnswer ? 'pta' : bookmark.answer.source,
        lastCheckedAt: now,
      },
      submissions: submission ? [submission] : bookmark.submissions,
    }, { preserveId: true, preserveTimes: true });

    const saved = store.upsert(patch, { preserveId: true, preserveTimes: true });
    if ((submission || codeDraft) && opts.keepSubmissionDraft !== false) {
      await snapshotStore.put({ ...snapshot, submissionDraft: submission || { language: detectLanguage(visibleText(document.body)), code: codeDraft, status: 'draft', testPoints: [] } });
    }
    return { snapshot, bookmark: saved };
  }
  function findProblemSetName(problemSetId) {
    if (!problemSetId) return '未命名题目集';
    const titleParts = String(document.title || '').split(/\s+[-|]\s+/).map((part) => part.trim()).filter(Boolean);
    const lastTitlePart = titleParts[titleParts.length - 1] || '';
    if (lastTitlePart && !/^(题目列表|题目详情|概览|答题中|单选题|多选题|判断题|填空题|函数题|编程题)$/.test(lastTitlePart)) {
      return lastTitlePart;
    }
    const links = Array.from(document.querySelectorAll('a[href*="/problem-sets/"]'));
    for (const link of links) {
      const parsed = Core.parseProblemUrl(link.href);
      if (parsed.problemSetId === problemSetId) {
        const text = Core.cleanProblemTitle(visibleText(link));
        if (text && !/^题目集$/.test(text)) return text;
      }
    }

    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [class*="title"]'))
      .map((element) => visibleText(element))
      .filter((text) => text.length >= 2 && text.length <= 80)
      .filter((text) => !/^(登录|首页|题目列表|我的收藏|题目详情)$/.test(text));
    return headings[0] || `题目集 ${problemSetId}`;
  }

  function inferCurrentProblemType(fallbackText) {
    const activeTypeLink = document.querySelector('a.active[href*="/exam/problems/type/"]:not([href*="problemSetProblemId="])');
    const activeTypeText = visibleText(activeTypeLink);
    if (activeTypeText) {
      const type = Core.inferProblemType(activeTypeText);
      if (type !== 'other') return type;
    }

    const titleHead = String(document.title || '').split(/\s+[-|]\s+/)[0] || '';
    const titleType = Core.inferProblemType(titleHead);
    if (titleType !== 'other') return titleType;

    const typeId = (location.pathname.match(/\/exam\/problems\/type\/(\d+)/) || [])[1];
    const typeMap = {
      1: 'true_false',
      2: 'single_choice',
      3: 'multiple_choice',
      4: 'fill_blank',
      5: 'short_answer',
      6: 'function',
      7: 'programming',
    };
    return typeMap[typeId] || Core.inferProblemType(fallbackText);
  }

  function extractCardTitle(card, anchor) {
    if (!card) return extractTitleFromElement(anchor);
    const heading = card.querySelector('h1, h2, h3, h4, [class*="problem-title"], [class*="problemTitle"]');
    const headingText = Core.cleanProblemTitle(visibleText(heading));
    if (headingText) return headingText.slice(0, 300);
    const titleLink = card.querySelector('[data-e2e="problem-set-problem-list-link"]');
    const titleLinkText = Core.cleanProblemTitle(visibleText(titleLink));
    if (titleLinkText) return titleLinkText.slice(0, 300);
    const firstParagraph = card.querySelector('.rendered-markdown p, .rendered-markdown');
    const paragraphText = Core.cleanProblemTitle(visibleText(firstParagraph));
    if (paragraphText) return paragraphText.slice(0, 180);
    return extractTitleFromElement(anchor);
  }

  function extractTitleFromElement(element) {
    if (!element) return '';
    const explicit = element.getAttribute('data-title')
      || element.getAttribute('aria-label')
      || element.getAttribute('title');
    const source = explicit || element.innerText || element.textContent || '';
    const title = Core.cleanProblemTitle(source);
    if (title && title !== Core.inferProblemLabel(title)) return title;
    const row = element.closest('li, tr, [role="row"], [class*="item"], [class*="problem"]');
    if (row) {
      const heading = row.querySelector('h1, h2, h3, h4, [class*="title"]');
      const rowTitle = Core.cleanProblemTitle(visibleText(heading || row));
      if (rowTitle) return rowTitle.slice(0, 300);
    }
    return title || '未命名题目';
  }

  function extractProblemFromAnchor(anchor) {
    const parsed = Core.parseProblemUrl(anchor.href);
    if (!parsed.ok) return null;
    const card = document.getElementById(parsed.problemId);
    const row = anchor.closest('li, tr, [role="row"], [class*="item"], [class*="problem"]');
    const rowText = visibleText(row || anchor);
    const cardText = visibleText(card);
    const title = extractCardTitle(card, anchor);
    const cardRow = card && card.closest('tr');
    const labelButton = card && card.querySelector('button');
    const labelSource = `${visibleText(cardRow)} ${visibleText(labelButton)} ${rowText} ${title}`;
    const label = Core.inferProblemLabel(labelSource);
    const typeText = `${document.title} ${rowText} ${cardText}`.slice(0, 30000);
    return {
      url: parsed.url,
      problemId: parsed.problemId,
      problemSetId: parsed.problemSetId,
      problemSetName: findProblemSetName(parsed.problemSetId),
      title,
      label,
      type: inferCurrentProblemType(typeText),
      host: parsed.host,
      sourceHost: location.host,
    };
  }

  function extractCurrentProblem() {
    const canonical = document.querySelector('link[rel="canonical"]');
    const parsed = Core.parseProblemUrl(canonical ? canonical.href : location.href);
    if (!parsed.ok) return null;

    const documentTitle = Core.cleanProblemTitle(document.title);
    const documentTitleParts = documentTitle.split(/\s+[-|]\s+/).map((part) => part.trim()).filter(Boolean);
    const titleFromDocument = documentTitleParts.length ? documentTitleParts[0] : '';
    const inferredLabel = Core.inferProblemLabel(titleFromDocument);
    const cleanTitleFromDocument = inferredLabel
      ? Core.cleanProblemTitle(titleFromDocument.replace(inferredLabel, ''))
      : Core.cleanProblemTitle(titleFromDocument);

    const titleCandidates = Array.from(document.querySelectorAll('h1, h2, h3, [class*="problem-title"], [class*="problemTitle"], [class*="question-title"]'))
      .map((element) => Core.cleanProblemTitle(visibleText(element)))
      .filter((text) => text.length >= 2 && text.length <= 180)
      .filter((text) => !/^(题目详情|题目描述|输入格式|输出格式|函数接口定义|裁判测试程序样例|测试用例)$/.test(text));

    const title = cleanTitleFromDocument || titleCandidates[0] || `题目 ${parsed.problemId}`;
    const bodyText = (document.body ? document.body.innerText : '').slice(0, 30000);

    return {
      url: parsed.url,
      problemId: parsed.problemId,
      problemSetId: parsed.problemSetId,
      problemSetName: findProblemSetName(parsed.problemSetId),
      title,
      label: inferredLabel || Core.inferProblemLabel(`${title}\n${bodyText}`),
      type: inferCurrentProblemType(`${documentTitle}\n${title}\n${bodyText}`),
      host: parsed.host,
      sourceHost: location.host,
    };
  }

  function selectionIsActive(selection, candidate) {
    if (!selection || !candidate) return false;
    if (selection.kind !== candidate.kind) return false;
    if (selection.kind === 'smart-set') return selection.problemSetId === candidate.problemSetId;
    if (selection.kind === 'smart-type') {
      return selection.problemSetId === candidate.problemSetId && selection.type === candidate.type;
    }
    if (selection.kind === 'user') return selection.folderId === candidate.folderId;
    return true;
  }

  function selectionLabel(selection, state) {
    if (!selection || selection.kind === 'all') return '全部收藏';
    if (selection.kind === 'unsnapshotted') return '缺少快照';
    if (selection.kind === 'unpublished-answer') return '答案未公布';
    if (selection.kind === 'smart-set') {
      const bookmark = Object.values(state.bookmarks).find((item) => item.problemSetId === selection.problemSetId);
      return bookmark ? bookmark.problemSetName : '题目集';
    }
    if (selection.kind === 'smart-type') return Core.typeLabel(selection.type);
    if (selection.kind === 'user') {
      const folder = state.folders[selection.folderId];
      return folder ? folder.name : '收藏夹';
    }
    return '收藏';
  }

  function statusBadgeClass(status) {
    if (status === 'AC') return 'success';
    if (['partial', 'pending'].includes(status)) return 'warning';
    if (['WA', 'TLE', 'MLE', 'RE', 'CE', 'PE'].includes(status)) return 'danger';
    return '';
  }

  function answerBadgeClass(visibility) {
    if (visibility === 'revealed') return 'success';
    if (visibility === 'score-only') return 'warning';
    if (visibility === 'hidden') return 'danger';
    return '';
  }

  function contentBadge(bookmark) {
    if (!bookmark.content || !bookmark.content.capturedAt) return '无快照';
    return bookmark.content.status === 'full' ? '快照完整' : '快照部分';
  }
  class FavoritesUI {
    constructor(store, snapshotStore) {
      this.store = store;
      this.snapshotStore = snapshotStore;
      this.selection = { kind: 'all' };
      this.query = '';
      this.currentEditId = '';
      this.editorForcedFolderId = '';
      this.selectedBookmarkIds = new Set();
      this.batchMode = false;
      this.batchFolderAction = 'copy';
      this.snapshotLayout = 'stacked';
      this.drawerFullscreen = false;
      this.capturingShortcutAction = '';
      this.currentListBookmarkIds = [];
      this.currentPage = 1;
      this.snapshotResizeCleanup = null;
      this.dragState = null;
      this.expandedProblemSets = new Set();
      this.toastTimer = null;
      this.host = null;
      this.shadow = null;
      this.openDrawer = this.openDrawer.bind(this);
      this.render = this.render.bind(this);
    }

    mount() {
      if (document.getElementById(HOST_ID)) return;
      this.host = document.createElement('div');
      this.host.id = HOST_ID;
      this.host.setAttribute('data-ptaf', 'root');
      this.shadow = this.host.attachShadow({ mode: 'open' });

      const styles = document.createElement('style');
      styles.textContent = `
:host {
  --ptaf-bg: #ffffff;
  --ptaf-panel: #f7f9fc;
  --ptaf-panel-2: #eef3f9;
  --ptaf-text: #152235;
  --ptaf-muted: #66758a;
  --ptaf-border: #dbe4ef;
  --ptaf-primary: #0c6bdc;
  --ptaf-primary-strong: #0757b8;
  --ptaf-accent: #f4a11b;
  --ptaf-danger: #d93e36;
  --ptaf-success: #14875d;
  --ptaf-shadow: 0 18px 60px rgba(17, 40, 72, 0.22);
  color: var(--ptaf-text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.55;
}

* {
  box-sizing: border-box;
}

button,
input,
textarea,
select {
  font: inherit;
}

button {
  cursor: pointer;
}

.ptaf-floating {
  position: fixed;
  right: 22px;
  bottom: 30px;
  z-index: 2147483000;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 46px;
  padding: 0 17px;
  color: #fff;
  background: linear-gradient(135deg, #0c6bdc, #0757b8);
  border: 0;
  border-radius: 999px;
  box-shadow: 0 12px 35px rgba(7, 87, 184, 0.35);
  transition: transform 160ms ease, box-shadow 160ms ease;
}

.ptaf-floating:hover {
  transform: translateY(-2px);
  box-shadow: 0 16px 40px rgba(7, 87, 184, 0.42);
}

.ptaf-floating-count {
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  color: #0757b8;
  background: #fff;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  line-height: 22px;
  text-align: center;
}

.ptaf-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483100;
  display: none;
  background: rgba(8, 20, 38, 0.38);
  backdrop-filter: blur(3px);
}

.ptaf-overlay.is-open {
  display: block;
}

.ptaf-drawer {
  position: absolute;
  top: 0;
  right: 0;
  display: grid;
  grid-template-rows: auto 1fr;
  width: min(1040px, calc(100vw - 32px));
  height: 100%;
  background: var(--ptaf-bg);
  box-shadow: var(--ptaf-shadow);
  animation: ptaf-slide-in 180ms ease-out;
}

@keyframes ptaf-slide-in {
  from { transform: translateX(30px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

.ptaf-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--ptaf-border);
  background: #fff;
}

.ptaf-header-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.ptaf-header-title strong {
  font-size: 18px;
}

.ptaf-header-subtitle {
  color: var(--ptaf-muted);
  font-size: 12px;
}

.ptaf-header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.ptaf-body {
  display: grid;
  grid-template-columns: 270px minmax(0, 1fr);
  min-height: 0;
}

.ptaf-sidebar {
  min-height: 0;
  overflow: auto;
  padding: 14px;
  background: var(--ptaf-panel);
  border-right: 1px solid var(--ptaf-border);
}

.ptaf-main {
  display: grid;
  grid-template-rows: auto 1fr;
  min-width: 0;
  min-height: 0;
}

.ptaf-searchbar {
  display: flex;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--ptaf-border);
}

.ptaf-search {
  width: 100%;
  min-height: 38px;
  padding: 0 12px;
  color: var(--ptaf-text);
  background: #fff;
  border: 1px solid var(--ptaf-border);
  border-radius: 8px;
  outline: none;
}

.ptaf-search:focus,
.ptaf-input:focus,
.ptaf-textarea:focus,
.ptaf-select:focus {
  border-color: var(--ptaf-primary);
  box-shadow: 0 0 0 3px rgba(12, 107, 220, 0.12);
}

.ptaf-list {
  min-height: 0;
  overflow: auto;
  padding: 15px 16px 28px;
}

.ptaf-sidebar-section {
  margin-bottom: 18px;
}

.ptaf-sidebar-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 4px 8px;
  color: var(--ptaf-muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.ptaf-tree-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 34px;
  margin: 2px 0;
  padding: 6px 9px;
  color: var(--ptaf-text);
  background: transparent;
  border: 0;
  border-radius: 7px;
  text-align: left;
}

.ptaf-tree-item:hover {
  background: rgba(12, 107, 220, 0.08);
}

.ptaf-tree-item.is-active {
  color: var(--ptaf-primary-strong);
  background: rgba(12, 107, 220, 0.13);
  font-weight: 650;
}

.ptaf-tree-item.child {
  padding-left: 22px;
}

.ptaf-tree-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ptaf-tree-count {
  flex: none;
  min-width: 24px;
  margin-left: 8px;
  padding: 1px 6px;
  color: var(--ptaf-muted);
  background: rgba(102, 117, 138, 0.1);
  border-radius: 999px;
  font-size: 11px;
  text-align: center;
}

.ptaf-empty {
  padding: 60px 20px;
  color: var(--ptaf-muted);
  text-align: center;
}

.ptaf-card {
  margin-bottom: 12px;
  padding: 14px;
  background: #fff;
  border: 1px solid var(--ptaf-border);
  border-radius: 10px;
  box-shadow: 0 4px 14px rgba(26, 52, 83, 0.05);
}

.ptaf-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.ptaf-card-title {
  margin: 0;
  font-size: 15px;
  line-height: 1.45;
}

.ptaf-card-title a {
  color: var(--ptaf-text);
  text-decoration: none;
}

.ptaf-card-title a:hover {
  color: var(--ptaf-primary);
  text-decoration: underline;
}

.ptaf-card-meta,
.ptaf-card-note,
.ptaf-card-status {
  margin-top: 7px;
  color: var(--ptaf-muted);
  font-size: 12px;
}

.ptaf-card-note {
  color: #43536a;
  white-space: pre-wrap;
}

.ptaf-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 11px;
}

.ptaf-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.ptaf-badge {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 1px 8px;
  color: #43536a;
  background: var(--ptaf-panel-2);
  border-radius: 999px;
  font-size: 11px;
}

.ptaf-badge.success {
  color: #0c6a49;
  background: #e2f5ed;
}

.ptaf-badge.warning {
  color: #935b00;
  background: #fff2d8;
}

.ptaf-badge.danger {
  color: #a52f29;
  background: #ffe9e7;
}

.ptaf-badge.primary {
  color: #0757b8;
  background: #e5f0ff;
}

.ptaf-btn {
  min-height: 34px;
  padding: 5px 11px;
  color: #34445a;
  background: #fff;
  border: 1px solid var(--ptaf-border);
  border-radius: 7px;
}

.ptaf-btn:hover {
  color: var(--ptaf-primary-strong);
  border-color: #a9c7eb;
  background: #f6faff;
}

.ptaf-btn.primary {
  color: #fff;
  background: var(--ptaf-primary);
  border-color: var(--ptaf-primary);
}

.ptaf-btn.primary:hover {
  color: #fff;
  background: var(--ptaf-primary-strong);
  border-color: var(--ptaf-primary-strong);
}

.ptaf-btn.danger {
  color: var(--ptaf-danger);
  border-color: #f0b9b5;
}

.ptaf-btn.small {
  min-height: 28px;
  padding: 3px 8px;
  font-size: 12px;
}

.ptaf-modal {
  position: absolute;
  inset: 0;
  display: none;
  place-items: center;
  padding: 24px;
}

.ptaf-modal.is-open {
  display: grid;
  place-items: center;
}

.ptaf-modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(8, 20, 38, 0.55);
}

.ptaf-modal-card {
  position: relative;
  margin: 0;
  z-index: 1;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(760px, 100%);
  max-height: min(820px, calc(100vh - 80px));
  overflow: hidden;
  background: #fff;
  border-radius: 12px;
  box-shadow: var(--ptaf-shadow);
}

.ptaf-modal-card.wide {
  width: min(1100px, 100%);
}

.ptaf-modal-head,
.ptaf-modal-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--ptaf-border);
}

.ptaf-modal-foot {
  justify-content: flex-end;
  border-top: 1px solid var(--ptaf-border);
  border-bottom: 0;
}

.ptaf-modal-head h3 {
  margin: 0;
  font-size: 17px;
}

.ptaf-modal-body {
  min-height: 0;
  overflow: auto;
  padding: 18px;
}

.ptaf-field {
  display: grid;
  gap: 6px;
  margin-bottom: 14px;
}

.ptaf-field > label {
  color: #34445a;
  font-size: 13px;
  font-weight: 650;
}

.ptaf-input,
.ptaf-textarea,
.ptaf-select {
  width: 100%;
  padding: 8px 10px;
  color: var(--ptaf-text);
  background: #fff;
  border: 1px solid var(--ptaf-border);
  border-radius: 7px;
  outline: none;
}

.ptaf-textarea {
  min-height: 96px;
  resize: vertical;
}

.ptaf-check-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ptaf-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 9px;
  background: var(--ptaf-panel);
  border: 1px solid var(--ptaf-border);
  border-radius: 7px;
}

.ptaf-snapshot-frame {
  width: 100%;
  height: 55vh;
  min-height: 420px;
  max-height: 65vh;
  background: #fff;
  border: 1px solid var(--ptaf-border);
  border-radius: 8px;
}

.ptaf-details {
  margin-top: 12px;
  padding: 10px 12px;
  background: var(--ptaf-panel);
  border: 1px solid var(--ptaf-border);
  border-radius: 8px;
}

.ptaf-details summary {
  cursor: pointer;
  font-weight: 650;
}

.ptaf-code {
  max-height: 420px;
  overflow: auto;
  padding: 11px;
  color: #dbe9ff;
  background: #101a2d;
  border-radius: 7px;
  font: 12px/1.55 Consolas, Monaco, monospace;
  white-space: pre;
  tab-size: 4;
}

.ptaf-console {
  max-height: 360px;
  overflow: auto;
  padding: 11px;
  color: #dbe9ff;
  background: #101a2d;
  border-radius: 7px;
  font: 12px/1.55 Consolas, Monaco, monospace;
  white-space: pre-wrap;
}

.ptaf-toast {
  position: fixed;
  right: 24px;
  bottom: 86px;
  z-index: 2147483200;
  max-width: min(380px, calc(100vw - 30px));
  padding: 10px 13px;
  color: #fff;
  background: #18314f;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(8, 20, 38, 0.28);
}

.ptaf-toast.error {
  background: #a52f29;
}

.ptaf-star {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 27px;
  height: 27px;
  margin-left: 7px;
  color: #8a98aa;
  background: #fff;
  border: 1px solid #d7e0eb;
  border-radius: 7px;
  vertical-align: middle;
  transition: color 120ms ease, background 120ms ease, transform 120ms ease;
}

.ptaf-star:hover {
  color: #e59610;
  background: #fff9eb;
  transform: scale(1.04);
}

.ptaf-star.is-active {
  color: #fff;
  background: #f0a11a;
  border-color: #f0a11a;
}

@media (max-width: 760px) {
  .ptaf-drawer {
    width: 100vw;
  }
  .ptaf-body {
    grid-template-columns: 210px minmax(0, 1fr);
  }
  .ptaf-header {
    align-items: flex-start;
    flex-direction: column;
  }
  .ptaf-header-actions {
    justify-content: flex-start;
  }
}
.ptaf-tree-group-row {
  display: flex;
  align-items: center;
  gap: 2px;
}

.ptaf-tree-caret {
  flex: none;
  width: 24px;
  height: 32px;
  padding: 0;
  color: var(--ptaf-muted);
  background: transparent;
  border: 0;
  border-radius: 6px;
  font-size: 13px;
}

.ptaf-tree-caret:hover {
  color: var(--ptaf-primary);
  background: rgba(12, 107, 220, 0.08);
}

.ptaf-tree-item.grow {
  flex: 1;
  width: auto;
}


.ptaf-list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.ptaf-list-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.ptaf-list-title strong {
  font-size: 15px;
}
.ptaf-list-title span {
  color: var(--ptaf-muted);
  font-size: 12px;
}
.ptaf-batch-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  color: var(--ptaf-muted);
  font-size: 12px;
}
.ptaf-select-all,
.ptaf-select-box {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.ptaf-select-box {
  flex: none;
  margin-top: 2px;
}
.ptaf-card-head .ptaf-card-title {
  flex: 1;
}


.ptaf-answer-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.ptaf-answer-chip {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 4px 10px;
  color: #0757b8;
  background: #e5f0ff;
  border: 1px solid #c5dcf8;
  border-radius: 8px;
  font-weight: 700;
}
.ptaf-answer-chip.muted {
  color: var(--ptaf-muted);
  background: var(--ptaf-panel);
  border-color: var(--ptaf-border);
  font-weight: 400;
}
.ptaf-code-block {
  overflow: hidden;
  border: 1px solid #26364f;
  border-radius: 8px;
  background: #101a2d;
}
.ptaf-code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 10px;
  color: #c9d7ea;
  background: #17243a;
  border-bottom: 1px solid #26364f;
  font-size: 12px;
}
.ptaf-code-block .ptaf-code {
  max-height: 420px;
  border-radius: 0;
}
.ptaf-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--ptaf-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: 18px;
  line-height: 1;
}
.ptaf-icon-btn:hover {
  color: var(--ptaf-primary);
  background: rgba(12, 107, 220, 0.08);
}
.ptaf-batch-folder {
  width: auto;
  max-width: 150px;
  min-height: 30px;
  padding: 3px 8px;
  font-size: 12px;
}
.ptaf-overlay#ptafEditorModal.is-open,
.ptaf-overlay#ptafSnapshotModal.is-open,
.ptaf-overlay#ptafBatchFolderModal.is-open,
.ptaf-overlay#ptafExportModal.is-open,
.ptaf-overlay#ptafShortcutModal.is-open,
.ptaf-overlay#ptafAiModal.is-open,
.ptaf-overlay#ptafAiSettingsModal.is-open {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
#ptafEditorModal .ptaf-modal-card,
#ptafSnapshotModal .ptaf-modal-card,
#ptafBatchFolderModal .ptaf-modal-card,
#ptafExportModal .ptaf-modal-card,
#ptafShortcutModal .ptaf-modal-card,
#ptafAiModal .ptaf-modal-card,
#ptafAiSettingsModal .ptaf-modal-card {
  margin: auto;
}
.ptaf-code-viewer {
  overflow: hidden;
  border: 1px solid #dbe4ef;
  border-radius: 8px;
  background: #f8fafc;
}
.ptaf-code-viewer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 10px;
  color: #53657a;
  background: #eef3f8;
  border-bottom: 1px solid #dbe4ef;
  font-size: 12px;
}
.ptaf-code-viewer-body {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  max-height: 430px;
  overflow: auto;
  background: #fff;
}
.ptaf-code-line-numbers,
.ptaf-code-content {
  margin: 0;
  padding: 11px 0;
  font: 17px/1.75 Consolas, Monaco, "Courier New", monospace;
  tab-size: 4;
}
.ptaf-code-line-numbers {
  min-width: 42px;
  padding-right: 9px;
  color: #94a3b8;
  background: #f8fafc;
  border-right: 1px solid #e2e8f0;
  text-align: right;
  user-select: none;
  white-space: pre;
}
.ptaf-code-content {
  overflow: visible;
  color: #1f2937;
  white-space: pre;
}
.ptaf-code-content code {
  font: inherit;
}
.token-keyword { color: #7c3aed; font-weight: 600; }
.token-string { color: #b45309; }
.token-number { color: #0f766e; }
.token-comment { color: #64748b; font-style: italic; }
.token-preprocessor { color: #0b6bcb; font-weight: 600; }
.token-function { color: #1d4ed8; }
.token-identifier { color: #1f2937; }


.ptaf-modal-card.narrow {
  width: min(520px, 100%);
}
.ptaf-folder-choice-list {
  display: grid;
  gap: 8px;
}
.ptaf-folder-choice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--ptaf-panel);
  border: 1px solid var(--ptaf-border);
  border-radius: 8px;
}
.ptaf-folder-choice:hover {
  border-color: #a9c7eb;
  background: #f6faff;
}
.ptaf-card.is-batch-selectable {
  cursor: pointer;
}
.ptaf-card.is-batch-selectable:hover {
  border-color: #a9c7eb;
}
.ptaf-card.is-selected {
  border-color: var(--ptaf-primary);
  background: #f3f8ff;
  box-shadow: 0 0 0 3px rgba(12, 107, 220, 0.12);
}
.ptaf-answer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 7px;
}
.ptaf-answer-header > label {
  color: #34445a;
  font-size: 13px;
  font-weight: 650;
}
.ptaf-edit-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ptaf-snapshot-answer-inputs {
  display: grid;
  gap: 8px;
}
.ptaf-snapshot-code-editor {
  min-height: 430px;
  margin-top: 12px;
  padding: 14px 16px;
  font: 19px/1.8 Consolas, Monaco, "Courier New", monospace;
  tab-size: 4;
  white-space: pre;
  overflow: auto;
}


.ptaf-snapshot-layout {
  display: block;
}
.ptaf-snapshot-pane {
  min-width: 0;
}
.ptaf-snapshot-layout.is-split {
  display: grid;
  grid-template-columns: minmax(320px, var(--ptaf-split-left, 60%)) 14px minmax(380px, 1fr);
  gap: 0;
  align-items: start;
}
.ptaf-snapshot-layout.is-split .ptaf-snapshot-answer-pane {
  padding-left: 16px;
}
.ptaf-split-resizer {
  display: none;
}
.ptaf-snapshot-layout.is-split .ptaf-split-resizer {
  display: block;
  width: 14px;
  min-height: 500px;
  cursor: col-resize;
  touch-action: none;
  background: linear-gradient(to right, transparent 5px, var(--ptaf-border) 5px, var(--ptaf-border) 9px, transparent 9px);
}
.ptaf-snapshot-layout.is-split .ptaf-split-resizer:hover,
.ptaf-snapshot-layout.is-split .ptaf-split-resizer:active {
  background: linear-gradient(to right, transparent 5px, var(--ptaf-primary) 5px, var(--ptaf-primary) 9px, transparent 9px);
}
.ptaf-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.ptaf-snapshot-layout.is-split .ptaf-snapshot-frame {
  height: 70vh;
  min-height: 500px;
  max-height: 76vh;
}


.ptaf-export-folders {
  display: grid;
  gap: 8px;
  margin-bottom: 14px;
}
.ptaf-export-folders .ptaf-tree-count {
  margin-left: auto;
}


.ptaf-drag-handle {
  flex: none;
  color: #9aa8b9;
  cursor: grab;
  user-select: none;
  letter-spacing: -2px;
}
.ptaf-card-drag-handle {
  margin-top: 2px;
}
.ptaf-tree-item .ptaf-drag-handle {
  margin-right: 6px;
}
.ptaf-tree-item.is-dragging,
.ptaf-card.is-dragging {
  opacity: 0.45;
}
.ptaf-tree-item.is-drag-over {
  outline: 2px solid var(--ptaf-primary);
  outline-offset: -2px;
}
.ptaf-card.is-drag-over {
  border-color: var(--ptaf-primary);
  box-shadow: 0 -3px 0 var(--ptaf-primary), 0 4px 14px rgba(26, 52, 83, 0.08);
}
.ptaf-pagination {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--ptaf-border);
}
.ptaf-page-numbers {
  display: flex;
  gap: 4px;
}
.ptaf-page-btn {
  min-width: 30px;
  height: 30px;
  padding: 0 7px;
  color: var(--ptaf-text);
  background: #fff;
  border: 1px solid var(--ptaf-border);
  border-radius: 7px;
}
.ptaf-page-btn:hover {
  color: var(--ptaf-primary);
  border-color: #a9c7eb;
}
.ptaf-page-btn.is-active {
  color: #fff;
  background: var(--ptaf-primary);
  border-color: var(--ptaf-primary);
}
.ptaf-page-size {
  width: auto;
  min-height: 30px;
  padding: 3px 8px;
  font-size: 12px;
}


.ptaf-choice-edit-group {
  display: grid;
  gap: 7px;
}
.ptaf-choice-edit-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--ptaf-border);
  border-radius: 8px;
  background: #fff;
}
.ptaf-choice-edit-option:hover {
  border-color: #a9c7eb;
  background: #f6faff;
}
.ptaf-choice-edit-option input {
  margin-top: 4px;
}
.ptaf-notion-option {
  display: inline-flex;
  margin-bottom: 12px;
}
.ptaf-drawer.is-fullscreen {
  width: 100vw;
  max-width: none;
  border-radius: 0;
}
.ptaf-drawer-expand {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 20;
  min-width: 44px;
  height: 30px;
  color: var(--ptaf-primary-strong);
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid var(--ptaf-border);
  border-radius: 7px;
  box-shadow: 0 4px 14px rgba(26, 52, 83, 0.14);
  font: 700 15px/1 Consolas, monospace;
}
.ptaf-drawer-expand:hover {
  color: #fff;
  background: var(--ptaf-primary);
  border-color: var(--ptaf-primary);
}


.ptaf-shortcut-list {
  display: grid;
  gap: 9px;
}
.ptaf-shortcut-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  background: var(--ptaf-panel);
  border: 1px solid var(--ptaf-border);
  border-radius: 8px;
}
.ptaf-shortcut-row strong {
  display: block;
  font-size: 13px;
}
.ptaf-shortcut-row span {
  display: block;
  margin-top: 2px;
  color: var(--ptaf-muted);
  font-size: 11px;
}
.ptaf-shortcut-key {
  min-width: 128px;
  min-height: 34px;
  padding: 5px 10px;
  color: var(--ptaf-primary-strong);
  background: #fff;
  border: 1px solid var(--ptaf-border);
  border-radius: 7px;
  font: 600 13px/1 Consolas, Monaco, monospace;
}
.ptaf-shortcut-key:hover {
  border-color: #a9c7eb;
  background: #f6faff;
}
.ptaf-shortcut-key.is-capturing {
  color: #fff;
  background: var(--ptaf-primary);
  border-color: var(--ptaf-primary);
}
.ptaf-shortcut-help {
  margin-bottom: 12px;
}


.ptaf-ai-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.ptaf-ai-context {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
  padding: 9px 11px;
  background: var(--ptaf-panel);
  border: 1px solid var(--ptaf-border);
  border-radius: 8px;
  color: var(--ptaf-muted);
  font-size: 12px;
}
.ptaf-ai-group {
  margin-bottom: 15px;
}
.ptaf-ai-group-title {
  margin-bottom: 7px;
  color: #34445a;
  font-size: 13px;
  font-weight: 700;
}
.ptaf-ai-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.ptaf-ai-output {
  min-height: 220px;
  max-height: 55vh;
  overflow: auto;
  margin: 0;
  padding: 14px;
  color: #26364f;
  background: #f8fafc;
  border: 1px solid var(--ptaf-border);
  border-radius: 8px;
  font: 14px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.ptaf-ai-reference {
  margin-top: 12px;
  padding: 11px 12px;
  background: #fff9eb;
  border: 1px solid #f0d79b;
  border-radius: 8px;
}
.ptaf-ai-reference-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: #7b5c19;
  font-size: 12px;
}
.ptaf-ai-reference-body {
  color: #43391f;
  font-size: 13px;
  line-height: 1.65;
}
.ptaf-ai-reference-body pre {
  overflow: auto;
  padding: 10px;
  color: #dbe9ff;
  background: #101a2d;
  border-radius: 7px;
  font: 14px/1.65 Consolas, Monaco, monospace;
  white-space: pre;
}
.ptaf-ai-reference-body hr {
  height: 1px;
  margin: 10px 0;
  border: 0;
  background: #ecd8a8;
}
.ptaf-overlay#ptafAiSettingsModal.is-open {
  z-index: 2147483350;
}


.ptaf-markdown h3,
.ptaf-markdown h4,
.ptaf-markdown h5,
.ptaf-markdown h6 {
  margin: 12px 0 7px;
  color: #1f2f45;
}
.ptaf-markdown h3 { font-size: 17px; }
.ptaf-markdown h4 { font-size: 15px; }
.ptaf-markdown p {
  margin: 7px 0;
}
.ptaf-markdown ul,
.ptaf-markdown ol {
  margin: 7px 0;
  padding-left: 22px;
}
.ptaf-markdown li {
  margin: 3px 0;
}
.ptaf-markdown blockquote {
  margin: 8px 0;
  padding: 6px 10px;
  color: #53657a;
  background: #f1f5f9;
  border-left: 3px solid #94a3b8;
}
.ptaf-markdown code {
  padding: 1px 4px;
  color: #9a3412;
  background: #fff1e8;
  border-radius: 4px;
  font: 0.92em Consolas, Monaco, monospace;
}
.ptaf-md-code {
  overflow: auto;
  padding: 12px;
  color: #dbe9ff;
  background: #101a2d;
  border-radius: 8px;
  font: 15px/1.65 Consolas, Monaco, monospace;
  white-space: pre;
}
.ptaf-md-code code {
  padding: 0;
  color: inherit;
  background: transparent;
  font: inherit;
}
.ptaf-ai-reference-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ptaf-ai-reference-head button {
  margin-left: auto;
}
.ptaf-ai-model-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}
.ptaf-ai-reference-section {
  padding: 8px 0;
  border-bottom: 1px dashed #ecd8a8;
}
.ptaf-ai-reference-section:last-child {
  border-bottom: 0;
}
.ptaf-ai-reference-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 5px;
}

:host(.is-night) {
  --ptaf-bg: #0f172a;
  --ptaf-panel: #111c31;
  --ptaf-panel-2: #1a2941;
  --ptaf-text: #e7eef8;
  --ptaf-muted: #9db0c8;
  --ptaf-border: #2b405d;
  --ptaf-primary: #2f83df;
  --ptaf-primary-strong: #88bfff;
  --ptaf-accent: #f4b23c;
  --ptaf-danger: #ff8178;
  --ptaf-success: #58ca9c;
  --ptaf-shadow: 0 18px 60px rgba(0, 0, 0, 0.55);
  color-scheme: dark;
}

:host(.is-night) .ptaf-overlay {
  background: rgba(2, 8, 23, 0.68);
}

:host(.is-night) .ptaf-floating {
  background: linear-gradient(135deg, #287bd8, #15559c);
  box-shadow: 0 12px 35px rgba(0, 0, 0, 0.38);
}

:host(.is-night) .ptaf-header,
:host(.is-night) .ptaf-modal-card {
  background: var(--ptaf-bg);
}

:host(.is-night) .ptaf-card {
  background: #131f33;
  box-shadow: none;
}

:host(.is-night) .ptaf-search,
:host(.is-night) .ptaf-input,
:host(.is-night) .ptaf-textarea,
:host(.is-night) .ptaf-select,
:host(.is-night) .ptaf-btn,
:host(.is-night) .ptaf-page-btn,
:host(.is-night) .ptaf-shortcut-key,
:host(.is-night) .ptaf-choice-edit-option {
  color: var(--ptaf-text);
  background: #17243a;
  border-color: var(--ptaf-border);
}

:host(.is-night) .ptaf-btn:hover,
:host(.is-night) .ptaf-page-btn:hover,
:host(.is-night) .ptaf-shortcut-key:hover,
:host(.is-night) .ptaf-choice-edit-option:hover {
  color: var(--ptaf-primary-strong);
  background: #213653;
  border-color: #486a97;
}

:host(.is-night) .ptaf-btn.primary,
:host(.is-night) .ptaf-page-btn.is-active,
:host(.is-night) .ptaf-shortcut-key.is-capturing {
  color: #fff;
  background: var(--ptaf-primary);
  border-color: var(--ptaf-primary);
}

:host(.is-night) .ptaf-btn.primary:hover {
  color: #fff;
  background: #3a92e9;
  border-color: #3a92e9;
}

:host(.is-night) .ptaf-card-note,
:host(.is-night) .ptaf-field > label,
:host(.is-night) .ptaf-answer-header > label,
:host(.is-night) .ptaf-ai-group-title {
  color: #c9d7ea;
}

:host(.is-night) .ptaf-badge {
  color: #c9d7ea;
}

:host(.is-night) .ptaf-badge.success {
  color: #9ae3c4;
  background: #173c32;
}

:host(.is-night) .ptaf-badge.warning {
  color: #f4d38c;
  background: #40331b;
}

:host(.is-night) .ptaf-badge.danger {
  color: #ffaaa3;
  background: #482423;
}

:host(.is-night) .ptaf-badge.primary {
  color: #a9d4ff;
  background: #17385d;
}

:host(.is-night) .ptaf-answer-chip {
  color: #a9d4ff;
  background: #17385d;
  border-color: #2d5e91;
}

:host(.is-night) .ptaf-code-viewer {
  background: #0f172a;
  border-color: var(--ptaf-border);
}

:host(.is-night) .ptaf-code-viewer-head {
  color: #c9d7ea;
  background: #17243a;
  border-bottom-color: var(--ptaf-border);
}

:host(.is-night) .ptaf-code-viewer-body {
  background: #0f172a;
}

:host(.is-night) .ptaf-code-line-numbers {
  color: #8ea4be;
  background: #111c31;
  border-right-color: var(--ptaf-border);
}

:host(.is-night) .ptaf-code-content,
:host(.is-night) .ptaf-code-content code,
:host(.is-night) .token-identifier {
  color: #e5edf7;
}

:host(.is-night) .ptaf-ai-output {
  color: #d8e5f5;
  background: #111c31;
}

:host(.is-night) .ptaf-ai-reference {
  color: #f0dfbd;
  background: #2b2414;
  border-color: #6d5520;
}

:host(.is-night) .ptaf-ai-reference-head {
  color: #f2cf7b;
}

:host(.is-night) .ptaf-ai-reference-body {
  color: #f0dfbd;
}

:host(.is-night) .ptaf-ai-reference-body hr,
:host(.is-night) .ptaf-ai-reference-section {
  border-color: #6d5520;
}

:host(.is-night) .ptaf-markdown h3,
:host(.is-night) .ptaf-markdown h4,
:host(.is-night) .ptaf-markdown h5,
:host(.is-night) .ptaf-markdown h6 {
  color: #e7eef8;
}

:host(.is-night) .ptaf-markdown blockquote {
  color: #b8cbe0;
  background: #17243a;
  border-left-color: #4b6b92;
}

:host(.is-night) .ptaf-markdown code {
  color: #ffd0ad;
  background: #3a271e;
}

:host(.is-night) .ptaf-snapshot-frame {
  background: #0f172a;
}

:host(.is-night) .ptaf-drawer-expand {
  color: var(--ptaf-primary-strong);
  background: rgba(23, 36, 58, 0.96);
  border-color: var(--ptaf-border);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.32);
}

:host(.is-night) .ptaf-drawer-expand:hover {
  color: #fff;
  background: var(--ptaf-primary);
  border-color: var(--ptaf-primary);
}
.ptaf-about-trigger {
  position: fixed;
  right: 12px;
  left: auto;
  bottom: 0;
  z-index: 2147483000;
  min-height: 26px;
  padding: 3px 8px;
  color: var(--ptaf-muted);
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid var(--ptaf-border);
  border-radius: 7px;
  box-shadow: 0 3px 12px rgba(17, 40, 72, 0.12);
  font-size: 11px;
  line-height: 1;
  opacity: 0.72;
  transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
}

.ptaf-about-trigger:hover {
  color: var(--ptaf-primary-strong);
  background: #fff;
  opacity: 1;
}

.ptaf-about-brand {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 8px;
}

.ptaf-about-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  color: #fff;
  background: linear-gradient(135deg, #0c6bdc, #0757b8);
  border-radius: 11px;
  box-shadow: 0 7px 18px rgba(7, 87, 184, 0.24);
  font-size: 22px;
  font-weight: 800;
}

.ptaf-about-brand strong {
  display: block;
  font-size: 18px;
  line-height: 1.3;
}

.ptaf-about-brand div div {
  color: var(--ptaf-muted);
  font-size: 12px;
}

.ptaf-about-description {
  margin: 14px 0;
  line-height: 1.7;
}

.ptaf-about-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 14px 0;
}

.ptaf-about-links .ptaf-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
}

.ptaf-about-pending {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 5px 10px;
  color: var(--ptaf-muted);
  background: var(--ptaf-panel);
  border: 1px dashed var(--ptaf-border);
  border-radius: 7px;
  font-size: 12px;
}

.ptaf-about-note {
  margin-top: 14px;
  padding: 10px 11px;
  color: var(--ptaf-muted);
  background: var(--ptaf-panel);
  border: 1px solid var(--ptaf-border);
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
}

:host(.is-night) .ptaf-about-trigger {
  color: var(--ptaf-muted);
  background: rgba(23, 36, 58, 0.9);
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.3);
}

:host(.is-night) .ptaf-about-trigger:hover {
  color: var(--ptaf-primary-strong);
  background: #17243a;
}

:host(.is-night) .ptaf-about-mark {
  background: linear-gradient(135deg, #2f83df, #15559c);
  box-shadow: 0 7px 18px rgba(0, 0, 0, 0.28);
}
`;
      this.shadow.appendChild(styles);

      const shell = document.createElement('div');
      shell.innerHTML = `
        <button class="ptaf-floating" id="ptafOpenDrawer" type="button" title="打开 PTA 收藏夹">
          <span>PTA 收藏夹</span>
        </button>
        <button class="ptaf-about-trigger" id="ptafAbout" type="button" title="关于 PTA-Pro">About</button>

        <div class="ptaf-overlay" id="ptafDrawer">
          <aside class="ptaf-drawer" aria-label="PTA 收藏夹">
            <header class="ptaf-header">
              <div class="ptaf-header-title">
                <div>
                  <strong>PTA 收藏夹</strong>
                  <div class="ptaf-header-subtitle" id="ptafDrawerSubtitle">本地保存 · 题目快照 · 导出</div>
                </div>
              </div>
              <div class="ptaf-header-actions">
                <button class="ptaf-btn primary" id="ptafSelectExport" type="button">导出</button>
                <button class="ptaf-btn" id="ptafImport" type="button">导入 JSON</button>
                <button class="ptaf-btn" id="ptafAiSettings" type="button">AI 设置</button>
                <button class="ptaf-btn" id="ptafShortcutSettings" type="button">快捷键</button>
                <button class="ptaf-btn" id="ptafNightMode" type="button">夜间模式</button>
                <button class="ptaf-btn" id="ptafCloseDrawer" type="button">关闭</button>
              </div>
            </header>
            <div class="ptaf-body">
              <aside class="ptaf-sidebar" id="ptafTree"></aside>
              <main class="ptaf-main">
                <div class="ptaf-searchbar">
                  <input class="ptaf-search" id="ptafSearch" type="search" placeholder="搜索标题、题号、题集、标签、备注">
                </div>
                <section class="ptaf-list" id="ptafList"></section>
              </main>
            </div>
            <button class="ptaf-drawer-expand" id="ptafDrawerExpand" type="button" title="全屏显示"><<</button>
          </aside>
        </div>

        <div class="ptaf-overlay" id="ptafEditorModal">
          <div class="ptaf-modal-backdrop" data-ptaf-close="editor"></div>
          <section class="ptaf-modal-card">
            <header class="ptaf-modal-head">
              <h3 id="ptafEditorTitle">编辑收藏</h3>
              <button class="ptaf-btn small" data-ptaf-close="editor" type="button">关闭</button>
            </header>
            <div class="ptaf-modal-body" id="ptafEditorBody"></div>
            <footer class="ptaf-modal-foot">
              <button class="ptaf-btn danger" id="ptafDeleteBookmark" type="button">删除收藏</button>
              <button class="ptaf-btn" id="ptafCaptureBookmark" type="button">更新快照与提交</button>
              <button class="ptaf-btn primary" id="ptafSaveBookmark" type="button">保存</button>
            </footer>
          </section>
        </div>

        <div class="ptaf-overlay" id="ptafSnapshotModal">
          <div class="ptaf-modal-backdrop" data-ptaf-close="snapshot"></div>
          <section class="ptaf-modal-card wide">
            <header class="ptaf-modal-head">
              <h3 id="ptafSnapshotTitle">本地题目快照</h3>
              <button class="ptaf-btn small" data-ptaf-close="snapshot" type="button">关闭</button>
            </header>
            <div class="ptaf-modal-body" id="ptafSnapshotBody"></div>
            <footer class="ptaf-modal-foot">
              <button class="ptaf-btn" id="ptafSnapshotPrev" type="button">上一题</button>
              <button class="ptaf-btn" id="ptafSnapshotNext" type="button">下一题</button>
              <button class="ptaf-btn" id="ptafSnapshotAi" type="button">AI 助手</button>
              <button class="ptaf-btn" id="ptafToggleSnapshotLayout" type="button">并排查看</button>
              <button class="ptaf-btn" id="ptafOpenOriginal" type="button">打开原题</button>
              <button class="ptaf-btn" id="ptafRefreshSnapshot" type="button">刷新快照</button>
            </footer>
          </section>
        </div>

        <div class="ptaf-overlay" id="ptafBatchFolderModal">
          <div class="ptaf-modal-backdrop" data-ptaf-close="batchFolder"></div>
          <section class="ptaf-modal-card narrow">
            <header class="ptaf-modal-head">
              <h3 id="ptafBatchFolderTitle">选择收藏夹</h3>
              <button class="ptaf-btn small" data-ptaf-close="batchFolder" type="button">关闭</button>
            </header>
            <div class="ptaf-modal-body" id="ptafBatchFolderBody"></div>
            <footer class="ptaf-modal-foot">
              <button class="ptaf-btn" id="ptafBatchFolderNew" type="button">+ 新建收藏夹</button>
              <button class="ptaf-btn primary" id="ptafBatchFolderConfirm" type="button">确定</button>
            </footer>
          </section>
        </div>

        <div class="ptaf-overlay" id="ptafExportModal">
          <div class="ptaf-modal-backdrop" data-ptaf-close="export"></div>
          <section class="ptaf-modal-card narrow">
            <header class="ptaf-modal-head">
              <h3>导出</h3>
              <button class="ptaf-btn small" data-ptaf-close="export" type="button">关闭</button>
            </header>
            <div class="ptaf-modal-body" id="ptafExportFolderBody"></div>
            <footer class="ptaf-modal-foot">
              <button class="ptaf-btn" id="ptafExportSelectedMd" type="button">导出 Markdown</button>
              <button class="ptaf-btn primary" id="ptafExportSelectedJson" type="button">导出 JSON</button>
            </footer>
          </section>
        </div>

        <div class="ptaf-overlay" id="ptafShortcutModal">
          <div class="ptaf-modal-backdrop" data-ptaf-close="shortcut"></div>
          <section class="ptaf-modal-card narrow">
            <header class="ptaf-modal-head">
              <h3>自定义快捷键</h3>
              <button class="ptaf-btn small" data-ptaf-close="shortcut" type="button">关闭</button>
            </header>
            <div class="ptaf-modal-body" id="ptafShortcutBody"></div>
            <footer class="ptaf-modal-foot">
              <button class="ptaf-btn" id="ptafShortcutReset" type="button">恢复默认</button>
            </footer>
          </section>
        </div>

        <div class="ptaf-overlay" id="ptafAiSettingsModal">
          <div class="ptaf-modal-backdrop" data-ptaf-close="aiSettings"></div>
          <section class="ptaf-modal-card narrow">
            <header class="ptaf-modal-head">
              <h3>AI API 设置</h3>
              <button class="ptaf-btn small" data-ptaf-close="aiSettings" type="button">关闭</button>
            </header>
            <div class="ptaf-modal-body" id="ptafAiSettingsBody"></div>
            <footer class="ptaf-modal-foot">
              <button class="ptaf-btn primary" id="ptafAiSaveSettings" type="button">保存设置</button>
            </footer>
          </section>
        </div>

        <div class="ptaf-overlay" id="ptafAiModal">
          <div class="ptaf-modal-backdrop" data-ptaf-close="ai"></div>
          <section class="ptaf-modal-card wide">
            <header class="ptaf-modal-head">
              <h3 id="ptafAiTitle">AI 学习助手</h3>
              <button class="ptaf-btn small" data-ptaf-close="ai" type="button">关闭</button>
            </header>
            <div class="ptaf-modal-body" id="ptafAiBody"></div>
          </section>
        </div>

        <div class="ptaf-overlay" id="ptafAboutModal">
          <div class="ptaf-modal-backdrop" data-ptaf-close="about"></div>
          <section class="ptaf-modal-card narrow">
            <header class="ptaf-modal-head">
              <h3>关于 PTA-Pro</h3>
              <button class="ptaf-btn small" data-ptaf-close="about" type="button">关闭</button>
            </header>
            <div class="ptaf-modal-body">
              <div class="ptaf-about-brand">
                <span class="ptaf-about-mark">P</span>
                <div><strong>PTA-Pro</strong><div>PTA 收藏夹脚本</div></div>
              </div>
              <div class="ptaf-card-meta">版本 v${APP_VERSION} · 作者 UIM258</div>
              <p class="ptaf-about-description">在 PTA 中收藏和管理题目，保存本地快照、作答与判题记录，并使用 AI 学习助手辅助复习。</p>
              <div class="ptaf-about-links">
                <a class="ptaf-btn" href="${PROJECT_LINKS.repository}" target="_blank" rel="noopener noreferrer">GitHub 仓库</a>
                <a class="ptaf-btn" href="${PROJECT_LINKS.script}" target="_blank" rel="noopener noreferrer">安装脚本</a>
                <a class="ptaf-btn" href="${PROJECT_LINKS.issues}" target="_blank" rel="noopener noreferrer">问题反馈</a>
                ${PROJECT_LINKS.greasyfork ? `<a class="ptaf-btn" href="${PROJECT_LINKS.greasyfork}" target="_blank" rel="noopener noreferrer">GreasyFork</a>` : '<span class="ptaf-about-pending">GreasyFork 发布后补充</span>'}
              </div>
              <div class="ptaf-about-note">收藏、快照和设置默认仅保存在本地浏览器。请遵守 PTA 及所在学校的使用规范。</div>
            </div>
          </section>
        </div>

        <input id="ptafImportFile" type="file" accept=".json,application/json" hidden>
        <div class="ptaf-toast" id="ptafToast" hidden></div>
      `;
      this.shadow.appendChild(shell);

      this.drawerOverlay = this.shadow.getElementById('ptafDrawer');
      this.drawer = this.drawerOverlay.querySelector('.ptaf-drawer');
      this.tree = this.shadow.getElementById('ptafTree');
      this.list = this.shadow.getElementById('ptafList');
      this.search = this.shadow.getElementById('ptafSearch');
      this.editorModal = this.shadow.getElementById('ptafEditorModal');
      this.snapshotModal = this.shadow.getElementById('ptafSnapshotModal');
      this.batchFolderModal = this.shadow.getElementById('ptafBatchFolderModal');
      this.exportModal = this.shadow.getElementById('ptafExportModal');
      this.shortcutModal = this.shadow.getElementById('ptafShortcutModal');
      this.aiModal = this.shadow.getElementById('ptafAiModal');
      this.aiSettingsModal = this.shadow.getElementById('ptafAiSettingsModal');
      this.aboutModal = this.shadow.getElementById('ptafAboutModal');
      this.toastElement = this.shadow.getElementById('ptafToast');
      document.documentElement.appendChild(this.host);

      this.bindEvents();
      this.store.subscribe(() => this.render());
      this.render();
    }

    bindEvents() {
      this.shadow.getElementById('ptafOpenDrawer').addEventListener('click', this.openDrawer);
      this.shadow.getElementById('ptafCloseDrawer').addEventListener('click', () => this.closeDrawer());
      this.shadow.getElementById('ptafDrawerExpand').addEventListener('click', () => this.toggleDrawerFullscreen());
      this.shadow.getElementById('ptafSelectExport').addEventListener('click', () => this.openExportModal());
      this.shadow.getElementById('ptafShortcutSettings').addEventListener('click', () => this.openShortcutSettings());
      this.shadow.getElementById('ptafNightMode').addEventListener('click', () => this.toggleNightMode());
      this.shadow.getElementById('ptafAbout').addEventListener('click', () => this.openModal('about'));
      this.shadow.getElementById('ptafAiSettings').addEventListener('click', () => this.openAiSettings());
      this.shadow.getElementById('ptafSnapshotAi').addEventListener('click', () => this.openAiPanel(this.currentSnapshotId));
      this.shadow.getElementById('ptafAiSaveSettings').addEventListener('click', () => this.saveAiSettings());
      this.shadow.getElementById('ptafShortcutReset').addEventListener('click', () => this.resetShortcuts());
      this.shadow.getElementById('ptafImport').addEventListener('click', () => this.shadow.getElementById('ptafImportFile').click());
      this.shadow.getElementById('ptafImportFile').addEventListener('change', (event) => this.importJson(event));
      this.shadow.getElementById('ptafDeleteBookmark').addEventListener('click', () => this.deleteCurrentBookmark());
      this.shadow.getElementById('ptafCaptureBookmark').addEventListener('click', () => this.captureCurrentBookmark());
      this.shadow.getElementById('ptafSaveBookmark').addEventListener('click', () => this.saveEditor());
      this.shadow.getElementById('ptafSnapshotPrev').addEventListener('click', () => this.navigateSnapshot(-1));
      this.shadow.getElementById('ptafSnapshotNext').addEventListener('click', () => this.navigateSnapshot(1));
      this.shadow.getElementById('ptafToggleSnapshotLayout').addEventListener('click', () => this.toggleSnapshotLayout());
      this.shadow.getElementById('ptafOpenOriginal').addEventListener('click', () => this.openCurrentOriginal());
      this.shadow.getElementById('ptafRefreshSnapshot').addEventListener('click', () => this.refreshCurrentSnapshot());
      this.shadow.getElementById('ptafBatchFolderNew').addEventListener('click', () => this.createFolderForBatch());
      this.shadow.getElementById('ptafBatchFolderConfirm').addEventListener('click', () => this.confirmBatchFolder());
      this.shadow.getElementById('ptafExportSelectedMd').addEventListener('click', () => this.exportSelectedFolders('markdown'));
      this.shadow.getElementById('ptafExportSelectedJson').addEventListener('click', () => this.exportSelectedFolders('json'));

      window.addEventListener('keydown', (event) => this.handleGlobalKeydown(event), true);

      this.shadow.addEventListener('dragstart', (event) => this.handleSortDragStart(event));
      this.shadow.addEventListener('dragover', (event) => this.handleSortDragOver(event));
      this.shadow.addEventListener('drop', (event) => this.handleSortDrop(event));
      this.shadow.addEventListener('dragend', () => this.clearSortDragState());

      this.shadow.addEventListener('pointerdown', (event) => {
        if (event.target.closest('[data-ptaf-split-resizer]')) this.startSnapshotResize(event);
      });

      this.shadow.addEventListener('change', (event) => {
        if (event.target.id === 'ptafAiProvider') {
          const provider = AI_PROVIDERS[event.target.value];
          const baseUrl = this.shadow.getElementById('ptafAiBaseUrl');
          if (provider && provider.baseUrl && baseUrl) baseUrl.value = provider.baseUrl;
          return;
        }
        if (event.target.id === 'ptafExportSelectAll') {
          if (event.target.checked) {
            this.shadow.querySelectorAll('[data-ptaf-export-folder]').forEach((checkbox) => {
              checkbox.checked = false;
            });
          }
          return;
        }
        if (event.target.matches('[data-ptaf-export-folder]') && event.target.checked) {
          const selectAll = this.shadow.getElementById('ptafExportSelectAll');
          if (selectAll) selectAll.checked = false;
          return;
        }
        const itemCheckbox = event.target.closest('[data-ptaf-select-bookmark]');
        if (itemCheckbox) {
          if (itemCheckbox.checked) this.selectedBookmarkIds.add(itemCheckbox.value);
          else this.selectedBookmarkIds.delete(itemCheckbox.value);
          this.renderList();
          return;
        }
        if (event.target.id === 'ptafPageSize') {
          this.store.state.settings.pageSize = Number(event.target.value) || 20;
          this.store.save(true);
          this.currentPage = 1;
          this.renderList();
          return;
        }
        if (event.target.id === 'ptafSelectAll') {
          const visibleBookmarks = Core.filterBookmarks(this.store.state, this.selection, this.query);
          this.selectedBookmarkIds.clear();
          if (event.target.checked) visibleBookmarks.forEach((bookmark) => this.selectedBookmarkIds.add(bookmark.id));
          this.renderList();
        }
      });

      this.search.addEventListener('input', () => {
        this.query = this.search.value;
        this.currentPage = 1;
        this.renderList();
      });

      this.shadow.addEventListener('click', (event) => {
        const close = event.target.closest('[data-ptaf-close]');
        if (close) {
          this.closeModal(close.getAttribute('data-ptaf-close'));
          return;
        }

        const shortcutButton = event.target.closest('[data-ptaf-shortcut-action]');
        if (shortcutButton) {
          this.capturingShortcutAction = shortcutButton.getAttribute('data-ptaf-shortcut-action');
          this.renderShortcutSettings();
          return;
        }

        const aiDeleteField = event.target.closest('[data-ptaf-ai-delete-field]');
        if (aiDeleteField) {
          this.deleteAiReferenceField(aiDeleteField.getAttribute('data-ptaf-ai-delete-field'));
          return;
        }
        if (event.target.closest('[data-ptaf-ai-reference-delete]')) {
          this.deleteAiReference();
          return;
        }
        if (event.target.closest('#ptafAiDetectModels')) {
          this.detectAiModels();
          return;
        }
        const aiSkillButton = event.target.closest('[data-ptaf-ai-skill]');
        if (aiSkillButton) {
          this.runAiSkill(aiSkillButton.getAttribute('data-ptaf-ai-skill'));
          return;
        }
        const aiSettingsButton = event.target.closest('#ptafAiOpenSettings');
        if (aiSettingsButton) {
          this.openAiSettings();
          return;
        }

        if (event.target.closest('[data-ptaf-snapshot-edit-answer]')) {
          this.beginSnapshotAnswerEdit();
          return;
        }
        if (event.target.closest('[data-ptaf-snapshot-save-answer]')) {
          this.saveSnapshotAnswerEdit();
          return;
        }
        if (event.target.closest('[data-ptaf-snapshot-cancel-answer]')) {
          if (this.currentSnapshotId) this.openSnapshot(this.currentSnapshotId);
          return;
        }
        if (event.target.closest('[data-ptaf-snapshot-reset-answer]')) {
          this.resetSnapshotAnswerEdit();
          return;
        }

        const toggleButton = event.target.closest('[data-ptaf-toggle-set]');
        if (toggleButton) {
          const problemSetId = toggleButton.getAttribute('data-ptaf-toggle-set');
          const selectionValue = toggleButton.getAttribute('data-ptaf-select');
          if (selectionValue) this.selection = JSON.parse(selectionValue);
          if (this.expandedProblemSets.has(problemSetId)) this.expandedProblemSets.delete(problemSetId);
          else this.expandedProblemSets.add(problemSetId);
          this.selectedBookmarkIds.clear();
          this.batchMode = false;
          this.currentPage = 1;
          this.renderTree();
          this.renderList();
          return;
        }

        const treeButton = event.target.closest('[data-ptaf-select]');
        if (treeButton) {
          this.selection = JSON.parse(treeButton.getAttribute('data-ptaf-select'));
          this.selectedBookmarkIds.clear();
          this.batchMode = false;
          this.currentPage = 1;
          this.renderTree();
          this.renderList();
          return;
        }

        const selectedCard = event.target.closest('[data-ptaf-bookmark-card]');
        if (selectedCard && this.batchMode && !event.target.closest('a, button, input, select, textarea, label')) {
          const bookmarkId = selectedCard.getAttribute('data-ptaf-bookmark-card');
          if (this.selectedBookmarkIds.has(bookmarkId)) this.selectedBookmarkIds.delete(bookmarkId);
          else this.selectedBookmarkIds.add(bookmarkId);
          this.renderList();
          return;
        }

        const pageButton = event.target.closest('[data-ptaf-page]');
        if (pageButton) {
          this.currentPage = Number(pageButton.getAttribute('data-ptaf-page')) || 1;
          this.renderList();
          const list = this.shadow.getElementById('ptafList');
          if (list) list.scrollTop = 0;
          return;
        }

        const copyButton = event.target.closest('[data-ptaf-copy-code]');
        if (copyButton) {
          const code = copyButton.closest('.ptaf-code-viewer, .ptaf-code-block')?.querySelector('code, pre')?.textContent || '';
          if (code && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code).then(() => this.toast('代码已复制')).catch(() => this.toast('复制失败', 'error'));
          }
          return;
        }

        const batchToggle = event.target.closest('[data-ptaf-batch-toggle]');
        if (batchToggle) {
          this.batchMode = true;
          this.selectedBookmarkIds.clear();
          this.renderList();
          return;
        }

        const batchCancel = event.target.closest('[data-ptaf-batch-cancel]');
        if (batchCancel) {
          this.batchMode = false;
          this.selectedBookmarkIds.clear();
          this.renderList();
          return;
        }

        const batchButton = event.target.closest('[data-ptaf-batch-status]');
        if (batchButton) {
          this.applyBatchStatus(batchButton.getAttribute('data-ptaf-batch-status'));
          return;
        }

        const batchAction = event.target.closest('[data-ptaf-batch-action]');
        if (batchAction) {
          const action = batchAction.getAttribute('data-ptaf-batch-action');
          if (action === 'delete') this.applyBatchDelete();
          if (action === 'copy' || action === 'move') this.openBatchFolderModal(action);
          return;
        }

        const folderAction = event.target.closest('[data-ptaf-folder-action]');
        if (folderAction) {
          this.handleFolderAction(folderAction.getAttribute('data-ptaf-folder-action'));
          return;
        }

        const actionButton = event.target.closest('[data-ptaf-action]');
        if (actionButton) {
          this.handleListAction(actionButton.getAttribute('data-ptaf-action'), actionButton.getAttribute('data-bookmark-id'));
          return;
        }

        if (event.target.closest('#ptafNewFolder')) {
          this.createFolder();
          return;
        }

        if (event.target.closest('#ptafAddFolderInline')) {
          this.createFolderForEditor();
          return;
        }

        if (event.target.closest('#ptafSnapshotOpen')) {
          const bookmarkId = event.target.closest('#ptafSnapshotOpen').getAttribute('data-bookmark-id');
          this.openSnapshot(bookmarkId);
        }
      });

      this.drawerOverlay.addEventListener('click', (event) => {
        if (event.target === this.drawerOverlay) this.closeDrawer();
      });
    }

    openDrawer() {
      this.drawerOverlay.classList.add('is-open');
      this.drawer.classList.toggle('is-fullscreen', this.drawerFullscreen);
      this.render();
    }

    isEditableTarget(target) {
      if (!target || !target.closest) return false;
      return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
    }

    isModalOpen(name) {
      const modal = this.modalFor(name);
      return Boolean(modal && modal.classList.contains('is-open'));
    }

    shortcutFromEvent(event) {
      const modifiers = [];
      if (event.ctrlKey) modifiers.push('Ctrl');
      if (event.altKey) modifiers.push('Alt');
      if (event.shiftKey) modifiers.push('Shift');
      if (event.metaKey) modifiers.push('Meta');
      let key = String(event.key || '');
      if (key === ' ') key = 'Space';
      else if (key.length === 1) key = key.toUpperCase();
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return '';
      return modifiers.concat(key ? [key] : []).join('+');
    }

    openShortcutSettings() {
      this.capturingShortcutAction = '';
      this.renderShortcutSettings();
      this.openModal('shortcut');
    }

    renderShortcutSettings() {
      const body = this.shadow.getElementById('ptafShortcutBody');
      const shortcuts = this.store.state.settings.shortcuts || Core.DEFAULT_SHORTCUTS;
      body.innerHTML = `<div class="ptaf-card-meta ptaf-shortcut-help">点击右侧按键后，直接按新的快捷键组合。</div><div class="ptaf-shortcut-list">${Object.entries(SHORTCUT_ACTIONS).map(([action, label]) => `<div class="ptaf-shortcut-row"><div><strong>${escapeHtml(label)}</strong></div><button class="ptaf-shortcut-key ${this.capturingShortcutAction === action ? 'is-capturing' : ''}" type="button" data-ptaf-shortcut-action="${action}">${this.capturingShortcutAction === action ? '请按组合键...' : escapeHtml(shortcuts[action] || '未设置')}</button></div>`).join('')}</div>`;
    }

    captureShortcutKey(event) {
      const action = this.capturingShortcutAction;
      if (!action) return false;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        this.capturingShortcutAction = '';
        this.renderShortcutSettings();
        return true;
      }
      const combo = this.shortcutFromEvent(event);
      if (!combo) return true;
      if (!event.ctrlKey && !event.altKey && !event.metaKey) {
        this.toast('快捷键至少要包含 Ctrl、Alt 或 Meta', 'error');
        return true;
      }
      const conflict = Object.entries(this.store.state.settings.shortcuts || {}).find(([otherAction, value]) => otherAction !== action && value === combo);
      if (conflict) {
        this.toast(`快捷键与“${SHORTCUT_ACTIONS[conflict[0]] || conflict[0]}”冲突`, 'error');
        return true;
      }
      this.store.state.settings.shortcuts[action] = combo;
      this.store.save(true);
      this.capturingShortcutAction = '';
      this.renderShortcutSettings();
      this.toast(`快捷键已改为 ${combo}`);
      return true;
    }

    resetShortcuts() {
      this.store.state.settings.shortcuts = { ...Core.DEFAULT_SHORTCUTS };
      this.store.save(true);
      this.capturingShortcutAction = '';
      this.renderShortcutSettings();
      this.toast('快捷键已恢复默认');
    }

    showShortcutHelp() {
      const shortcuts = this.store.state.settings.shortcuts || Core.DEFAULT_SHORTCUTS;
      alert([
        'PTA 收藏夹快捷键',
        '',
        ...Object.entries(SHORTCUT_ACTIONS).map(([action, label]) => `${shortcuts[action]}：${label}`),
        'Esc：关闭当前弹窗或收藏夹',
        '',
        '可在“快捷键”设置页自定义。',
      ].join('\n'));
    }

    executeShortcutAction(action) {
      if (action === 'toggleDrawer') {
        if (this.drawerOverlay.classList.contains('is-open')) this.closeDrawer();
        else this.openDrawer();
        return;
      }
      if (action === 'toggleCurrentFavorite') {
        collectCurrentProblem();
        return;
      }
      if (action === 'toggleBatchMode') {
        if (!this.drawerOverlay.classList.contains('is-open')) this.openDrawer();
        this.batchMode = !this.batchMode;
        this.selectedBookmarkIds.clear();
        this.renderList();
        return;
      }
      if (action === 'editSnapshotAnswer' && this.isModalOpen('snapshot')) this.beginSnapshotAnswerEdit();
      if (action === 'snapshotPrev' && this.isModalOpen('snapshot')) this.navigateSnapshot(-1);
      if (action === 'snapshotNext' && this.isModalOpen('snapshot')) this.navigateSnapshot(1);
      if (action === 'snapshotSingle' && this.isModalOpen('snapshot')) {
        this.snapshotLayout = 'stacked';
        this.openSnapshot(this.currentSnapshotId);
      }
      if (action === 'snapshotSplit' && this.isModalOpen('snapshot')) {
        this.snapshotLayout = 'split';
        this.openSnapshot(this.currentSnapshotId);
      }
    }

    handleGlobalKeydown(event) {
      if (this.capturingShortcutAction && this.captureShortcutKey(event)) return;
      if (event.key === 'Escape') {
        if (this.isModalOpen('snapshot')) { this.closeModal('snapshot'); event.preventDefault(); return; }
        if (this.isModalOpen('editor')) { this.closeModal('editor'); event.preventDefault(); return; }
        if (this.isModalOpen('batchFolder')) { this.closeModal('batchFolder'); event.preventDefault(); return; }
        if (this.isModalOpen('export')) { this.closeModal('export'); event.preventDefault(); return; }
        if (this.isModalOpen('shortcut')) { this.closeModal('shortcut'); event.preventDefault(); return; }
        if (this.isModalOpen('aiSettings')) { this.closeModal('aiSettings'); event.preventDefault(); return; }
        if (this.isModalOpen('ai')) { this.closeModal('ai'); event.preventDefault(); return; }
        if (this.isModalOpen('about')) { this.closeModal('about'); event.preventDefault(); return; }
        if (this.drawerOverlay.classList.contains('is-open')) { this.closeDrawer(); event.preventDefault(); }
        return;
      }
      if (!event.altKey && !event.ctrlKey && !event.metaKey) return;
      const combo = this.shortcutFromEvent(event);
      if (!combo) return;
      const action = Object.entries(this.store.state.settings.shortcuts || Core.DEFAULT_SHORTCUTS)
        .find(([, value]) => value === combo)?.[0];
      if (!action) return;
      const editableAllowed = ['editSnapshotAnswer', 'snapshotPrev', 'snapshotNext', 'snapshotSingle', 'snapshotSplit'];
      if (this.isEditableTarget(event.target) && !editableAllowed.includes(action)) return;
      event.preventDefault();
      this.executeShortcutAction(action);
    }

    deleteAiReferenceField(field) {
      const bookmarkId = this.isModalOpen('editor') ? this.currentEditId : this.currentSnapshotId;
      const bookmark = this.store.state.bookmarks[bookmarkId];
      if (!bookmark || !bookmark.answer || !bookmark.answer.ai) return;
      const ai = Core.normalizeAi(bookmark.answer.ai);
      if (field === 'analysis') ai.analysis = '';
      if (field === 'answer') ai.answer = '';
      if (field === 'referenceCode') ai.referenceCode = '';
      if (field === 'knowledgePoints') ai.knowledgePoints = [];
      if (field === 'complexity') ai.complexity = { time: '', space: '' };
      this.store.updateBookmark(bookmarkId, { answer: { ...bookmark.answer, ai } });
      this.toast('已删除该部分 AI 内容');
      if (this.isModalOpen('editor')) this.renderEditor(this.store.state.bookmarks[bookmarkId]);
      else if (this.currentSnapshotId) this.openSnapshot(this.currentSnapshotId);
    }

    deleteAiReference() {
      const bookmarkId = this.isModalOpen('editor') ? this.currentEditId : this.currentSnapshotId;
      const bookmark = this.store.state.bookmarks[bookmarkId];
      if (!bookmark || !bookmark.answer || !bookmark.answer.ai) return;
      if (!confirm('确定删除这条 AI 生成的解析吗？')) return;
      this.store.updateBookmark(bookmarkId, {
        answer: {
          ...bookmark.answer,
          ai: Core.normalizeAi({}),
        },
      });
      this.toast('AI 解析已删除');
      if (this.isModalOpen('editor')) this.renderEditor(this.store.state.bookmarks[bookmarkId]);
      else if (this.currentSnapshotId) this.openSnapshot(this.currentSnapshotId);
    }

    openAiSettings() {
      const settings = this.store.state.settings.ai || {};
      this.aiModelOptions = this.aiModelOptions || [];
      const options = Object.entries(AI_PROVIDERS).map(([value, provider]) => `<option value="${value}" ${settings.provider === value ? 'selected' : ''}>${escapeHtml(provider.label)}</option>`).join('');
      const body = this.shadow.getElementById('ptafAiSettingsBody');
      body.innerHTML = `<div class="ptaf-field"><label for="ptafAiProvider">服务预设</label><select class="ptaf-select" id="ptafAiProvider">${options}</select></div>
        <div class="ptaf-field"><label for="ptafAiBaseUrl">API Base URL</label><input class="ptaf-input" id="ptafAiBaseUrl" value="${escapeHtml(settings.baseUrl || '')}" placeholder="https://api.example.com/v1"></div>
        <div class="ptaf-field"><label for="ptafAiModel">模型名称</label><div class="ptaf-ai-model-row"><input class="ptaf-input" id="ptafAiModel" list="ptafAiModelOptions" value="${escapeHtml(settings.model || '')}" placeholder="deepseek-chat"><button class="ptaf-btn" id="ptafAiDetectModels" type="button">自动获取模型</button></div><datalist id="ptafAiModelOptions">${this.aiModelOptions.map((model) => `<option value="${escapeHtml(model)}"></option>`).join('')}</datalist></div>
        <div class="ptaf-field"><label for="ptafAiKey">API Key</label><input class="ptaf-input" id="ptafAiKey" type="password" value="${escapeHtml(getAiKey())}" placeholder="sk-..."></div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
          <div class="ptaf-field"><label for="ptafAiTemperature">Temperature</label><input class="ptaf-input" id="ptafAiTemperature" type="number" step="0.1" value="${settings.temperature ?? 0.2}"></div>
          <div class="ptaf-field"><label for="ptafAiMaxTokens">最大 Token</label><input class="ptaf-input" id="ptafAiMaxTokens" type="number" value="${settings.maxTokens || 2500}"></div>
          <div class="ptaf-field"><label for="ptafAiTimeout">超时 ms</label><input class="ptaf-input" id="ptafAiTimeout" type="number" value="${settings.timeoutMs || 60000}"></div>
        </div>
        <div class="ptaf-card-meta">API Key 单独保存在本地，不会写入 JSON 或 Markdown。选择服务预设或填写 Base URL 后，可以点击“自动获取模型”读取 /models 列表。</div>`;
      this.openModal('aiSettings');
    }

    async detectAiModels() {
      const settings = {
        baseUrl: normalizeAiBaseUrl(this.shadow.getElementById('ptafAiBaseUrl').value),
        timeoutMs: Number(this.shadow.getElementById('ptafAiTimeout').value) || 60000,
      };
      const key = this.shadow.getElementById('ptafAiKey').value.trim();
      const button = this.shadow.getElementById('ptafAiDetectModels');
      if (button) { button.disabled = true; button.textContent = '获取中...'; }
      try {
        const models = await requestAiModels(settings, key);
        this.aiModelOptions = models;
        const modelInput = this.shadow.getElementById('ptafAiModel');
        if (modelInput && models.length && (!modelInput.value || !models.includes(modelInput.value))) modelInput.value = models[0];
        const list = this.shadow.getElementById('ptafAiModelOptions');
        if (list) list.innerHTML = models.map((model) => `<option value="${escapeHtml(model)}"></option>`).join('');
        this.toast(`已获取 ${models.length} 个模型`);
      } catch (error) {
        this.toast(`获取模型失败：${error.message || error}`, 'error');
      } finally {
        if (button) { button.disabled = false; button.textContent = '自动获取模型'; }
      }
    }

    saveAiSettings() {
      const settings = this.store.state.settings.ai || {};
      settings.provider = this.shadow.getElementById('ptafAiProvider').value;
      settings.baseUrl = normalizeAiBaseUrl(this.shadow.getElementById('ptafAiBaseUrl').value);
      settings.model = this.shadow.getElementById('ptafAiModel').value.trim();
      settings.temperature = Number(this.shadow.getElementById('ptafAiTemperature').value) || 0;
      settings.maxTokens = Number(this.shadow.getElementById('ptafAiMaxTokens').value) || 2500;
      settings.timeoutMs = Number(this.shadow.getElementById('ptafAiTimeout').value) || 60000;
      this.store.state.settings.ai = settings;
      setAiKey(this.shadow.getElementById('ptafAiKey').value.trim());
      this.store.save(true);
      this.closeModal('aiSettings');
      this.toast('AI 设置已保存');
    }

    async openAiPanel(bookmarkId) {
      const bookmark = this.store.state.bookmarks[bookmarkId];
      if (!bookmark) return;
      this.currentAiBookmarkId = bookmarkId;
      this.currentAiResponse = '';
      this.currentAiSkillId = '';
      this.aiIncludeAnswer = true;
      this.aiIncludeResult = true;
      this.aiLoading = false;
      this.renderAiPanel();
      this.openModal('ai');
    }

    renderAiPanel() {
      const bookmark = this.store.state.bookmarks[this.currentAiBookmarkId];
      if (!bookmark) return;
      const settings = this.store.state.settings.ai || {};
      const body = this.shadow.getElementById('ptafAiBody');
      const skillButton = (action) => {
        const skill = AI_SKILLS[action];
        return `<button class="ptaf-btn small ${skill.category === 'reference' ? 'primary' : ''}" type="button" data-ptaf-ai-skill="${action}">${escapeHtml(skill.label)}</button>`;
      };
      body.innerHTML = `<div class="ptaf-ai-head"><div><strong>${escapeHtml(bookmark.label ? `${bookmark.label} ${bookmark.title}` : bookmark.title)}</strong><div class="ptaf-card-meta">${settings.model ? `模型：${escapeHtml(settings.model)}` : '尚未配置 AI API'}</div></div><button class="ptaf-btn small" id="ptafAiOpenSettings" type="button">AI 设置</button></div>
        <div class="ptaf-ai-context"><label>发送上下文：<input id="ptafAiIncludeAnswer" type="checkbox" checked> 我的作答/代码</label><label><input id="ptafAiIncludeResult" type="checkbox" checked> PTA 可见评测</label></div>
        <div class="ptaf-ai-group"><div class="ptaf-ai-group-title">题目资料（可保存）</div><div class="ptaf-ai-actions">${['analyze-problem', 'reference-solution', 'knowledge-points'].map(skillButton).join('')}</div></div>
        <div class="ptaf-ai-group"><div class="ptaf-ai-group-title">我的内容（临时，不保存）</div><div class="ptaf-ai-actions">${['review-my-code', 'hint-progression', 'debug-compile-error', 'generate-edge-cases'].map(skillButton).join('')}</div></div>
        <div class="ptaf-ai-result"><div class="ptaf-ai-group-title">AI 输出</div><div class="ptaf-ai-output ptaf-markdown">${this.aiLoading ? '<p>正在请求 AI...</p>' : this.currentAiResponse ? renderMarkdownHtml(this.currentAiResponse) : '<p>选择一个操作开始。</p>'}</div></div>`;
    }

    buildAiContext(bookmark, snapshot) {
      const includeAnswer = this.shadow.getElementById('ptafAiIncludeAnswer')?.checked !== false;
      const includeResult = this.shadow.getElementById('ptafAiIncludeResult')?.checked !== false;
      const ai = Core.normalizeAi(bookmark.answer && bookmark.answer.ai);
      const latest = bookmark.submissions && bookmark.submissions[0];
      const localAnswers = snapshot && snapshot.localAnswers ? snapshot.localAnswers.map((answer) => answer.answer).filter(Boolean).join('；') : '';
      const answerText = localAnswers || (bookmark.answer && bookmark.answer.userAnswer) || '';
      const code = snapshot && snapshot.localCode ? snapshot.localCode : latest && latest.code ? latest.code : snapshot && snapshot.codeDraft || '';
      const parts = [
        `题目：${bookmark.label ? bookmark.label + ' ' : ''}${bookmark.title}`,
        `题型：${Core.typeLabel(bookmark.type)}`,
        `题目集：${bookmark.problemSetName || '未命名'}`,
      ];
      if (snapshot && (snapshot.markdown || snapshot.text)) parts.push('题目内容：\n' + (snapshot.markdown || snapshot.text).slice(0, 20000));
      if (includeAnswer && answerText) parts.push('用户当前作答：\n' + answerText);
      if (includeAnswer && code) parts.push('用户当前代码：\n' + code.slice(0, 30000));
      if (includeResult && latest) {
        parts.push('PTA 最近提交：\n' + JSON.stringify({ language: latest.language, compiler: latest.compiler, status: latest.rawStatus || latest.status, score: latest.score, maxScore: latest.maxScore, testPoints: latest.testPoints, compileOutput: latest.compileOutput }, null, 2).slice(0, 20000));
      }
      if (snapshot && snapshot.judgeConstraints) parts.push('题目限制：\n' + JSON.stringify(snapshot.judgeConstraints, null, 2));
      if (ai.analysis || ai.answer) parts.push('已有 AI 解析（仅作参考，不要当作标准答案）：\n' + [ai.analysis, ai.answer].filter(Boolean).join('\n').slice(0, 10000));
      return parts.join('\n\n');
    }

    async runAiSkill(action) {
      const bookmark = this.store.state.bookmarks[this.currentAiBookmarkId];
      if (!bookmark) return;
      const settings = this.store.state.settings.ai || {};
      if (!settings.baseUrl || !settings.model) {
        this.openAiSettings();
        return;
      }
      const snapshot = await this.snapshotStore.get(bookmark.id);
      this.aiIncludeAnswer = this.shadow.getElementById('ptafAiIncludeAnswer')?.checked !== false;
      this.aiIncludeResult = this.shadow.getElementById('ptafAiIncludeResult')?.checked !== false;
      this.aiLoading = true;
      this.currentAiSkillId = action;
      this.currentAiResponse = '';
      this.renderAiPanel();
      try {
        const content = await requestAiCompletion(action, this.buildAiContext(bookmark, snapshot), { settings, apiKey: getAiKey() });
        this.currentAiResponse = content;
        const skill = AI_SKILLS[action];
        if (skill.persist) {
          const currentAi = Core.normalizeAi(bookmark.answer && bookmark.answer.ai);
          if (skill.target === 'analysis') currentAi.analysis = content;
          if (skill.target === 'answer') currentAi.answer = content;
          if (skill.target === 'knowledgePoints') currentAi.knowledgePoints = content.split(/\n+/).map((line) => line.replace(/^[-*#\d.\s]+/, '').trim()).filter(Boolean).slice(0, 30);
          currentAi.model = settings.model;
          currentAi.skillId = action;
          currentAi.skillVersion = '1';
          currentAi.generatedAt = Date.now();
          currentAi.basedOnSnapshotHash = snapshot ? snapshot.contentHash || '' : '';
          this.store.updateBookmark(bookmark.id, { answer: { ...bookmark.answer, ai: currentAi } });
          this.toast('AI 解析已保存到参考答案与解析');
        } else {
          this.toast('AI 临时分析完成，未写入收藏数据');
        }
      } catch (error) {
        warn('AI 请求失败', error);
        this.currentAiResponse = '请求失败：' + (error.message || error);
        this.toast(this.currentAiResponse, 'error');
      } finally {
        this.aiLoading = false;
        this.renderAiPanel();
      }
    }

    toggleDrawerFullscreen() {
      this.drawerFullscreen = !this.drawerFullscreen;
      this.drawer.classList.toggle('is-fullscreen', this.drawerFullscreen);
      const button = this.shadow.getElementById('ptafDrawerExpand');
      if (button) {
        button.textContent = this.drawerFullscreen ? '>>' : '<<';
        button.title = this.drawerFullscreen ? '恢复半屏显示' : '全屏显示';
      }
    }

    toggleNightMode() {
      const enabled = !Boolean(this.store.state.settings.nightMode);
      this.store.state.settings.nightMode = enabled;
      this.applyNightMode(false);
      this.store.save(true);
      this.applyNightMode(true);
      this.toast(enabled ? '已开启夜间模式' : '已关闭夜间模式');
    }

    applyNightMode(syncSnapshot) {
      const enabled = Boolean(this.store.state.settings.nightMode);
      if (this.host) this.host.classList.toggle('is-night', enabled);
      const button = this.shadow && this.shadow.getElementById('ptafNightMode');
      if (button) {
        button.textContent = enabled ? '日间模式' : '夜间模式';
        button.title = enabled ? '切换到日间模式' : '切换到夜间模式';
      }
      document.querySelectorAll(`[${STAR_ATTR}]`).forEach((host) => {
        host.setAttribute('data-ptaf-night', enabled ? '1' : '0');
      });
      if (syncSnapshot && this.isModalOpen('snapshot') && this.currentSnapshotId) {
        this.openSnapshot(this.currentSnapshotId).catch((error) => warn('切换夜间模式后刷新快照失败', error));
      }
    }

    closeDrawer() {
      this.drawerOverlay.classList.remove('is-open');
    }

    modalFor(name) {
      if (name === 'editor') return this.editorModal;
      if (name === 'snapshot') return this.snapshotModal;
      if (name === 'batchFolder') return this.batchFolderModal;
      if (name === 'export') return this.exportModal;
      if (name === 'shortcut') return this.shortcutModal;
      if (name === 'ai') return this.aiModal;
      if (name === 'aiSettings') return this.aiSettingsModal;
      if (name === 'about') return this.aboutModal;
      return null;
    }

    openModal(name) {
      const modal = this.modalFor(name);
      if (modal) modal.classList.add('is-open');
    }

    closeModal(name) {
      if (name === 'editor' && this.currentEditId) {
        const bookmark = this.store.state.bookmarks[this.currentEditId];
        if (bookmark && !Core.isCollected(bookmark)) {
          this.store.remove(bookmark.id);
          this.snapshotStore.remove(bookmark.id).catch((error) => warn('删除临时快照失败', error));
        }
      }
      const modal = this.modalFor(name);
      if (modal) modal.classList.remove('is-open');
    }

    toast(message, kind) {
      if (!this.toastElement) return;
      this.toastElement.textContent = message;
      this.toastElement.className = `ptaf-toast${kind === 'error' ? ' error' : ''}`;
      this.toastElement.hidden = false;
      if (this.toastTimer) clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => {
        this.toastElement.hidden = true;
      }, 2600);
    }

    render() {
      if (!this.shadow) return;
      const floatingCount = this.shadow.getElementById('ptafFloatingCount');
      if (floatingCount) floatingCount.textContent = String(this.store.bookmarkCount);
      this.shadow.getElementById('ptafDrawerSubtitle').textContent = `${this.store.bookmarkCount} 道题 · ${Core.listUserFolders(this.store.state).length} 个自定义收藏夹`;
      this.renderTree();
      this.renderList();
      refreshStars();
      this.applyNightMode(false);
    }

    treeButton(label, count, selection, className, problemSetId, folderId) {
      const active = selectionIsActive(this.selection, selection);
      const encoded = escapeHtml(JSON.stringify(selection));
      const toggleAttribute = problemSetId ? ` data-ptaf-toggle-set="${escapeHtml(problemSetId)}"` : '';
      const folderAttribute = folderId ? ` data-ptaf-folder-drag="${escapeHtml(folderId)}" draggable="true"` : '';
      return `<button class="ptaf-tree-item ${className || ''} ${active ? 'is-active' : ''}" type="button" data-ptaf-select="${encoded}"${toggleAttribute}${folderAttribute}>
        ${folderId ? '<span class="ptaf-drag-handle" aria-hidden="true">⋮⋮</span>' : ''}
        <span class="ptaf-tree-name">${escapeHtml(label)}</span>
        <span class="ptaf-tree-count">${count}</span>
      </button>`;
    }

    renderTree() {
      if (!this.tree) return;
      const groups = Core.groupBookmarks(this.store.state);
      const parts = ['<div class="ptaf-sidebar-section">'];
      parts.push('<div class="ptaf-sidebar-heading"><span>快捷</span></div>');
      parts.push(this.treeButton('全部收藏', groups.total, { kind: 'all' }));
      const unpublished = Object.values(this.store.state.bookmarks).filter((bookmark) => !bookmark.answer || bookmark.answer.visibility !== 'revealed').length;
      parts.push(this.treeButton('答案未公布', unpublished, { kind: 'unpublished-answer' }));
      parts.push('</div>');

      parts.push('<div class="ptaf-sidebar-section">');
      parts.push('<div class="ptaf-sidebar-heading"><span>按题目集</span></div>');
      groups.problemSets.forEach((problemSet) => {
        const expanded = this.expandedProblemSets.has(problemSet.id);
        parts.push(this.treeButton(problemSet.name, problemSet.count, { kind: 'smart-set', problemSetId: problemSet.id }, '', problemSet.id));
        if (expanded) {
          problemSet.types.forEach((type) => {
            parts.push(this.treeButton(type.label, type.count, { kind: 'smart-type', problemSetId: problemSet.id, type: type.type }, 'child'));
          });
        }
      });
      if (!groups.problemSets.length) parts.push('<div class="ptaf-empty">还没有收藏</div>');
      parts.push('</div>');

      parts.push('<div class="ptaf-sidebar-section">');
      parts.push('<div class="ptaf-sidebar-heading"><span>我的收藏夹</span><button class="ptaf-icon-btn" id="ptafNewFolder" type="button" title="新建收藏夹">+</button></div>');
      groups.orderedFolders.forEach((folder) => {
        parts.push(this.treeButton(folder.name, folder.count, { kind: 'user', folderId: folder.id }, '', null, folder.id));
      });
      if (!groups.userFolders.length) parts.push('<div class="ptaf-empty" style="padding:12px 4px">暂无自定义收藏夹</div>');
      parts.push('</div>');
      this.tree.innerHTML = parts.join('');
    }

    renderList() {
      if (!this.list) return;
      const bookmarks = Core.filterBookmarks(this.store.state, this.selection, this.query);
      this.currentListBookmarkIds = bookmarks.map((bookmark) => bookmark.id);
      const pageSize = Math.max(1, Number(this.store.state.settings.pageSize) || 20);
      const totalPages = Math.max(1, Math.ceil(bookmarks.length / pageSize));
      this.currentPage = Math.min(Math.max(1, this.currentPage || 1), totalPages);
      const pageStart = (this.currentPage - 1) * pageSize;
      const pageBookmarks = bookmarks.slice(pageStart, pageStart + pageSize);
      const visibleIds = new Set(bookmarks.map((bookmark) => bookmark.id));
      Array.from(this.selectedBookmarkIds).forEach((bookmarkId) => {
        if (!visibleIds.has(bookmarkId)) this.selectedBookmarkIds.delete(bookmarkId);
      });
      const selectedCount = this.selectedBookmarkIds.size;
      const heading = selectionLabel(this.selection, this.store.state);
      let folderActions = '';
      if (this.selection.kind === 'user' && this.selection.folderId !== Core.DEFAULT_FOLDER_ID) {
        folderActions = '<button class="ptaf-btn small" type="button" data-ptaf-folder-action="rename">重命名</button><button class="ptaf-btn small danger" type="button" data-ptaf-folder-action="delete">删除</button>';
      } else if (this.selection.kind === 'smart-set') {
        folderActions = '<button class="ptaf-btn small danger" type="button" data-ptaf-folder-action="delete-smart">删除该题集收藏</button>';
      } else if (this.selection.kind === 'smart-type') {
        folderActions = '<button class="ptaf-btn small danger" type="button" data-ptaf-folder-action="delete-smart">删除该题型收藏</button>';
      }
      const statusButtons = Object.entries(Core.STATUS_LABELS)
        .map(([value, label]) => `<button class="ptaf-btn small" type="button" data-ptaf-batch-status="${value}">${escapeHtml(label)}</button>`)
        .join('');
      const batchToolbar = this.batchMode
        ? `<label class="ptaf-select-all"><input id="ptafSelectAll" type="checkbox" ${bookmarks.length && selectedCount === bookmarks.length ? 'checked' : ''}>全选</label>
           <span>已选 ${selectedCount}</span>
           <button class="ptaf-btn small danger" type="button" data-ptaf-batch-action="delete">删除</button>
           <button class="ptaf-btn small" type="button" data-ptaf-batch-action="copy">复制</button>
           <button class="ptaf-btn small" type="button" data-ptaf-batch-action="move">移动</button>
           ${statusButtons}
           <button class="ptaf-btn small" type="button" data-ptaf-batch-cancel>取消</button>`
        : `<button class="ptaf-btn small" type="button" data-ptaf-batch-toggle>批量管理</button>${folderActions}`;
      const headingHtml = `<div class="ptaf-list-heading">
        <div class="ptaf-list-title"><strong>${escapeHtml(heading)}</strong><span>${bookmarks.length} 条</span></div>
        <div class="ptaf-batch-controls">${batchToolbar}</div>
      </div>`;
      if (!bookmarks.length) {
        this.list.innerHTML = `${headingHtml}<div class="ptaf-empty">没有符合条件的收藏。<br>在题目旁边点击星标即可收藏。</div>`;
        return;
      }

      const cards = pageBookmarks.map((bookmark) => {
        const contentStatus = contentBadge(bookmark);
        const answerVisibility = bookmark.answer && bookmark.answer.visibility ? bookmark.answer.visibility : 'unknown';
        const latest = bookmark.submissions && bookmark.submissions[0];
        const statusText = latest ? Core.statusSummary(bookmark) : Core.statusLabel(bookmark.status);
        const tags = (bookmark.tags || []).map((tag) => `<span class="ptaf-badge">${escapeHtml(tag)}</span>`).join('');
        return `<article class="ptaf-card ${this.batchMode ? 'is-batch-selectable' : ''} ${this.selectedBookmarkIds.has(bookmark.id) ? 'is-selected' : ''}" data-ptaf-bookmark-card="${escapeHtml(bookmark.id)}" draggable="${this.batchMode ? 'false' : 'true'}">
          <div class="ptaf-card-head">
            ${this.batchMode ? `<label class="ptaf-select-box" title="选择用于批量管理"><input type="checkbox" data-ptaf-select-bookmark value="${escapeHtml(bookmark.id)}" ${this.selectedBookmarkIds.has(bookmark.id) ? 'checked' : ''}></label>` : '<span class="ptaf-drag-handle ptaf-card-drag-handle" title="拖动排序" aria-hidden="true">⋮⋮</span>'}
            <h4 class="ptaf-card-title">
              ${bookmark.label ? `<span>${escapeHtml(bookmark.label)}</span> ` : ''}
              <a href="${escapeHtml(bookmark.url)}" target="_blank" rel="noreferrer">${escapeHtml(bookmark.title)}</a>
            </h4>
            <span class="ptaf-badge ${bookmark.status === 'done' ? 'success' : ''}">${escapeHtml(Core.statusLabel(bookmark.status))}</span>
          </div>
          <div class="ptaf-card-meta">${escapeHtml(bookmark.problemSetName || '未命名题目集')} · ${escapeHtml(Core.typeLabel(bookmark.type))}</div>
          <div class="ptaf-badges">
            <span class="ptaf-badge ${bookmark.content && bookmark.content.status === 'full' ? 'success' : 'warning'}">${escapeHtml(contentStatus)}</span>
            <span class="ptaf-badge ${answerBadgeClass(answerVisibility)}">${escapeHtml(Core.answerVisibilityLabel(answerVisibility))}</span>
            <span class="ptaf-badge ${statusBadgeClass(latest && latest.status)}">${escapeHtml(statusText)}</span>
            ${tags}
          </div>
          ${bookmark.note ? `<div class="ptaf-card-note">${escapeHtml(bookmark.note)}</div>` : ''}
          <div class="ptaf-card-actions">
            <button class="ptaf-btn small" type="button" data-ptaf-action="edit" data-bookmark-id="${escapeHtml(bookmark.id)}">管理</button>
            <button class="ptaf-btn small" type="button" data-ptaf-action="snapshot" data-bookmark-id="${escapeHtml(bookmark.id)}">本地快照</button>
            <button class="ptaf-btn small" type="button" data-ptaf-action="capture" data-bookmark-id="${escapeHtml(bookmark.id)}">更新快照</button>
            <button class="ptaf-btn small" type="button" data-ptaf-action="ai" data-bookmark-id="${escapeHtml(bookmark.id)}">AI</button>
          </div>
        </article>`;
      }).join('');
      const pageButtons = [];
      for (let page = 1; page <= totalPages; page += 1) {
        if (totalPages > 7 && page !== 1 && page !== totalPages && Math.abs(page - this.currentPage) > 1) {
          if (pageButtons[pageButtons.length - 1] !== '...') pageButtons.push('...');
          continue;
        }
        pageButtons.push(`<button class="ptaf-page-btn ${page === this.currentPage ? 'is-active' : ''}" type="button" data-ptaf-page="${page}">${page}</button>`);
      }
      const paginationHtml = `<div class="ptaf-pagination"><button class="ptaf-btn small" type="button" data-ptaf-page="${this.currentPage - 1}" ${this.currentPage <= 1 ? 'disabled' : ''}>上一页</button><div class="ptaf-page-numbers">${pageButtons.join('')}</div><button class="ptaf-btn small" type="button" data-ptaf-page="${this.currentPage + 1}" ${this.currentPage >= totalPages ? 'disabled' : ''}>下一页</button><span>第 ${this.currentPage} / ${totalPages} 页</span><select class="ptaf-select ptaf-page-size" id="ptafPageSize"><option value="10" ${pageSize === 10 ? 'selected' : ''}>10 条/页</option><option value="20" ${pageSize === 20 ? 'selected' : ''}>20 条/页</option><option value="50" ${pageSize === 50 ? 'selected' : ''}>50 条/页</option></select></div>`;
      this.list.innerHTML = headingHtml + cards + paginationHtml;
    }

    applyBatchDelete() {
      const bookmarkIds = Array.from(this.selectedBookmarkIds);
      if (!bookmarkIds.length) {
        this.toast('请先勾选要删除的题目', 'error');
        return;
      }
      if (!confirm(`确定删除选中的 ${bookmarkIds.length} 道题及其本地快照吗？`)) return;
      bookmarkIds.forEach((bookmarkId) => {
        this.store.remove(bookmarkId);
        this.snapshotStore.remove(bookmarkId).catch((error) => warn('删除快照失败', error));
      });
      this.selectedBookmarkIds.clear();
      this.batchMode = false;
      this.render();
      this.toast(`已删除 ${bookmarkIds.length} 道题`);
    }

    openBatchFolderModal(action) {
      if (!this.selectedBookmarkIds.size) {
        this.toast('请先勾选要管理的题目', 'error');
        return;
      }
      this.batchFolderAction = action;
      this.shadow.getElementById('ptafBatchFolderTitle').textContent = action === 'copy' ? '复制到收藏夹' : '移动到收藏夹';
      this.renderBatchFolderChooser();
      this.openModal('batchFolder');
    }

    renderBatchFolderChooser(selectedFolderId) {
      const body = this.shadow.getElementById('ptafBatchFolderBody');
      const folders = Object.values(this.store.state.folders)
        .sort((a, b) => Number(b.system) - Number(a.system) || a.name.localeCompare(b.name, 'zh-CN'));
      const selectedId = selectedFolderId || (folders[0] && folders[0].id) || '';
      body.innerHTML = `<div class="ptaf-folder-choice-list">${folders.map((folder) => `<label class="ptaf-folder-choice"><input type="radio" name="ptafBatchFolderChoice" value="${escapeHtml(folder.id)}" ${folder.id === selectedId ? 'checked' : ''}> <span>${escapeHtml(folder.name)}</span></label>`).join('')}</div>`;
    }

    createFolderForBatch() {
      const name = prompt('新建收藏夹名称');
      if (!name || !name.trim()) return;
      try {
        const folder = this.store.addFolder(name.trim(), null);
        this.renderBatchFolderChooser(folder.id);
        this.toast(`已创建收藏夹：${folder.name}`);
      } catch (error) {
        this.toast(error.message || '创建收藏夹失败', 'error');
      }
    }

    confirmBatchFolder() {
      const selected = this.shadow.querySelector('input[name="ptafBatchFolderChoice"]:checked');
      if (!selected) {
        this.toast('请选择目标收藏夹', 'error');
        return;
      }
      const destinationId = selected.value;
      const action = this.batchFolderAction;
      this.closeModal('batchFolder');
      this.applyBatchFolder(action, destinationId);
    }

    applyBatchFolder(action, destinationId) {
      const bookmarkIds = Array.from(this.selectedBookmarkIds);
      if (!bookmarkIds.length) {
        this.toast('请先勾选要管理的题目', 'error');
        return;
      }
      if (!destinationId) {
        this.toast('请先选择目标收藏夹', 'error');
        return;
      }
      const currentFolderId = this.selection.kind === 'user' ? this.selection.folderId : '';
      bookmarkIds.forEach((bookmarkId) => {
        const bookmark = this.store.state.bookmarks[bookmarkId];
        if (!bookmark) return;
        if (action === 'copy') {
          bookmark.folderIds = Core.unique([...(bookmark.folderIds || []), destinationId]);
        } else {
          const remaining = currentFolderId
            ? (bookmark.folderIds || []).filter((folderId) => folderId !== currentFolderId)
            : [];
          bookmark.folderIds = Core.unique([...remaining, destinationId]);
        }
        bookmark.updatedAt = Date.now();
      });
      this.store.save(true);
      this.selectedBookmarkIds.clear();
      this.renderList();
      this.toast(action === 'copy' ? '已复制到目标收藏夹' : '已移动到目标收藏夹');
    }

    applyBatchStatus(status) {
      const bookmarkIds = Array.from(this.selectedBookmarkIds);
      if (!bookmarkIds.length) {
        this.toast('请先勾选要批量管理的题目', 'error');
        return;
      }
      this.store.setStatuses(bookmarkIds, status);
      this.selectedBookmarkIds.clear();
      this.renderList();
      this.toast(`已将 ${bookmarkIds.length} 道题设为${Core.statusLabel(status)}`);
    }
    handleSortDragStart(event) {
      const folder = event.target.closest('[data-ptaf-folder-drag]');
      if (folder) {
        this.dragState = { type: 'folder', id: folder.getAttribute('data-ptaf-folder-drag') };
      } else {
        const card = event.target.closest('[data-ptaf-bookmark-card]');
        if (!card || this.batchMode) return;
        this.dragState = { type: 'bookmark', id: card.getAttribute('data-ptaf-bookmark-card') };
      }
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', this.dragState.id);
      }
      event.target.closest('[data-ptaf-folder-drag], [data-ptaf-bookmark-card]')?.classList.add('is-dragging');
    }

    handleSortDragOver(event) {
      if (!this.dragState) return;
      const selector = this.dragState.type === 'folder' ? '[data-ptaf-folder-drag]' : '[data-ptaf-bookmark-card]';
      const target = event.target.closest(selector);
      if (!target) return;
      const targetId = target.getAttribute(this.dragState.type === 'folder' ? 'data-ptaf-folder-drag' : 'data-ptaf-bookmark-card');
      if (!targetId || targetId === this.dragState.id) return;
      event.preventDefault();
      this.shadow.querySelectorAll('.is-drag-over').forEach((element) => element.classList.remove('is-drag-over'));
      target.classList.add('is-drag-over');
    }

    handleSortDrop(event) {
      if (!this.dragState) return;
      const selector = this.dragState.type === 'folder' ? '[data-ptaf-folder-drag]' : '[data-ptaf-bookmark-card]';
      const target = event.target.closest(selector);
      if (!target) return;
      const targetId = target.getAttribute(this.dragState.type === 'folder' ? 'data-ptaf-folder-drag' : 'data-ptaf-bookmark-card');
      if (!targetId || targetId === this.dragState.id) return;
      event.preventDefault();
      const rect = target.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      const move = (ids) => {
        const without = ids.filter((id) => id !== this.dragState.id);
        const targetIndex = without.indexOf(targetId);
        const insertIndex = targetIndex < 0 ? without.length : targetIndex + (after ? 1 : 0);
        without.splice(insertIndex, 0, this.dragState.id);
        return without;
      };
      if (this.dragState.type === 'folder') {
        const ids = Core.listOrderedFolders(this.store.state).map((folder) => folder.id);
        this.store.state.settings.folderOrder = move(ids);
        this.store.save(true);
        this.renderTree();
      } else {
        const ids = (this.currentListBookmarkIds || []).slice();
        const key = Core.bookmarkOrderKey(this.selection);
        this.store.state.settings.bookmarkOrder[key] = move(ids);
        this.store.save(true);
        this.renderList();
      }
      this.clearSortDragState();
    }

    clearSortDragState() {
      this.dragState = null;
      this.shadow.querySelectorAll('.is-dragging, .is-drag-over').forEach((element) => {
        element.classList.remove('is-dragging', 'is-drag-over');
      });
    }

    handleListAction(action, bookmarkId) {
      if (action === 'edit') this.openEditor(bookmarkId);
      if (action === 'snapshot') this.openSnapshot(bookmarkId);
      if (action === 'capture') this.captureBookmark(bookmarkId);
      if (action === 'ai') this.openAiPanel(bookmarkId);
    }

    openEditor(bookmarkId) {
      const bookmark = this.store.state.bookmarks[bookmarkId];
      if (!bookmark) return;
      this.currentEditId = bookmarkId;
      this.editorForcedFolderId = '';
      this.renderEditor(bookmark);
      this.openModal('editor');
    }

    renderEditor(bookmark, forceFolderId) {
      const body = this.shadow.getElementById('ptafEditorBody');
      const forcedFolderId = forceFolderId || this.editorForcedFolderId || '';
      const folders = Object.values(this.store.state.folders)
        .sort((a, b) => Number(b.system) - Number(a.system) || a.name.localeCompare(b.name, 'zh-CN'));
      const folderChecks = folders.map((folder) => {
        const checked = (bookmark.folderIds || []).includes(folder.id) || folder.id === forcedFolderId;
        return `<label class="ptaf-check"><input type="checkbox" data-ptaf-folder value="${escapeHtml(folder.id)}" ${checked ? 'checked' : ''}>${escapeHtml(folder.name)}</label>`;
      }).join('');

      const referenceParts = [];
      if (bookmark.answer && bookmark.answer.officialAnswer) referenceParts.push(`参考答案：\n${bookmark.answer.officialAnswer}`);
      if (bookmark.answer && bookmark.answer.explanation) referenceParts.push(`答案解析：\n${bookmark.answer.explanation}`);
      const referenceText = referenceParts.join('\n\n');
      body.innerHTML = `
        <div class="ptaf-field">
          <label for="ptafEditTitle">标题</label>
          <input class="ptaf-input" id="ptafEditTitle" value="${escapeHtml(bookmark.title)}">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="ptaf-field"><label for="ptafEditLabel">题号</label><input class="ptaf-input" id="ptafEditLabel" value="${escapeHtml(bookmark.label)}"></div>
          <div class="ptaf-field"><label for="ptafEditType">题型</label><select class="ptaf-select" id="ptafEditType">${Object.entries(Core.TYPE_LABELS).map(([value, label]) => `<option value="${value}" ${bookmark.type === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></div>
        </div>
        <div class="ptaf-field"><label for="ptafEditSetName">题目集</label><input class="ptaf-input" id="ptafEditSetName" value="${escapeHtml(bookmark.problemSetName || '')}"></div>
        <div class="ptaf-field"><label for="ptafEditStatus">学习状态</label><select class="ptaf-select" id="ptafEditStatus">${Object.entries(Core.STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${bookmark.status === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></div>
        <div class="ptaf-field"><label for="ptafEditTags">标签</label><input class="ptaf-input" id="ptafEditTags" value="${escapeHtml((bookmark.tags || []).join(', '))}" placeholder="用逗号分隔"></div>
        <div class="ptaf-field"><label for="ptafEditNote">备注</label><textarea class="ptaf-textarea" id="ptafEditNote">${escapeHtml(bookmark.note || '')}</textarea></div>
        <div class="ptaf-field"><label>收藏夹</label><div class="ptaf-check-list">${folderChecks}<button class="ptaf-btn small" id="ptafAddFolderInline" type="button">+ 新建收藏夹</button></div></div>
        <div class="ptaf-field"><label for="ptafEditReference">可改成参考答案与解析</label><textarea class="ptaf-textarea" id="ptafEditReference" placeholder="可填写参考答案、解析或两者">${escapeHtml(referenceText)}</textarea></div>
        ${aiReferenceHtml(bookmark.answer && bookmark.answer.ai)}
        <div class="ptaf-field"><label for="ptafEditAnswerVisibility">答案状态</label><select class="ptaf-select" id="ptafEditAnswerVisibility">${Object.entries(Core.ANSWER_VISIBILITY_LABELS).map(([value, label]) => `<option value="${value}" ${(bookmark.answer && bookmark.answer.visibility || 'unknown') === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></div>
      `;
    }

    saveEditor() {
      const bookmarkId = this.currentEditId;
      const bookmark = this.store.state.bookmarks[bookmarkId];
      if (!bookmark) return;
      const folderIds = Array.from(this.shadow.querySelectorAll('[data-ptaf-folder]:checked')).map((input) => input.value);
      const tags = this.shadow.getElementById('ptafEditTags').value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
      if (!folderIds.length) {
        this.store.remove(bookmarkId);
        this.snapshotStore.remove(bookmarkId).catch((error) => warn('删除快照失败', error));
        this.closeModal('editor');
        this.toast('已取消收藏并删除本地快照');
        return;
      }
      this.store.updateBookmark(bookmarkId, {
        title: Core.cleanProblemTitle(this.shadow.getElementById('ptafEditTitle').value) || bookmark.title,
        label: this.shadow.getElementById('ptafEditLabel').value.trim(),
        type: Core.normalizeProblemType(this.shadow.getElementById('ptafEditType').value),
        problemSetName: this.shadow.getElementById('ptafEditSetName').value.trim() || bookmark.problemSetName,
        status: this.shadow.getElementById('ptafEditStatus').value,
        tags,
        note: this.shadow.getElementById('ptafEditNote').value.trim(),
        folderIds,
        answer: {
          ...bookmark.answer,
          officialAnswer: this.shadow.getElementById('ptafEditReference').value.trim(),
          explanation: '',
          visibility: this.shadow.getElementById('ptafEditAnswerVisibility').value,
          source: this.shadow.getElementById('ptafEditReference').value.trim() ? 'user' : bookmark.answer.source,
        },
      });
      this.editorForcedFolderId = '';
      this.toast('收藏已保存');
      this.closeModal('editor');
    }

    async captureCurrentBookmark() {
      const bookmark = this.store.state.bookmarks[this.currentEditId];
      if (!bookmark) return;
      await this.captureBookmark(bookmark.id);
      const updated = this.store.state.bookmarks[bookmark.id];
      if (updated) this.renderEditor(updated);
    }

    async captureBookmark(bookmarkId) {
      const bookmark = this.store.state.bookmarks[bookmarkId];
      if (!bookmark) return;
      const exactCard = bookmark.problemId ? document.getElementById(bookmark.problemId) : null;
      const currentProblem = extractCurrentProblem();
      const isCurrentProblem = currentProblem && Core.makeBookmarkKey(currentProblem) === bookmark.id;
      if (!exactCard && !isCurrentProblem) {
        this.toast('当前页面不是这道题，请先打开对应题目再更新快照', 'error');
        return;
      }
      let openedSubmissionModal = false;
      try {
        this.toast('正在保存当前页面快照...');
        openedSubmissionModal = await openLastSubmissionForCapture(bookmark);
        if (openedSubmissionModal) await new Promise((resolve) => setTimeout(resolve, 500));
        const result = await captureSnapshot(bookmark);
        this.toast(`已保存：${result.snapshot.markdown.length ? '题目内容' : '页面'}${result.bookmark.submissions.length ? '与提交记录' : ''}`);
        this.render();
      } catch (error) {
        warn('保存快照失败', error);
        this.toast(`保存快照失败：${error.message || error}`, 'error');
      } finally {
        if (openedSubmissionModal) closeSubmissionModal();
      }
    }

    deleteCurrentBookmark() {
      const bookmarkId = this.currentEditId;
      const bookmark = this.store.state.bookmarks[bookmarkId];
      if (!bookmark) return;
      if (!confirm(`确定删除「${bookmark.title}」及其本地快照吗？`)) return;
      this.store.remove(bookmarkId);
      this.snapshotStore.remove(bookmarkId).catch((error) => warn('删除快照失败', error));
      this.closeModal('editor');
      this.toast('收藏和本地快照已删除');
    }

    async openSnapshot(bookmarkId) {
      const bookmark = this.store.state.bookmarks[bookmarkId];
      if (!bookmark) return;
      this.currentSnapshotId = bookmarkId;
      const snapshot = await this.snapshotStore.get(bookmarkId);
      const body = this.shadow.getElementById('ptafSnapshotBody');
      this.shadow.getElementById('ptafSnapshotTitle').textContent = `${bookmark.label ? `${bookmark.label} ` : ''}${bookmark.title}`;
      if (!snapshot) {
        body.innerHTML = '<div class="ptaf-empty">还没有本地快照。<br>请在原题页面点击“刷新快照”。</div>';
        this.openModal('snapshot');
        return;
      }

      const snapshotLabels = String(`${snapshot.text || ''}\n${snapshot.markdown || ''}`.slice(0, 5000)).match(/\b\d{1,4}[-–—]\d{1,4}\b/g) || [];
      const urlMismatch = snapshot.capturedFromProblemId && bookmark.problemId && snapshot.capturedFromProblemId !== bookmark.problemId;
      const labelMismatch = !snapshot.capturedFromProblemId && bookmark.label && snapshotLabels.length && !snapshotLabels.includes(bookmark.label);
      if (urlMismatch || labelMismatch) {
        body.innerHTML = `<div class="ptaf-empty">检测到这份旧快照保存的是另一道题，已阻止错误展示。<br>请打开当前题目后重新点击“刷新快照”。</div>`;
        this.openModal('snapshot');
        return;
      }

      const isCodeProblem = ['function', 'programming'].includes(Core.normalizeProblemType(bookmark.type));
      const latestSubmission = (bookmark.submissions || [])[0];
      const judgeConstraints = snapshot.judgeConstraints || {};
      const judgeCriteria = [
        latestSubmission && latestSubmission.compiler ? `编译器：${latestSubmission.compiler}` : '',
        judgeConstraints.timeLimit ? `时间限制：${judgeConstraints.timeLimit}` : '',
        judgeConstraints.memoryLimit ? `内存限制：${judgeConstraints.memoryLimit}` : '',
        judgeConstraints.codeLengthLimit ? `代码长度限制：${judgeConstraints.codeLengthLimit}` : '',
        judgeConstraints.stackLimit ? `栈限制：${judgeConstraints.stackLimit}` : '',
      ].filter(Boolean).join(' · ');
      const originalCode = latestSubmission && latestSubmission.code
        ? latestSubmission.code
        : snapshot.codeDraft || snapshot.submissionDraft && snapshot.submissionDraft.code || '';
      const hasLocalCode = typeof snapshot.localCode === 'string';
      const code = hasLocalCode ? snapshot.localCode : originalCode;
      const sourceAnswers = Array.isArray(snapshot.localAnswers) ? snapshot.localAnswers : (snapshot.answers || []);
      const hasLocalAnswers = Array.isArray(snapshot.localAnswers);
      const answerValues = sourceAnswers
        .map((answer) => String(answer.answer || '').replace(/\s+/g, ''))
        .filter(Boolean);
      const fallbackAnswer = String(bookmark.answer && bookmark.answer.userAnswer || '').replace(/\s+/g, '');
      const effectiveAnswerValues = answerValues.length ? answerValues : fallbackAnswer ? [fallbackAnswer] : [];
      const answerChips = effectiveAnswerValues
        .map((answer) => `<span class="ptaf-answer-chip">${escapeHtml(answer)}</span>`)
        .join('');
      const choiceGroups = isCodeProblem
        ? []
        : Array.isArray(snapshot.choiceGroups) && snapshot.choiceGroups.length
          ? snapshot.choiceGroups
          : extractChoiceGroupsFromHtml(snapshot.html);
      this.currentSnapshotChoiceGroups = choiceGroups;
      this.currentSnapshotRecord = snapshot;
      this.currentSnapshotIsCodeProblem = isCodeProblem;
      const myAnswer = isCodeProblem
        ? `<div class="ptaf-field">
            <div class="ptaf-answer-header"><label>我的作答</label><div class="ptaf-card-actions" style="margin:0"><span class="ptaf-edit-actions">${hasLocalCode ? '<span class="ptaf-badge warning">本地修改</span>' : ''}<button class="ptaf-btn small" type="button" data-ptaf-snapshot-edit-answer>编辑代码</button>${hasLocalCode ? '<button class="ptaf-btn small" type="button" data-ptaf-snapshot-reset-answer>恢复原始</button>' : ''}</span></div></div>
            <div class="ptaf-card-meta">${latestSubmission ? `${escapeHtml(latestSubmission.language)} · ${escapeHtml(latestSubmission.rawStatus || latestSubmission.status)}${latestSubmission.score != null ? ` · ${latestSubmission.score}${latestSubmission.maxScore != null ? `/${latestSubmission.maxScore}` : ''}` : ''}` : code ? '代码草稿（尚未判定）' : '暂无提交或代码'}</div>
            <div data-ptaf-snapshot-code-viewer>${code ? codeBlockHtml(code, latestSubmission ? latestSubmission.language : '代码') : ''}</div>
            ${latestSubmission ? `<details class="ptaf-details"><summary>PTA 评测详情</summary>${judgeCriteria ? `<div class="ptaf-card-meta">${escapeHtml(judgeCriteria)}</div>` : ''}${latestSubmission.testPoints && latestSubmission.testPoints.length ? `<ul>${latestSubmission.testPoints.map((point) => `<li>${escapeHtml(point.label || point.id)}：${escapeHtml(point.result)}${point.score != null ? ` (${point.score}${point.maxScore != null ? `/${point.maxScore}` : ''})` : ''}</li>`).join('')}</ul>` : ''}${latestSubmission.compileOutput ? `<pre class="ptaf-console">${escapeHtml(latestSubmission.compileOutput)}</pre>` : ''}</details>` : ''}
          </div>`
        : `<div class="ptaf-field">
            <div class="ptaf-answer-header"><label>我的作答</label><div class="ptaf-card-actions" style="margin:0"><span class="ptaf-edit-actions">${hasLocalAnswers ? '<span class="ptaf-badge warning">本地修改</span>' : ''}<button class="ptaf-btn small" type="button" data-ptaf-snapshot-edit-answer>编辑答案</button>${hasLocalAnswers ? '<button class="ptaf-btn small" type="button" data-ptaf-snapshot-reset-answer>恢复原始</button>' : ''}</span></div></div>
            <div class="ptaf-answer-summary" data-ptaf-answer-values="${escapeHtml(JSON.stringify(effectiveAnswerValues))}">${answerChips || '<span class="ptaf-answer-chip muted">未检测到已选择答案</span>'}</div>
          </div>`;
      const officialAnswer = bookmark.answer && (bookmark.answer.officialAnswer || bookmark.answer.explanation)
        ? `<div class="ptaf-field"><label>答案与解析</label>${bookmark.answer.officialAnswer ? `<div>${escapeHtml(bookmark.answer.officialAnswer)}</div>` : ''}${bookmark.answer.explanation ? `<div>${escapeHtml(bookmark.answer.explanation)}</div>` : ''}${aiReferenceHtml(bookmark.answer.ai)}</div>`
        : aiReferenceHtml(bookmark.answer && bookmark.answer.ai);

      const pageStyles = snapshot.pageStyles || {};
      const baseUrl = pageStyles.baseUrl || snapshot.url || location.href;
      const linkedStyles = (pageStyles.hrefs || []).map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join('');
      const inlineStyles = (pageStyles.inline || []).map((css) => `<style>${String(css).replace(/<\/style/gi, '<\\/style')}</style>`).join('');
      const snapshotNightStyle = this.store.state.settings.nightMode ? `<style>
        html,body{background:#0f172a!important;color:#dbe7f5!important;color-scheme:dark}
        body{padding:18px}
        a{color:#8bc4ff!important}
        pre,code{background:#17243a!important;color:#dbe9ff!important}
        table,td,th{border-color:#2a3c57!important}
        th,td{background:#111c31!important;color:#dbe7f5!important}
        blockquote{background:#17243a!important;color:#b8cbe0!important;border-left-color:#4b6b92!important}
        .ptaf-snapshot-code{background:#0f172a!important;border-color:#2a3c57!important}
        .ptaf-snapshot-code-head{background:#17243a!important;color:#c9d7ea!important;border-color:#2a3c57!important}
        .ptaf-snapshot-line-numbers{background:#111c31!important;color:#8ea4be!important;border-color:#2a3c57!important}
        .ptaf-snapshot-code-content{color:#e5edf7!important}
        .ptaf-snapshot-root input[type="radio"],.ptaf-snapshot-root input[type="checkbox"]{accent-color:#5aa2f3}
      </style>` : '';
      const snapshotFallbackStyle = `<style>
        html,body{margin:0!important;background:#fff!important}
        body{padding:18px}
        img{max-width:100%;height:auto}
        pre{overflow:auto;padding:12px;background:#f3f6fa;border-radius:8px}
        table{border-collapse:collapse;max-width:100%;overflow:auto}
        td,th{border:1px solid #dbe4ef;padding:6px 9px}
        .ptaf-snapshot-code{border:1px solid #dbe4ef;border-radius:8px;overflow:hidden;background:#fff;margin:10px 0}
        .ptaf-snapshot-code-head{padding:7px 10px;background:#eef3f8;border-bottom:1px solid #dbe4ef;color:#53657a;font:12px/1.4 Consolas,Monaco,monospace}
        .ptaf-snapshot-code-body{display:grid;grid-template-columns:auto minmax(0,1fr);max-height:430px;overflow:auto}
        .ptaf-snapshot-line-numbers,.ptaf-snapshot-code-content{margin:0;padding:11px 0;border-radius:0;background:transparent;font:17px/1.75 Consolas,Monaco,"Courier New",monospace;tab-size:4}
        .ptaf-snapshot-line-numbers{min-width:42px;padding-right:9px;color:#94a3b8;background:#f8fafc;border-right:1px solid #e2e8f0;text-align:right;user-select:none;white-space:pre}
        .ptaf-snapshot-code-content{color:#1f2937;white-space:pre}
        .ptaf-snapshot-code-content code{font:inherit}
        .token-keyword{color:#7c3aed;font-weight:600}.token-string{color:#b45309}.token-number{color:#0f766e}.token-comment{color:#64748b;font-style:italic}.token-preprocessor{color:#0b6bcb;font-weight:600}.token-function{color:#1d4ed8}.token-identifier{color:#1f2937}
        .cm-gutters{padding-top:8px!important}
        .ptaf-snapshot-root input[type="radio"],.ptaf-snapshot-root input[type="checkbox"]{pointer-events:auto!important;cursor:pointer}.ptaf-snapshot-root select,.ptaf-snapshot-root button{pointer-events:none!important}
      </style>`;
      const safeSnapshotHtml = prepareSnapshotHtml(snapshot.html || `<pre>${escapeHtml(snapshot.markdown || snapshot.text || '')}</pre>`);
      const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base href="${escapeHtml(baseUrl)}" target="_blank">${linkedStyles}${inlineStyles}${snapshotFallbackStyle}${snapshotNightStyle}</head><body><div class="ptaf-snapshot-root">${safeSnapshotHtml}</div></body></html>`;

      const layoutClass = this.snapshotLayout === 'split' ? 'is-split' : '';
      const splitRatio = Number(this.store.state.settings.snapshotSplitRatio) || 0.6;
      body.innerHTML = `
        <div class="ptaf-snapshot-layout ${layoutClass}" style="--ptaf-split-left: ${Math.round(splitRatio * 100)}%">
          <section class="ptaf-snapshot-pane ptaf-snapshot-original-pane">
            <div class="ptaf-card-meta">保存时间：${escapeHtml(Core.formatDate(snapshot.capturedAt))} · ${escapeHtml(snapshot.contentHash || '')}</div>
            <div class="ptaf-field"><label>原页面快照</label><iframe class="ptaf-snapshot-frame" sandbox="allow-same-origin" srcdoc="${escapeHtml(srcdoc)}"></iframe></div>
          </section>
          <div class="ptaf-split-resizer" data-ptaf-split-resizer title="拖动调整左右宽度"></div>
          <section class="ptaf-snapshot-pane ptaf-snapshot-answer-pane">
            ${myAnswer}
            ${officialAnswer}
          </section>
        </div>
      `;
      this.openModal('snapshot');
      const snapshotFrame = body.querySelector('.ptaf-snapshot-frame');
      if (snapshotFrame && !isCodeProblem) this.bindSnapshotIframeInteractions(snapshotFrame);
      const layoutButton = this.shadow.getElementById('ptafToggleSnapshotLayout');
      if (layoutButton) layoutButton.textContent = this.snapshotLayout === 'split' ? '单栏查看' : '并排查看';
      this.updateSnapshotNavButtons();
    }
    beginSnapshotAnswerEdit() {
      const body = this.shadow.getElementById('ptafSnapshotBody');
      const actions = body.querySelector('.ptaf-edit-actions');
      if (!actions) return;
      if (this.currentSnapshotIsCodeProblem) {
        const viewer = body.querySelector('[data-ptaf-snapshot-code-viewer]');
        const code = viewer?.querySelector('code')?.textContent || '';
        const textarea = document.createElement('textarea');
        textarea.className = 'ptaf-textarea ptaf-snapshot-code-editor';
        textarea.id = 'ptafSnapshotCodeEditor';
        textarea.value = code;
        if (viewer) viewer.replaceWith(textarea);
      } else {
        const summary = body.querySelector('.ptaf-answer-summary');
        const values = Core.safeJsonParse(summary?.getAttribute('data-ptaf-answer-values') || '', []);
        const groups = this.currentSnapshotChoiceGroups || [];
        if (summary && groups.length) {
          summary.innerHTML = groups.map((group, groupIndex) => `<div class="ptaf-choice-edit-group">
            ${groups.length > 1 ? `<div class="ptaf-card-meta">第 ${groupIndex + 1} 题</div>` : ''}
            ${group.options.map((option) => `<label class="ptaf-choice-edit-option"><input type="${group.kind}" name="ptaf-choice-${groupIndex}" data-ptaf-choice-option data-ptaf-choice-group="${groupIndex}" data-option-answer="${escapeHtml(option.answer)}" ${values.includes(option.answer) ? 'checked' : ''}> <span>${escapeHtml(option.label)}</span></label>`).join('')}
          </div>`).join('');
        } else if (summary) {
          const list = values.length ? values : [''];
          summary.innerHTML = `<div class="ptaf-snapshot-answer-inputs">${list.map((value, index) => `<input class="ptaf-input" data-ptaf-snapshot-answer-input data-index="${index}" value="${escapeHtml(value)}">`).join('')}</div>`;
        }
      }
      actions.innerHTML = '<button class="ptaf-btn small" type="button" data-ptaf-snapshot-cancel-answer>取消</button><button class="ptaf-btn small primary" type="button" data-ptaf-snapshot-save-answer>保存到本地快照</button>';
      this.toast('编辑只影响本地快照，不会修改 PTA 原题');
    }

    applyLocalAnswersToSnapshotHtml(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.localAnswers)) return;
      const groups = Array.isArray(snapshot.choiceGroups) && snapshot.choiceGroups.length
        ? snapshot.choiceGroups
        : extractChoiceGroupsFromHtml(snapshot.html);
      if (!groups.length) return;
      if (!snapshot.originalHtml) snapshot.originalHtml = snapshot.html;
      const template = document.createElement('template');
      template.innerHTML = snapshot.html || '';
      const inputs = Array.from(template.content.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
      groups.forEach((group, groupIndex) => {
        const selectedAnswer = String(snapshot.localAnswers[groupIndex] && snapshot.localAnswers[groupIndex].answer || '');
        const selectedParts = selectedAnswer.split(/[；;]/).filter(Boolean);
        const groupInputs = inputs.filter((input) => input.name === group.name);
        groupInputs.forEach((input, optionIndex) => {
          const option = group.options[optionIndex];
          const checked = option && selectedParts.includes(option.answer);
          if (checked) input.setAttribute('checked', '');
          else input.removeAttribute('checked');
        });
      });
      snapshot.html = template.innerHTML;
      snapshot.choiceGroups = groups;
    }

    async handleIframeChoiceChange(input) {
      const snapshot = this.currentSnapshotRecord;
      if (!snapshot || !input) return;
      const groups = this.currentSnapshotChoiceGroups || [];
      const groupIndex = groups.findIndex((group) => group.name === input.name);
      if (groupIndex < 0) return;
      const group = groups[groupIndex];
      const doc = input.ownerDocument;
      const groupInputs = Array.from(doc.querySelectorAll(`input[name="${CSS.escape(input.name)}"]`));
      const answers = groupInputs
        .map((element, optionIndex) => element.checked && group.options[optionIndex] ? group.options[optionIndex].answer : '')
        .filter(Boolean);
      if (!Array.isArray(snapshot.localAnswers)) {
        snapshot.localAnswers = (snapshot.answers || []).map((answer) => ({ ...answer }));
      }
      snapshot.localAnswers[groupIndex] = {
        kind: group.kind,
        prompt: group.prompt || '',
        answer: answers.join('；'),
      };
      snapshot.editedAt = Date.now();
      this.applyLocalAnswersToSnapshotHtml(snapshot);
      await this.snapshotStore.put(snapshot);
      this.updateExternalSnapshotAnswerDisplay(snapshot);
      this.toast('本地快照答案已更新');
    }

    updateExternalSnapshotAnswerDisplay(snapshot) {
      const body = this.shadow.getElementById('ptafSnapshotBody');
      const summary = body.querySelector('.ptaf-answer-summary');
      if (!summary) return;
      const values = (snapshot.localAnswers || snapshot.answers || [])
        .map((answer) => String(answer.answer || '').replace(/\s+/g, ''))
        .filter(Boolean);
      summary.setAttribute('data-ptaf-answer-values', JSON.stringify(values));
      summary.innerHTML = values.length
        ? values.map((answer) => `<span class="ptaf-answer-chip">${escapeHtml(answer)}</span>`).join('')
        : '<span class="ptaf-answer-chip muted">未检测到已选择答案</span>';
      const actions = body.querySelector('.ptaf-edit-actions');
      if (actions) {
        if (!actions.querySelector('.ptaf-badge.warning')) {
          actions.insertAdjacentHTML('afterbegin', '<span class="ptaf-badge warning">本地修改</span>');
        }
        if (!actions.querySelector('[data-ptaf-snapshot-reset-answer]')) {
          actions.insertAdjacentHTML('beforeend', '<button class="ptaf-btn small" type="button" data-ptaf-snapshot-reset-answer>恢复原始</button>');
        }
      }
    }

    bindSnapshotIframeInteractions(iframe) {
      if (!iframe) return;
      const bind = () => {
        const doc = iframe.contentDocument;
        if (!doc) return;
        doc.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((input) => {
          input.addEventListener('change', () => this.handleIframeChoiceChange(input));
        });
        doc.addEventListener('keydown', (event) => this.handleGlobalKeydown(event), true);
      };
      iframe.addEventListener('load', bind, { once: true });
      setTimeout(bind, 0);
    }

    async saveSnapshotAnswerEdit() {
      const snapshot = this.currentSnapshotRecord;
      if (!snapshot) return;
      const body = this.shadow.getElementById('ptafSnapshotBody');
      if (this.currentSnapshotIsCodeProblem) {
        const editor = body.querySelector('#ptafSnapshotCodeEditor');
        snapshot.localCode = editor ? editor.value : snapshot.localCode || '';
      } else {
        const choiceInputs = Array.from(body.querySelectorAll('[data-ptaf-choice-option]'));
        if (choiceInputs.length && (this.currentSnapshotChoiceGroups || []).length) {
          snapshot.localAnswers = this.currentSnapshotChoiceGroups.map((group, groupIndex) => {
            const selected = choiceInputs
              .filter((input) => Number(input.getAttribute('data-ptaf-choice-group')) === groupIndex && input.checked)
              .map((input) => input.getAttribute('data-option-answer'));
            return { kind: group.kind, prompt: group.prompt || '', answer: selected.join('；') };
          });
          this.applyLocalAnswersToSnapshotHtml(snapshot);
        } else {
          const values = Array.from(body.querySelectorAll('[data-ptaf-snapshot-answer-input]')).map((input) => input.value.trim());
          snapshot.localAnswers = values.map((value, index) => ({
            kind: 'local',
            prompt: snapshot.answers && snapshot.answers[index] ? snapshot.answers[index].prompt || '' : '',
            answer: value,
          }));
        }
      }
      snapshot.editedAt = Date.now();
      await this.snapshotStore.put(snapshot);
      this.toast('本地快照已修改，PTA 原题未改变');
      await this.openSnapshot(this.currentSnapshotId);
    }

    async resetSnapshotAnswerEdit() {
      const snapshot = this.currentSnapshotRecord;
      if (!snapshot) return;
      if (snapshot.originalHtml) {
        snapshot.html = snapshot.originalHtml;
        delete snapshot.originalHtml;
      }
      delete snapshot.localCode;
      delete snapshot.localAnswers;
      delete snapshot.editedAt;
      await this.snapshotStore.put(snapshot);
      this.toast('已恢复原始快照内容');
      await this.openSnapshot(this.currentSnapshotId);
    }

    updateSnapshotNavButtons() {
      const ids = (this.currentListBookmarkIds || []).filter((id) => this.store.state.bookmarks[id]);
      const index = ids.indexOf(this.currentSnapshotId);
      const prev = this.shadow.getElementById('ptafSnapshotPrev');
      const next = this.shadow.getElementById('ptafSnapshotNext');
      if (prev) prev.disabled = !ids.length || index <= 0;
      if (next) next.disabled = !ids.length || index < 0 || index >= ids.length - 1;
    }

    navigateSnapshot(offset) {
      const ids = (this.currentListBookmarkIds || []).filter((id) => this.store.state.bookmarks[id]);
      const list = ids.length ? ids : Core.filterBookmarks(this.store.state, { kind: 'all' }, '').map((bookmark) => bookmark.id);
      const index = list.indexOf(this.currentSnapshotId);
      const targetIndex = index < 0 ? 0 : index + offset;
      const targetId = list[targetIndex];
      if (targetId) this.openSnapshot(targetId);
    }

    startSnapshotResize(event) {
      const layout = this.shadow.getElementById('ptafSnapshotBody')?.querySelector('.ptaf-snapshot-layout.is-split');
      const resizer = event.target.closest('[data-ptaf-split-resizer]');
      if (!layout || !resizer) return;
      event.preventDefault();
      const rect = layout.getBoundingClientRect();
      const dividerWidth = 14;
      const total = Math.max(1, rect.width - dividerWidth);
      const minLeft = 320;
      const minRight = 380;
      let ratio = Number(this.store.state.settings.snapshotSplitRatio) || 0.6;
      try { resizer.setPointerCapture(event.pointerId); } catch (error) {}
      const onMove = (moveEvent) => {
        const left = Math.min(Math.max(moveEvent.clientX - rect.left, minLeft), total - minRight);
        ratio = left / total;
        layout.style.setProperty('--ptaf-split-left', `${ratio * 100}%`);
        document.documentElement.style.userSelect = 'none';
      };
      const onUp = () => {
        this.store.state.settings.snapshotSplitRatio = ratio;
        this.store.save(true);
        document.documentElement.style.userSelect = '';
        resizer.removeEventListener('pointermove', onMove);
        resizer.removeEventListener('pointerup', onUp);
        resizer.removeEventListener('pointercancel', onUp);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      resizer.addEventListener('pointermove', onMove);
      resizer.addEventListener('pointerup', onUp);
      resizer.addEventListener('pointercancel', onUp);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }

    toggleSnapshotLayout() {
      this.snapshotLayout = this.snapshotLayout === 'split' ? 'stacked' : 'split';
      if (this.currentSnapshotId) this.openSnapshot(this.currentSnapshotId);
    }

    async refreshCurrentSnapshot() {
      const bookmarkId = this.currentSnapshotId;
      if (bookmarkId) await this.captureBookmark(bookmarkId);
    }

    openCurrentOriginal() {
      const bookmark = this.store.state.bookmarks[this.currentSnapshotId];
      if (!bookmark) return;
      window.open(bookmark.url, '_blank', 'noopener,noreferrer');
    }

    handleFolderAction(action) {
      if (action === 'delete-smart') {
        const bookmarkIds = Core.filterBookmarks(this.store.state, this.selection, '').map((bookmark) => bookmark.id);
        const label = selectionLabel(this.selection, this.store.state);
        if (!bookmarkIds.length) {
          this.toast('该分组中没有可删除的收藏', 'error');
          return;
        }
        if (!confirm(`确定删除“${label}”中的 ${bookmarkIds.length} 道题及其本地快照吗？PTA 原题不会改变。`)) return;
        bookmarkIds.forEach((bookmarkId) => {
          this.store.remove(bookmarkId);
          this.snapshotStore.remove(bookmarkId).catch((error) => warn('删除快照失败', error));
        });
        this.selection = { kind: 'all' };
        this.currentPage = 1;
        this.batchMode = false;
        this.selectedBookmarkIds.clear();
        this.render();
        this.toast(`已删除 ${bookmarkIds.length} 道收藏`);
        return;
      }
      if (this.selection.kind !== 'user' || this.selection.folderId === Core.DEFAULT_FOLDER_ID) return;
      const folder = this.store.state.folders[this.selection.folderId];
      if (!folder) return;
      if (action === 'rename') {
        const name = prompt('重命名收藏夹', folder.name);
        if (!name || !name.trim()) return;
        if (this.store.renameFolder(folder.id, name.trim())) this.toast('收藏夹已重命名');
        return;
      }
      if (action === 'delete') {
        if (!confirm(`删除收藏夹「${folder.name}」？仅属于该收藏夹的题目及其快照也会被删除。`)) return;
        const orphanedIds = Object.values(this.store.state.bookmarks)
          .filter((bookmark) => (bookmark.folderIds || []).includes(folder.id))
          .filter((bookmark) => (bookmark.folderIds || []).filter((id) => id !== folder.id).length === 0)
          .map((bookmark) => bookmark.id);
        if (this.store.deleteFolder(folder.id)) {
          orphanedIds.forEach((bookmarkId) => {
            this.store.remove(bookmarkId);
            this.snapshotStore.remove(bookmarkId).catch((error) => warn('删除快照失败', error));
          });
          this.selection = { kind: 'all' };
          this.render();
          this.toast(orphanedIds.length ? '收藏夹及孤立题目快照已删除' : '收藏夹已删除');
        }
      }
    }

    createFolderForEditor() {
      const bookmark = this.store.state.bookmarks[this.currentEditId];
      if (!bookmark) return;
      const name = prompt('新建收藏夹名称');
      if (!name || !name.trim()) return;
      try {
        const folder = this.store.addFolder(name.trim(), null);
        this.editorForcedFolderId = folder.id;
        this.renderEditor(bookmark, folder.id);
        this.toast(`已创建收藏夹：${folder.name}`);
      } catch (error) {
        this.toast(error.message || '创建收藏夹失败', 'error');
      }
    }

    createFolder() {
      const name = prompt('新建收藏夹名称');
      if (!name || !name.trim()) return;
      try {
        const folder = this.store.addFolder(name.trim(), null);
        this.selection = { kind: 'user', folderId: folder.id };
        this.render();
        this.toast(`已创建收藏夹：${folder.name}`);
      } catch (error) {
        this.toast(error.message || '创建收藏夹失败', 'error');
      }
    }

    openExportModal() {
      this.renderExportFolderChooser();
      this.openModal('export');
    }

    renderExportFolderChooser() {
      const body = this.shadow.getElementById('ptafExportFolderBody');
      const folders = Object.values(this.store.state.folders)
        .sort((a, b) => Number(b.system) - Number(a.system) || a.name.localeCompare(b.name, 'zh-CN'));
      body.innerHTML = `      <div class="ptaf-export-folders">
        <label class="ptaf-folder-choice"><input id="ptafExportSelectAll" type="checkbox" checked> <strong>全选</strong></label>
        ${folders.map((folder) => {
          const count = Object.values(this.store.state.bookmarks).filter((bookmark) => Core.isCollected(bookmark) && (bookmark.folderIds || []).includes(folder.id)).length;
          return `<label class="ptaf-folder-choice"><input type="checkbox" data-ptaf-export-folder value="${escapeHtml(folder.id)}"> <span>${escapeHtml(folder.name)}</span><span class="ptaf-tree-count">${count}</span></label>`;
        }).join('')}
      </div>
`;
    }

    buildFolderSubset(folderIds) {
      const selectedIds = new Set(folderIds);
      const folders = {};
      selectedIds.forEach((folderId) => {
        if (this.store.state.folders[folderId]) folders[folderId] = Core.clone(this.store.state.folders[folderId]);
      });
      const bookmarks = {};
      Object.values(this.store.state.bookmarks).filter(Core.isCollected).forEach((bookmark) => {
        const matchedFolderIds = (bookmark.folderIds || []).filter((folderId) => selectedIds.has(folderId));
        if (!matchedFolderIds.length) return;
        bookmarks[bookmark.id] = { ...Core.clone(bookmark), folderIds: matchedFolderIds };
      });
      return {
        ...Core.clone(this.store.state),
        folders,
        bookmarks,
        settings: { ...this.store.state.settings, exportFolderIds: Array.from(selectedIds) },
      };
    }

    async exportSelectedFolders(format) {
      const selectAll = this.shadow.getElementById('ptafExportSelectAll')?.checked;
      const folderIds = selectAll
        ? Object.keys(this.store.state.folders || {})
        : Array.from(this.shadow.querySelectorAll('[data-ptaf-export-folder]:checked')).map((checkbox) => checkbox.value);
      if (!folderIds.length) {
        this.toast('请至少选择一个收藏夹', 'error');
        return;
      }
      try {
        const allSnapshots = await this.snapshotStore.all();
        const subset = this.buildFolderSubset(folderIds);
        const selectedBookmarkIds = new Set(Object.keys(subset.bookmarks));
        const snapshots = {};
        Object.entries(allSnapshots).forEach(([bookmarkId, snapshot]) => {
          if (selectedBookmarkIds.has(bookmarkId)) snapshots[bookmarkId] = snapshot;
        });
        const date = new Date().toISOString().slice(0, 10);
        const folderNames = folderIds.map((folderId) => this.store.state.folders[folderId]?.name).filter(Boolean);
        const allFolderCount = Object.keys(this.store.state.folders || {}).length;
        const scopeName = folderIds.length === allFolderCount
          ? 'favorites'
          : folderNames.length === 1
            ? folderNames[0]
            : `selected-folders-${folderNames.length}`;
        const fileBase = `pta-${safeFileName(scopeName)}-${date}`;
        if (format === 'markdown') {
          const markdown = Core.toMarkdown(subset, snapshots, { includeAnswers: true, includeCode: false });
          downloadText(`${fileBase}.md`, markdown, 'text/markdown;charset=utf-8');
        } else {
          const json = Core.toPortableJson(subset, snapshots);
          downloadText(`${fileBase}.json`, json, 'application/json;charset=utf-8');
        }
        this.closeModal('export');
        this.toast(format === 'markdown' ? '所选收藏夹 Markdown 已导出' : '所选收藏夹 JSON 已导出');
      } catch (error) {
        warn('选择性导出失败', error);
        this.toast(`选择性导出失败：${error.message || error}`, 'error');
      }
    }

    async exportMarkdown() {
      try {
        const snapshots = await this.snapshotStore.all();
        const markdown = Core.toMarkdown(this.store.state, snapshots, { includeAnswers: true, includeCode: false });
        const date = new Date().toISOString().slice(0, 10);
        downloadText(`pta-favorites-${date}.md`, markdown, 'text/markdown;charset=utf-8');
        this.toast('Markdown 已导出');
      } catch (error) {
        this.toast(`导出失败：${error.message || error}`, 'error');
      }
    }

    async exportJson() {
      try {
        const snapshots = await this.snapshotStore.all();
        const json = Core.toPortableJson(this.store.state, snapshots);
        const date = new Date().toISOString().slice(0, 10);
        downloadText(`pta-favorites-${date}.json`, json, 'application/json;charset=utf-8');
        this.toast('JSON 已导出');
      } catch (error) {
        this.toast(`导出失败：${error.message || error}`, 'error');
      }
    }

    async importJson(event) {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        const text = await readFileAsText(file);
        const imported = Core.fromPortableJson(text);
        const bookmarkCount = Object.keys(imported.state.bookmarks).length;
        if (!confirm(`导入 ${bookmarkCount} 条收藏？将合并到当前数据，不会覆盖现有备注。`)) return;
        Object.entries(imported.state.folders || {}).forEach(([folderId, folder]) => {
          if (!this.store.state.folders[folderId]) {
            this.store.state.folders[folderId] = folder;
          }
        });
        Object.values(imported.state.bookmarks).forEach((bookmark) => {
          this.store.upsert(bookmark, { preserveId: true, preserveTimes: true });
        });
        await this.snapshotStore.importMany(imported.snapshots);
        this.store.save(true);
        this.render();
        this.toast(`已导入 ${bookmarkCount} 条收藏`);
      } catch (error) {
        warn('导入失败', error);
        this.toast(`导入失败：${error.message || error}`, 'error');
      }
    }
  }
  const store = new AppStore();
  const snapshotStore = new SnapshotStore();
  const ui = new FavoritesUI(store, snapshotStore);
  let scanTimer = null;
  let lastHref = location.href;
  let initialized = false;
  let submissionCaptureKey = '';
  let submissionCaptureInProgress = false;

  function createStarHost(bookmarkId, active, problemProvider) {
    const host = document.createElement('span');
    host.setAttribute(STAR_ATTR, '1');
    host.setAttribute('data-ptaf-bookmark-id', bookmarkId);
    host.style.display = 'inline-flex';
    host.style.verticalAlign = 'middle';
    host.setAttribute('data-ptaf-night', store.state.settings.nightMode ? '1' : '0');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { display: inline-flex; vertical-align: middle; }
        button {
          display: inline-flex; align-items: center; justify-content: center;
          width: 27px; height: 27px; margin: 0 7px 0 0; padding: 0;
          color: #8a98aa; background: #fff; border: 1px solid #d7e0eb;
          border-radius: 7px; cursor: pointer; font: 17px/1 sans-serif;
          transition: color 120ms ease, background 120ms ease, transform 120ms ease;
        }
        button:hover { color: #e59610; background: #fff9eb; transform: scale(1.05); }
        button.active { color: #fff; background: #f0a11a; border-color: #f0a11a; }
        :host([data-ptaf-night="1"]) button { color: #9fb2c9; background: #17243a; border-color: #314867; }
        :host([data-ptaf-night="1"]) button:hover { color: #f4b23c; background: #26364f; }
        :host([data-ptaf-night="1"]) button.active { color: #fff; background: #d98b18; border-color: #d98b18; }
      </style>
      <button type="button" title="${active ? '已收藏，左键取消，右键管理' : '收藏题目'}">${active ? '★' : '☆'}</button>
    `;
    const button = shadow.querySelector('button');
    button.classList.toggle('active', Boolean(active));
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const bookmarkIdNow = host.getAttribute('data-ptaf-bookmark-id');
      const existing = store.state.bookmarks[bookmarkIdNow];
      if (Core.isCollected(existing)) {
        uncollectProblem(existing);
        return;
      }
      const problem = typeof problemProvider === 'function' ? problemProvider() : extractCurrentProblem();
      if (!problem) {
        ui.toast('无法识别这道题', 'error');
        return;
      }
      await collectProblem(problem, host);
    });
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const problem = typeof problemProvider === 'function' ? problemProvider() : extractCurrentProblem();
      openProblemEditor(problem);
    });
    return host;
  }

  function openProblemEditor(problem) {
    if (!problem) {
      ui.toast('无法识别这道题', 'error');
      return;
    }
    const bookmarkId = Core.makeBookmarkKey(problem);
    if (!store.state.bookmarks[bookmarkId]) {
      const temporary = Core.createBookmark({ ...problem, folderIds: [] });
      store.upsert(temporary, { preserveId: true });
    }
    ui.openEditor(bookmarkId);
  }

  function uncollectProblem(bookmark) {
    if (!bookmark) return;
    store.remove(bookmark.id);
    snapshotStore.remove(bookmark.id).catch((error) => warn('删除快照失败', error));
    ui.toast('已取消收藏并删除本地快照');
    ui.render();
  }

  async function collectProblem(problem, starHost) {
    const bookmark = Core.createBookmark({
      ...problem,
      folderIds: [Core.DEFAULT_FOLDER_ID],
    });
    store.upsert(bookmark);
    if (starHost) {
      starHost.setAttribute('data-ptaf-bookmark-id', bookmark.id);
      const button = starHost.shadowRoot && starHost.shadowRoot.querySelector('button');
      if (button) {
        button.classList.add('active');
        button.textContent = '★';
        button.title = '已收藏，左键取消，右键管理';
      }
    }

    ui.toast('已加入默认收藏夹');
    await nextFrame();

    const current = extractCurrentProblem();
    const hasInlineCard = bookmark.problemId && document.getElementById(bookmark.problemId);
    if (hasInlineCard || (current && Core.makeBookmarkKey(current) === bookmark.id)) {
      try {
        await ui.captureBookmark(bookmark.id);
      } catch (error) {
        warn('自动保存快照失败，可稍后手动更新', error);
      }
    }
    ui.render();
  }

  async function collectFromAnchor(anchor, starHost) {
    const problem = extractProblemFromAnchor(anchor);
    if (!problem) {
      ui.toast('无法识别这道题的链接', 'error');
      return;
    }
    await collectProblem(problem, starHost);
  }

  async function collectCurrentProblem() {
    const problem = extractCurrentProblem();
    if (!problem) {
      ui.toast('当前页面不是可识别的题目页', 'error');
      return;
    }
    const existingId = Core.makeBookmarkKey(problem);
    const existing = store.state.bookmarks[existingId];
    if (Core.isCollected(existing)) {
      uncollectProblem(existing);
      return;
    }
    const bookmark = Core.createBookmark({ ...problem, folderIds: [Core.DEFAULT_FOLDER_ID] });
    store.upsert(bookmark);
    ui.toast('已收藏当前题目');
    await ui.captureBookmark(bookmark.id);
    scanPage();
  }

  function injectStars() {
    if (!document.body) return;
    const anchors = Array.from(document.querySelectorAll('a[href*="/problems/"], a[href*="problemSetProblemId="]'))
      .filter((anchor) => !isOurElement(anchor))
      .filter((anchor) => !anchor.closest('#' + HOST_ID))
      .filter((anchor) => anchor.getAttribute('href') && anchor.getAttribute('href').length < 2000);

    anchors.forEach((anchor) => {
      if (anchor.getAttribute('data-ptaf-star-bound') === '1') return;
      const problem = extractProblemFromAnchor(anchor);
      if (!problem) return;
      const bookmarkId = Core.makeBookmarkKey(problem);
      const active = Core.isCollected(store.state.bookmarks[bookmarkId]);
      const host = createStarHost(bookmarkId, active, () => extractProblemFromAnchor(anchor));
      anchor.setAttribute('data-ptaf-star-bound', '1');

      const card = problem.problemId ? document.getElementById(problem.problemId) : null;
      if (card && document.querySelector(`[data-ptaf-card-star="${CSS.escape(problem.problemId)}"]`)) return;
      if (card) {
        const labelButton = card.querySelector('button');
        const titleLink = card.querySelector('[data-e2e="problem-set-problem-list-link"], a:not([href*="problemSetProblemId"])');
        const insertionTarget = labelButton || titleLink;
        if (insertionTarget) {
          insertionTarget.insertAdjacentElement('beforebegin', host);
          host.setAttribute('data-ptaf-card-star', problem.problemId);
          return;
        }
      }
      if (anchor.closest('[data-sidebar]')) return;
      anchor.insertAdjacentElement('afterend', host);
    });
  }

  function injectSidebarEntry() {
    const path = location.pathname;
    const isExamProblemListPage = /^\/problem-sets\/[^/]+\/exam\/problems(?:\/|$)/.test(path)
      && !new URL(location.href).searchParams.has('problemSetProblemId');
    if (isExamProblemListPage) {
      document.querySelectorAll('[data-ptaf-sidebar-entry]').forEach((host) => host.remove());
      return;
    }
    const sidebar = document.querySelector('[data-sidebar="sidebar"]');
    if (!sidebar) return;
    const labelMode = /\/problem-sets\/(?:active|all|dashboard)/.test(path) || /\/overview$/.test(path);
    let host = sidebar.querySelector('[data-ptaf-sidebar-entry]');
    if (!host) {
      host = document.createElement("div");
      host.setAttribute("data-ptaf-sidebar-entry", "1");
      host.style.display = "block";
      host.style.padding = "6px 8px 0";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `<style>
        button{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:38px;padding:0;color:#f0a11a;background:transparent;border:0;border-radius:8px;cursor:pointer;font:600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;transition:background 120ms ease,transform 120ms ease}
        button:hover{background:rgba(240,161,26,.12)}
        button:active{transform:scale(.98)}
        .icon{font-size:22px;line-height:1}
        .label{display:none;white-space:nowrap}
        :host([data-mode="label"]) button{justify-content:flex-start;padding:0 10px}
        :host([data-mode="label"]) .label{display:inline}
      </style><button type="button"><span class="icon">★</span><span class="label">收藏夹</span></button>`;
      shadow.querySelector("button").addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        ui.openDrawer();
      });
      const header = sidebar.querySelector('[data-sidebar="header"]');
      const parent = header || sidebar;
      parent.insertBefore(host, parent.firstChild);
    }
    host.setAttribute("data-mode", labelMode ? "label" : "icon");
    const button = host.shadowRoot && host.shadowRoot.querySelector("button");
    if (button) button.title = "打开 PTA 收藏夹";
  }
  function injectDetailStar() {
    const problem = extractCurrentProblem();
    if (!problem) return;
    const bookmarkId = Core.makeBookmarkKey(problem);
    document.querySelectorAll('[data-ptaf-detail-star]').forEach((host) => {
      if (host.getAttribute('data-ptaf-detail-star') !== bookmarkId) host.remove();
    });
    if (document.querySelector(`[data-ptaf-detail-star="${CSS.escape(bookmarkId)}"]`)) return;
    const titleText = Core.cleanProblemTitle(problem.title);
    const fullTitle = Core.normalizeWhitespace(`${problem.label || ''} ${titleText}`);
    const candidates = Array.from(document.querySelectorAll('h1, h2, h3, h4, [class*="title"], span, div'))
      .map((element) => ({ element, text: visibleText(element) }))
      .filter((item) => item.text && item.text.length <= 220)
      .filter((item) => {
        const normalized = Core.normalizeWhitespace(item.text);
        return normalized === fullTitle
          || (titleText && normalized.includes(titleText) && (!problem.label || normalized.includes(problem.label)));
      })
      .sort((a, b) => elementDepth(b.element) - elementDepth(a.element) || a.text.length - b.text.length);
    const target = candidates.length ? candidates[0].element : null;
    if (!target) return;
    const active = Core.isCollected(store.state.bookmarks[bookmarkId]);
    const host = createStarHost(bookmarkId, active, () => extractCurrentProblem());
    host.setAttribute('data-ptaf-detail-star', bookmarkId);
    target.insertAdjacentElement('beforebegin', host);
  }

  function refreshStars() {
    document.querySelectorAll(`[${STAR_ATTR}]`).forEach((host) => {
      const bookmarkId = host.getAttribute('data-ptaf-bookmark-id');
      const active = Core.isCollected(bookmarkId && store.state.bookmarks[bookmarkId]);
      const button = host.shadowRoot && host.shadowRoot.querySelector('button');
      if (!button) return;
      button.classList.toggle('active', active);
      button.textContent = active ? '★' : '☆';
      button.title = active ? '已收藏，左键取消，右键管理' : '收藏题目';
    });
  }

  async function captureVisibleSubmissionIfAny() {
    if (submissionCaptureInProgress) return;
    const modal = findSubmissionModal();
    if (!modal) return;
    const problem = extractCurrentProblem();
    if (!problem) return;
    const bookmarkId = Core.makeBookmarkKey(problem);
    const bookmark = store.state.bookmarks[bookmarkId];
    if (!bookmark) return;
    const signature = Core.computeContentHash(bookmarkId + '|' + visibleText(modal).slice(0, 12000));
    if (submissionCaptureKey === signature) return;
    submissionCaptureKey = signature;
    submissionCaptureInProgress = true;
    try {
      await captureSnapshot(bookmark, { keepSubmissionDraft: true, submissionCaptureMode: 'auto' });
      ui.toast('已自动保存本次提交结果');
      ui.render();
    } catch (error) {
      warn('自动保存提交结果失败', error);
    } finally {
      submissionCaptureInProgress = false;
    }
  }

  const scanPage = debounce(() => {
    if (!initialized || !document.body) return;
    injectStars();
    injectDetailStar();
    injectSidebarEntry();
    captureVisibleSubmissionIfAny().catch((error) => warn('检查提交结果失败', error));
  }, 180);

  function initObservers() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const target = mutation.target;
        if (target && target.nodeType === Node.ELEMENT_NODE && target.closest && target.closest(`#${HOST_ID}`)) continue;
        scanPage();
        return;
      }
    });
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
    });

    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        scanPage();
      }
    }, 700);
  }

  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('打开 PTA 收藏夹', () => ui.openDrawer());
    GM_registerMenuCommand('收藏当前题目', () => collectCurrentProblem());
    GM_registerMenuCommand('导出 Markdown', () => ui.exportMarkdown());
    GM_registerMenuCommand('导出 JSON 备份', () => ui.exportJson());
    GM_registerMenuCommand('快捷键说明', () => ui.showShortcutHelp());
  }

  async function cleanupUncollected() {
    const uncollectedIds = Object.values(store.state.bookmarks || {})
      .filter((bookmark) => !Core.isCollected(bookmark))
      .map((bookmark) => bookmark.id);
    if (!uncollectedIds.length) return;
    uncollectedIds.forEach((bookmarkId) => {
      delete store.state.bookmarks[bookmarkId];
      snapshotStore.remove(bookmarkId).catch((error) => warn('清理孤立快照失败', error));
    });
    store.state.updatedAt = Date.now();
    store.save(true);
  }

  async function init() {
    await snapshotStore.open();
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch((error) => warn('请求持久化存储失败', error));
    }
    await cleanupUncollected();
    ui.mount();
    initialized = true;
    registerMenuCommands();
    initObservers();
    scanPage();
    log(`已启动 v${APP_VERSION}`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init().catch((error) => warn('初始化失败', error));
  }
})();
