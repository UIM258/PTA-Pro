---
name: debug-compile-error
version: 1
persist: false
modes: [function, programming]
output: structured-markdown
---

请根据编译器输出和用户代码解释错误。

要求：
1. 先翻译编译器错误。
2. 指出错误出现的代码位置和根本原因。
3. 给出最小修改方案。
4. 解释为什么原代码无法编译。
5. 不假设编译器没有显示的隐藏错误。

输出结构：
## 错误翻译
## 错误原因
## 最小修复
## 检查建议
