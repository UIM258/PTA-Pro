const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/core.cjs');

test('parseProblemUrl recognizes problem-set problem URLs', () => {
  const parsed = Core.parseProblemUrl('https://sduwh.pintia.cn/problem-sets/set-123/problems/problem-456?foo=1');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.host, 'sduwh.pintia.cn');
  assert.equal(parsed.problemSetId, 'set-123');
  assert.equal(parsed.problemId, 'problem-456');
});

test('parseProblemUrl recognizes PTA exam problem navigation URLs', () => {
  const parsed = Core.parseProblemUrl('https://sduwh.pintia.cn/problem-sets/set-123/exam/problems/type/2?problemSetProblemId=problem-456');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.problemSetId, 'set-123');
  assert.equal(parsed.problemId, 'problem-456');
});

test('problem type recognition covers common PTA labels', () => {
  assert.equal(Core.inferProblemType('本题是 programming 编程题'), 'programming');
  assert.equal(Core.inferProblemType('函数题：实现一个函数'), 'function');
  assert.equal(Core.inferProblemType('单项选择题'), 'single_choice');
  assert.equal(Core.inferProblemType('判断题'), 'true_false');
});

test('state initializes a default folder', () => {
  const state = Core.createInitialState();
  assert.equal(state.folders[Core.DEFAULT_FOLDER_ID].name, '默认收藏夹');
  assert.equal(state.folders[Core.DEFAULT_FOLDER_ID].system, true);
});

test('night mode setting survives state migration', () => {
  const migrated = Core.migrateState({ settings: { nightMode: true } });
  assert.equal(migrated.settings.nightMode, true);
  assert.equal(Core.createInitialState().settings.nightMode, false);
});

test('bookmark upsert merges folders, tags and submissions', () => {
  const state = Core.createInitialState();
  const folder = Core.createFolder(state, '期末复习', null);
  const base = Core.createBookmark({
    url: 'https://sduwh.pintia.cn/problem-sets/set-1/problems/p-1',
    title: '7-1 测试题',
    problemSetId: 'set-1',
    problemSetName: '数据结构练习',
    type: 'programming',
    tags: ['DP'],
    folderIds: [folder.id],
  });

  Core.upsertBookmarkInState(state, base);
  Core.upsertBookmarkInState(state, {
    ...base,
    tags: ['图论'],
    submissions: [{
      code: 'int main() { return 0; }',
      language: 'C++',
      status: '答案错误',
      score: 40,
      maxScore: 100,
    }],
  });

  const saved = state.bookmarks[base.id];
  assert.equal(saved.folderIds.includes(folder.id), true);
  assert.equal(saved.folderIds.includes(Core.DEFAULT_FOLDER_ID), false);
  assert.equal(Core.isCollected(saved), true);
  assert.deepEqual(saved.tags.sort(), ['DP', '图论'].sort());
  assert.equal(saved.submissions.length, 1);
  assert.equal(saved.submissions[0].status, 'WA');
  assert.equal(saved.submissions[0].score, 40);
});

test('submission status and score parsing are normalized', () => {
  assert.equal(Core.normalizeSubmissionStatus('编译错误'), 'CE');
  assert.equal(Core.normalizeSubmissionStatus('Accepted'), 'AC');
  assert.equal(Core.normalizeSubmissionStatus('部分正确'), 'partial');
  assert.deepEqual(Core.extractScore('本题得分 80/100'), { score: 80, maxScore: 100 });
});

test('score parsing ignores submission dates and prefers labeled score ratios', () => {
  assert.deepEqual(
    Core.extractScore('提交时间 2026/09/13 10:57:20 分数 10 / 10'),
    { score: 10, maxScore: 10 },
  );
});

test('submissions with the same code are merged by code hash', () => {
  const first = {
    code: 'int main() { return 0; }',
    language: 'C++',
    status: 'WA',
    submittedAt: 1,
  };
  const second = {
    code: 'int main() { return 0; }',
    language: 'C++',
    status: 'AC',
    submittedAt: 2,
  };
  const merged = Core.mergeSubmissions([first], [second], 8);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'AC');
});

test('answer visibility distinguishes score-only and hidden answers', () => {
  assert.equal(Core.detectAnswerVisibility('本题答案未公布'), 'hidden');
  assert.equal(Core.detectAnswerVisibility('仅公布成绩，不提供答案'), 'score-only');
  assert.equal(Core.detectAnswerVisibility('正确答案：A\n答案解析：...'), 'revealed');
});

test('filtering supports problem set, type, folder and text query', () => {
  const state = Core.createInitialState();
  const folder = Core.createFolder(state, '易错题', null);
  const bookmark = Core.createBookmark({
    url: 'https://sduwh.pintia.cn/problem-sets/set-2/problems/p-2',
    title: '7-2 括号匹配',
    problemSetId: 'set-2',
    problemSetName: '栈与队列',
    type: 'function',
    note: '留意空串',
    folderIds: [folder.id],
  });
  Core.upsertBookmarkInState(state, bookmark);

  assert.equal(Core.filterBookmarks(state, { kind: 'user', folderId: folder.id }, '').length, 1);
  assert.equal(Core.filterBookmarks(state, { kind: 'smart-type', problemSetId: 'set-2', type: 'function' }, '空串').length, 1);
  assert.equal(Core.filterBookmarks(state, { kind: 'all' }, '不存在').length, 0);
});

test('deleting a user folder leaves the bookmark uncollected without deleting it', () => {
  const state = Core.createInitialState();
  const folder = Core.createFolder(state, '临时收藏', null);
  const bookmark = Core.createBookmark({
    url: 'https://sduwh.pintia.cn/problem-sets/set-3/problems/p-3',
    title: '判断题',
    type: 'true_false',
    folderIds: [folder.id],
  });
  Core.upsertBookmarkInState(state, bookmark);
  assert.equal(Core.deleteFolder(state, folder.id), true);
  assert.equal(state.bookmarks[bookmark.id].folderIds.includes(Core.DEFAULT_FOLDER_ID), false);
  assert.equal(state.bookmarks[bookmark.id].folderIds.includes(folder.id), false);
  assert.equal(Core.isCollected(state.bookmarks[bookmark.id]), false);
  assert.equal(Core.filterBookmarks(state, { kind: 'all' }, '').length, 0);
});

test('folder and bookmark custom order is preserved', () => {
  const state = Core.createInitialState();
  const folderA = Core.createFolder(state, 'A 收藏夹', null);
  const folderB = Core.createFolder(state, 'B 收藏夹', null);
  state.settings.folderOrder = [folderB.id, Core.DEFAULT_FOLDER_ID, folderA.id];
  assert.deepEqual(Core.listOrderedFolders(state).map((folder) => folder.id), [folderB.id, Core.DEFAULT_FOLDER_ID, folderA.id]);

  const first = Core.createBookmark({ url: 'https://sduwh.pintia.cn/problem-sets/s/problems/p-1', title: '第一题', problemSetId: 's', problemId: 'p-1' });
  const second = Core.createBookmark({ url: 'https://sduwh.pintia.cn/problem-sets/s/problems/p-2', title: '第二题', problemSetId: 's', problemId: 'p-2' });
  Core.upsertBookmarkInState(state, first);
  Core.upsertBookmarkInState(state, second);
  state.settings.bookmarkOrder.all = [second.id, first.id];
  assert.deepEqual(Core.filterBookmarks(state, { kind: 'all' }, '').map((bookmark) => bookmark.id), [second.id, first.id]);
});

test('markdown and json exports preserve folder organization', () => {
  const state = Core.createInitialState();
  const folder = Core.createFolder(state, '期末复习', null);
  const bookmark = Core.createBookmark({
    url: 'https://sduwh.pintia.cn/problem-sets/set-5/problems/p-5',
    title: '5-1 栈练习',
    label: '5-1',
    problemSetName: '栈与队列',
    type: 'programming',
    folderIds: [folder.id],
  });
  Core.upsertBookmarkInState(state, bookmark);
  const markdown = Core.toMarkdown(state, {});
  assert.match(markdown, /## 收藏夹组织/);
  assert.match(markdown, /### 期末复习/);
  const json = JSON.parse(Core.toPortableJson(state, {}));
  assert.equal(json.memberships[folder.id].includes(bookmark.id), true);
  assert.equal(json.folders[folder.id].bookmarkIds.includes(bookmark.id), true);
});

test('markdown export groups by problem set and includes answer state', () => {
  const state = Core.createInitialState();
  const bookmark = Core.createBookmark({
    url: 'https://sduwh.pintia.cn/problem-sets/set-4/problems/p-4',
    title: '4-1 最大子列和',
    label: '4-1',
    problemSetId: 'set-4',
    problemSetName: '算法练习',
    type: 'programming',
    tags: ['DP'],
    answer: { visibility: 'hidden' },
  });
  Core.upsertBookmarkInState(state, bookmark);
  const markdown = Core.toMarkdown(state, {}, { includeAnswers: true });
  assert.match(markdown, /## 算法练习/);
  assert.match(markdown, /### 编程题/);
  assert.match(markdown, /答案未公布/);
});


