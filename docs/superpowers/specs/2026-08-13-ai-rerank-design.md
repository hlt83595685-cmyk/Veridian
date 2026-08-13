# AI 检索重排序(reranking)— 设计文档

> 路线图 #2。日期:2026-08-13。

## 目标

在 `search_library` 把结果交给 agent 之前,用**已配置的聊天模型**对混合检索的候选段落逐条判相关度、重排,再取 top-8,提升检索精确率(业界经验 +10~40%)。

RRF 只按"排名投票"融合两路召回,并不真正读查询与段落判断相关度。重排补上这一步。

## 范围与决策(已拍板)

- **打分器**:复用现有聊天模型(OpenAI 兼容 provider,含 claude-subscription),不引入新服务/新 key。
- **方式**:listwise,单次调用排完全部候选(而非每条一次)。
- **候选数**:融合后取 **top-20** 送重排。
- **开关**:**始终开,不加设置**(YAGNI)。
- **段落截断**:每条候选正文截断 ~500 字控制 token。
- **失败策略**:重排是纯精炼,绝不拖垮检索——任一异常静默回退到现有 RRF top-8。

## 架构

新增 `src/main/knowledge/rerank.ts`,在 `search.ts` 的 `hybridSearch` 内调用。FTS/向量/RRF 逻辑完全不动。

### `hybridSearch` 流程变化

`src/main/knowledge/search.ts`:

| 阶段 | 现在 | 改后 |
|---|---|---|
| 召回 | FTS top-30 + 向量 top-30 | 不变 |
| 融合 | RRF | 不变 |
| 取候选 | 按融合分直接切 top-8 | 按融合分取 **top-20** |
| 取正文 | 只给最终 8 条 | 给这 20 条(喂重排器) |
| 重排 | 无 | `rerankHits(query, candidates)` |
| 返回 | top-8(融合序) | top-8(重排序) |

现有代码在 `slice(0, topK)` 后才 hydrate 正文;改为先 hydrate top-20 的正文(重排需要正文),重排后再 `slice(0, topK)`。`SearchHit` 结构不变。

### `rerank.ts` 接口

```
export async function rerankHits(query: string, hits: SearchHit[], topK: number): Promise<SearchHit[]>
```

- `getChatConfig()` 为 null → 直接返回 `hits.slice(0, topK)`(未配置聊天模型时等同现状)。
- 构造 messages:
  - system:要求"你是检索重排器,只按与查询的相关度排序,只输出 JSON 数组"。
  - user:查询 + 编号候选列表(`[0] <heading> 正文…截断500字`、`[1] …`)。
- `await chatStream(cfg, messages, [], () => {}, signal)`,`tools` 传空、`onDelta` 传 no-op,取 `result.content`。
- 用 `AbortController` + ~15s 超时;超时/失败 → catch → 回退 `hits.slice(0, topK)`。
- 解析 `content` 中的 JSON 数组(形如 `[3,0,7,1,...]`),按顺序映射回 `hits`,去重、补上未被模型提及的候选,取前 `topK`。

### 解析与重排纯函数(可单测,不依赖网络)

```
export function reorderByRanking(order: number[], hits: SearchHit[], topK: number): SearchHit[]
```

- `order`:模型给的下标序列。忽略越界/重复下标。
- 先按 `order` 取,再把 `order` 未覆盖的候选按原融合序补到末尾(保证永远返回 ≤topK 条、且不丢候选)。
- 输入乱序/空 → 退化为 `hits.slice(0, topK)`。

## 健壮性回退清单

以下任一 → 返回现有 RRF top-8,检索行为与现状一致:

1. 未配置聊天模型(`getChatConfig()` 为 null)。
2. 网络失败 / 离线 / 非 2xx。
3. 超时(~15s)。
4. `content` 解析不出合法 JSON 数组。
5. 候选不足(`hits.length <= topK`,无需重排)。

## 测试

Vitest 单测 `reorderByRanking`(纯函数,无网络):

- 正常:`order=[2,0,1]` + 3 候选 → 按该序返回。
- 越界/重复:`order=[5,0,0,1]` → 忽略非法项,结果不重复、不越界。
- 覆盖不全:`order=[1]` + 3 候选、topK=3 → `[1]` 打头,其余按原序补齐。
- 空/乱码:`order=[]` → 等于 `hits.slice(0, topK)`。

`rerankHits` 的网络路径不做单测(依赖 provider);靠回退清单保证安全,手动在 app 内验证一次真实检索。

## 不做(YAGNI)

- 不加设置开关、不加"rerank 模型"独立配置(复用聊天模型)。
- 不接专用 rerank API、不做本地模型。
- 不改 FTS/向量/RRF/chunker/indexer。
