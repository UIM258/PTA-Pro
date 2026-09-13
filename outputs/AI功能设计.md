# PTA 收藏夹 AI 功能设计

## 1. 目标

为每个收藏题目增加一个 AI 助手，用于：

- 解释题意和关键条件
- 生成题目解析、参考答案和解题思路
- 提炼知识点、复杂度和常见错误
- 检查用户自己写的答案
- 检查函数题、编程题代码
- 解释编译错误和部分测试点失败原因
- 生成边界测试和进一步练习建议

AI 不负责替代 PTA 判题，也不保证代码获得满分。

## 2. 信息分层

### 2.1 持久保存的 AI 内容

以下内容可写入题目的“可改成参考答案与解析”：

- 题意解析
- 解题思路
- 参考答案
- 参考代码
- 时间、空间复杂度
- 关键知识点
- 常见错误和边界情况

保存时必须记录：

- 来源：`AI 生成`
- 模型名称
- Prompt/Skill 版本
- 生成时间
- 基于哪一版题目快照生成
- 是否为用户手动修改后的版本

### 2.2 默认不保存的 AI 内容

以下内容只存在于当前 AI 面板或当前浏览器会话：

- 当前用户答案检查
- 当前用户代码检查
- 编译错误解释
- 调试过程
- 渐进式提示
- 针对当前代码生成的本机测试
- 多轮追问记录

关闭面板、刷新页面或切换题目后可以清除。

用户如果希望保存，可以手动点击：

- 复制结果
- 保存为备注
- 写入“可改成参考答案与解析”

不会自动写入。

## 3. UI 设计

### 3.1 收藏卡片

每张卡片增加：

```text
[管理] [本地快照] [更新快照] [AI]
```

### 3.2 AI 面板

点击 AI 后打开侧边面板或居中弹窗，顶部显示：

```text
题目：7-1 顺序表区间元素删除
模式：仅使用本地题目快照
API：DeepSeek / 自定义模型
```

提供两组操作。

#### 题目资料

- 简要解析
- 生成参考答案
- 提取知识点
- 分析复杂度
- 生成边界情况

这些操作可以保存到题目的 AI 解析区块。

#### 我的内容

- 检查我的答案
- 检查我的代码
- 解释编译错误
- 给出渐进提示
- 优化代码
- 生成测试用例

这些操作默认不保存。

### 3.3 AI 结果展示

持久化结果建议使用固定结构：

```text
[AI 生成]
模型：xxx
生成时间：2026-09-13 18:20

题意解析：
...

解题思路：
...

参考答案：
...

知识点：
- ...
- ...

复杂度：
- 时间：O(n)
- 空间：O(1)
```

临时结果只显示在 AI 面板中，不写入题目档案。

## 4. 数据模型

在题目的 `answer` 中增加：

```ts
answer: {
  userText: string
  officialText: string
  ai: {
    analysis: string
    answer: string
    referenceCode: string
    knowledgePoints: string[]
    complexity: {
      time: string
      space: string
    }
    model: string
    skillId: string
    skillVersion: string
    generatedAt: number
    basedOnSnapshotHash: string
    reviewedByUser: boolean
  }
}
```

要求：

- PTA 官方答案、用户手写内容、AI 内容保持独立来源。
- AI 内容不能自动覆盖用户手写内容。
- 用户可以手动将 AI 内容合并到参考答案。
- 题目快照改变后，旧 AI 解析标记为“基于旧快照”。

## 5. API 设计

第一版支持 OpenAI 兼容接口：

```json
{
  "baseUrl": "https://api.example.com/v1",
  "apiKey": "",
  "model": "deepseek-chat",
  "temperature": 0.2,
  "maxTokens": 2500,
  "timeoutMs": 60000
}
```

请求路径默认：

```text
{baseUrl}/chat/completions
```

支持：

- OpenAI
- DeepSeek
- 阿里云百炼兼容接口
- Ollama / LM Studio
- 其他 OpenAI 兼容服务

### API Key 存储

- 使用单独的 Tampermonkey 存储键保存。
- 不写入收藏 JSON。
- 不写入 Markdown。
- 不写入 AI 结果数据。
- 界面上只显示掩码，例如 `sk-****abcd`。

## 6. Prompt / Skill 设计

### 6.1 持久化 Skill

- `analyze-problem.md`
- `reference-solution.md`
- `knowledge-points.md`

### 6.2 临时 Skill

- `review-my-code.md`
- `hint-progression.md`
- `debug-compile-error.md`
- `generate-edge-cases.md`

每个 Skill 使用类似结构：

```yaml
---
name: review-my-code
persist: false
modes:
  - programming
  - function
output: structured-markdown
---
```

## 7. 上下文构造

发送给模型的内容由“上下文构造器”生成，只包含必要数据：

- 题目集名称
- 题号、标题、题型
- 题目正文 Markdown
- 输入、输出格式
- 输入、输出样例
- 时间和内存限制
- 用户答案或本地编辑后的代码
- PTA 判题状态、分数和可见测试点
- 编译器输出

默认不发送：

- PTA Cookie
- 登录凭证
- 用户真实姓名
- 页面上的无关内容
- 隐藏测试信息，因为脚本无法获得

## 8. 安全与规则

- 默认不在考试进行中启用 AI。
- 不自动提交 AI 生成的代码。
- 请求前可以显示将要发送的内容预览。
- 用户可以关闭代码发送，只发送题目正文。
- 本地模型和远程 API 使用同一套接口。
- AI 结果必须标注模型和生成时间。

## 9. 错误处理

- API Key 无效：提示重新配置。
- 模型不存在：提示检查模型名称。
- 429：提示稍后重试。
- 超时：保留已填写内容，允许重试。
- 返回格式错误：显示原始内容和解析失败提示。
- AI 输出不足或明显跑题：允许用户重新生成。

## 10. MVP 范围

第一阶段只做：

1. AI 按钮
2. API 设置
3. 题目简要解析
4. 生成参考答案
5. 提炼知识点
6. 检查我的答案
7. 检查我的代码
8. 解释编译错误
9. AI 解析写入“可改成参考答案与解析”
10. 临时内容不持久化

暂不做：

- 自动提交代码
- 隐藏测试点推断
- 多模型自动投票
- 云端保存 API Key
- 考试期间自动作答

## 11. AI 入口补充

AI 助手入口包括：

- 收藏卡片中的 `[AI]`
- 本地快照弹窗底部的 `[AI 助手]`
- “管理 -> 可改成参考答案与解析”中的 `[AI 生成解析]`

本地快照页面是主要入口。它优先使用本地编辑后的答案和代码，而不是 PTA 原始提交。

详细交互见：

- `outputs/AI交互设计.md`
- `outputs/ai-prompts/catalog.json`
