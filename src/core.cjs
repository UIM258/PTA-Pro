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
        launcherPosition: { right: 22, bottom: 24 },
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

