---
name: reference-solution
version: 1
persist: true
modes: [single_choice, multiple_choice, true_false, fill_blank, function, programming]
output: structured-markdown
---

请生成一份适合复习的参考答案，不替代 PTA 官方答案。

要求：
1. 先给出结论或核心思路。
2. 选择题给出正确选项、原因和其他选项错误原因。
3. 填空题给出答案，并说明每个空的关键依据。
4. 函数题给出完整函数实现、接口说明、时间复杂度。
5. 编程题给出完整可编译代码、算法步骤、时间和空间复杂度。
6. 不对隐藏测试点作无依据假设。
7. 代码尽量使用题目已经展示的语言和编译标准。

输出结构：
## 结论
## 解题思路
## 参考实现
## 复杂度
## 边界情况
