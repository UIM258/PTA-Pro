---
name: generate-edge-cases
version: 1
persist: false
modes: [function, programming]
output: structured-markdown
---

请根据题目和用户代码生成边界测试思路。

要求：
1. 测试必须符合题目的输入输出格式。
2. 覆盖空输入、最小规模、最大规模、重复值、边界值和特殊结构。
3. 明确每个测试想验证什么。
4. 给出预期结果或判断依据。
5. 不假设这些测试会出现在 PTA 隐藏测试中。

输出结构：
## 边界测试
## 预期结果
## 对应用户代码风险
