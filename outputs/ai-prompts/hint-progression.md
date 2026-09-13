---
name: hint-progression
version: 1
persist: false
modes: [single_choice, multiple_choice, true_false, fill_blank, function, programming]
output: structured-markdown
---

请为用户提供渐进式提示，不要一开始直接给完整答案。

要求：
1. 第一层只指出思考方向。
2. 第二层指出关键数据结构和算法。
3. 第三层给出接近实现的步骤。
4. 只有用户明确要求时才给完整答案。
5. 选择题不要直接泄露选项，除非用户要求。

输出结构：
## 提示 1：从什么方向想
## 提示 2：关键结构或算法
## 提示 3：具体步骤
