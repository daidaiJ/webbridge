# 性能记录

这些数字来自 2026-11-20 的真实 Edge + 本仓库扩展构建，不是模拟。每次调用都经过完整的
MCP → HTTP → WebSocket → CDP 路径。网络和页面加载会显著影响绝对值，重点关注同一页面内的
相对差异。

## 测试方法

- 客户端：MCP stdio，`WEBBRIDGE_TOOLSET=full`，固定 session。
- 浏览器：用户日常 Edge profile，扩展 `extension-slim` 已连接。
- 页面：Bing 搜索结果、DuckDuckGo HTML、GitHub Blog 列表和文章、Wikipedia 文章。
- 每个动作记录服务端耗时和返回字节数；`navigate` 直到页面加载事件返回。
- 输出大小是工具返回给 Agent 的文本或图片字节数，不含 MCP 协议开销。

## 结果

### 基础与搜索页

| 动作 | 延迟 | 输出 |
|---|---:|---:|
| `status` | 25.8 ms | 0.5 KB |
| `session` | 1.4 ms | — |
| `navigate` Bing | 3,983.9 ms | — |
| `snapshot` Bing JSON | 127.6 ms | 31.9 KB |
| `snapshot` Bing ARIA 8k | 49.8 ms | 7.9 KB |
| `extract` Bing 10 条 | 12.9 ms | 5.4 KB |
| `read_page` Bing 20k | 1,340.0 ms | 3.3 KB |
| `screenshot` Bing JPEG | 1,115.0 ms | 69.3 KB |
| `capture_page` Bing | 17.7 ms | — |
| `console` | 8–12 ms | 小 |
| `network` | 7–9 ms | 小 |
| `history` | 9 ms | 小 |

### 慢页面

| 动作 | 延迟 | 输出 |
|---|---:|---:|
| `navigate` DuckDuckGo | 8,696.3 ms | — |
| `snapshot` DDG JSON | 45,015 ms（超时） | — |
| `snapshot` DDG ARIA 8k | 20.1 ms | 1.5 KB |
| `extract` DDG 10 条 | 5.8 ms | — |
| `read_page` DDG 20k | 575.5 ms | — |
| `navigate` GitHub Blog | 5,093.4 ms | — |
| `snapshot` Blog JSON | 214.8 ms | 70.4 KB |
| `read_page` Blog 40k | 3,827.4 ms | 6.5 KB |
| `screenshot` Blog JPEG | 2,284.6 ms | 109.7 KB |
| `navigate` Wikipedia | 7,412.3 ms | — |
| `snapshot` Wikipedia JSON | 326.2 ms | 139.2 KB |
| `snapshot` Wikipedia ARIA 8k | 289.7 ms | 8.8 KB |
| `read_page` Wikipedia 20k | 676.5 ms | 20.1 KB |
| `read_page` Wikipedia 120k | 4,679.6 ms | 20.2 KB |
| `capture_page` Wikipedia | 107.9 ms | — |
| `save_as_pdf` Wikipedia | 9,164 ms | 路径 |

### Reader mode

`read_article` 在页面内完成抽取，不经过网络：

| 页面 | 延迟 | 输出 | 结果 |
|---|---:|---:|---|
| GitHub Blog 列表 | 13 ms | 5,988 字符 | `listing:true` 摘要 |
| GitHub Blog 文章 | 14 ms | 10,416 字符 | 干净正文 |
| Wikipedia | 19 ms | 10,556 字符 | 干净正文 |

同一篇 GitHub Blog 文章，`read_page` 需要 3,827 ms 且混有导航和推荐卡片；`read_article`
14 ms，正文从标题和导语开始。Wikipedia 的 `read_page` 20k 需要 677 ms；`read_article`
19 ms。

### 批处理

| 动作 | 延迟 |
|---|---:|
| `navigate` Bing（批量打开） | 6,678.4 ms |
| `batch` fill → click → wait | 5,020.3 ms |

`batch` 省掉的是 MCP/HTTP 往返，不会让页面动作本身更快。页面加载和等待条件仍是主要成本。

## 发现的性能热点与处理

1. **`snapshot` JSON 输出过大。** Wikipedia 单次 139.2 KB，Bing 31.9 KB，GitHub Blog
   70.4 KB。处理：描述里明确提示大页面用 `format:"aria"` + `max_chars`，或 `snapshot(ref)`
   缩小范围；超时错误里附上具体建议。
2. **加载中的页面让 JSON 快照超时。** DuckDuckGo 导航刚返回时快照 45 秒超时，等待后同一
   快照 55 ms / 15.4 KB。处理：`snapshot` 描述建议先 `wait` 选择器；超时错误提示等待或用
   ARIA。
3. **`read_page` 的上限与扫描成本不匹配。** Wikipedia 从 20k 提到 120k，延迟从 677 ms 涨到
   4,680 ms，输出几乎不变。处理：描述建议把 `max_chars` 设在需要的量级，用 `start` 续读。
4. **普通正文抽取含有导航和推荐卡片。** 新增 `read_article`，在页面内做 reader-mode
   评分、去 boilerplate、列表摘要和 Markdown 输出；比 `read_page` 快约 50–300 倍，正文更干净。
5. **列表页只取到一张卡片。** `read_article` 对多个小 `<article>` 卡片生成 digest；文章页
   有长段落时跳过 digest，避免把作者简介当成正文。
6. **Wikipedia 的信息框和引用列表混进正文。** 增加 negative class/id 规则、容器惩罚和遍历
   跳过；现在从导语开始。
7. **截图和 PDF 是慢路径。** 截图 1.1–2.3 秒，PDF 9.2 秒。工具面把截图设为显式动作，收藏
   默认不截图；PDF 只在需要时调用。
8. **重复导航浪费页面加载。** 默认复用任务标签页；`newTab:true` 才保留旧页面。批量流程优先
   在已打开页面上操作。

## 使用建议

- 读文章：`read_article`。
- 读结构：`snapshot {format:"aria", max_chars:8000}`；需要引用时再用 `snapshot(ref)`。
- 抽取重复项：`extract`。
- 读正文且需要分页：`read_page` 用小 `max_chars` + `start`。
- 慢页面：`wait {selector}` 后再快照；不要导航后立刻 JSON 快照。
- 短链操作：`batch`。
- 视觉检查：截图选元素或 JPEG；PDF 只在交付文件时生成。

## 复测

```bash
npm test
EXPECT_NO_PRODUCT_TRAFFIC=1 npm run test:e2e
```

E2E 会启动独立 Edge profile；运行前退出已经连接 daemon 的浏览器，除非显式允许复用。
