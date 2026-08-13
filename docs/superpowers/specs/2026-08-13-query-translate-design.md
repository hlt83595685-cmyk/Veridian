# 跨语言查询翻译(query translation)— 设计文档

> 路线图 #4(缩窄为"仅跨语言翻译")。日期:2026-08-13。

## 目标

用户的库中英混合(中文提问、英文论文为主)。中文 query 走 FTS/BM25 时与英文正文无词面重叠,这一路召回几乎为零;向量能否跨语言取决于嵌入模型。检索前把**中文 query 翻成英文**,原文+译文两路都检索再融合,恢复 BM25 命中并让向量用英文查得更准。

## 范围与决策(已拍板)

- **只做跨语言翻译**,不做同义改写、不做 HyDE。
- **单向**:只在 query 含中文时翻成英文;纯英文 query 跳过,零额外开销、行为不变。
- **始终开,不加设置**(与重排一致;只对中文 query 触发,成本有界)。
- **打分器/翻译器**:复用已配置的聊天模型(OpenAI 兼容 provider,含 claude-subscription),不引入新服务。
- **失败策略**:翻译失败/离线/超时/返回空 → 只用原 query,退回当前行为。检索绝不因翻译中断。

## 架构

新增 `src/main/knowledge/queryTranslate.ts`;`hybridSearch`(`search.ts`)改造成"多 query 变体 → 收集 rank lists → 融合"。FTS/向量/RRF/重排逻辑不变。

### `queryTranslate.ts`

```
export function hasCJK(s: string): boolean            // 纯函数,可测
export async function translateForSearch(query: string): Promise<string | null>
```

- `hasCJK`:正则 `/[㐀-鿿]/`(CJK 统一表意 + 扩展A),判断是否含中文。
- `translateForSearch`:
  - `!hasCJK(query)` → 返回 `null`(纯英文,不翻)。
  - `getChatConfig()` 为 null → 返回 `null`。
  - 一次 `chatStream` 调用(`tools=[]`、`onDelta` no-op),system 提示"翻成英文,只输出译文";`AbortController` + ~12s 超时。
  - 取 `res.content.trim()`;为空或与原文相同 → 返回 `null`,否则返回译文。
  - 任一异常 → catch → 返回 `null`。

### `hybridSearch` 改造

```
async function runQuery(wsId, query): Promise<number[][]>   // 一个 query 的 [fts, vec] 两条 rank list

export async function hybridSearch(wsId, query, topK = 8) {
    // 原 query 检索与翻译并发,隐藏翻译延迟
    const [origLists, translated] = await Promise.all([
        runQuery(wsId, query),
        translateForSearch(query),
    ])
    const rankLists = translated
        ? [...origLists, ...(await runQuery(wsId, translated))]
        : origLists
    const fused = rrfFuse(rankLists)
    // ...top-20 池 → hydrate → rerankHits(query, ...) 不变...
}
```

- 纯英文 query:`translated` 为 null → `rankLists = origLists = [fts, vec]`,**与现状完全一致**。
- 中文 query:4 条 rank list(原文 fts/vec + 译文 fts/vec)一起 `rrfFuse`。`rrfFuse` 已接受 rank list 数组,无需改。
- 重排仍用**原 query**(用户真实意图)对候选打分。

## 成本(仅中文 query)

1 次翻译 LLM 调用 + 多 1 次向量嵌入(译文)+ 原有重排调用。纯英文 query 完全不受影响。翻译与原文检索并发,净增延迟≈一次翻译调用。

## 健壮性回退清单

以下任一 → 只用原 query 检索,行为与现状一致:

1. query 不含中文(`hasCJK` 为 false)。
2. 未配置聊天模型。
3. 翻译网络失败 / 离线 / 非 2xx。
4. 超时(~12s)。
5. 译文为空或与原文相同。

## 测试

Vitest 单测 `hasCJK`(纯函数):

- `hasCJK('注意力机制')` → true
- `hasCJK('transformer attention')` → false
- `hasCJK('transformer 注意力')` → true(中英混合)
- `hasCJK('')` → false

`translateForSearch` 与 `hybridSearch` 的网络/DB 路径不做单测(依赖 provider);靠回退清单保证安全,手动在 app 内验证一次中文提问。

## 不做(YAGNI)

- 不做同义改写、多查询、HyDE。
- 不加设置开关。
- 不做英→中翻译(库以英文为主)。
- 不改 FTS/向量/RRF/重排/chunker/indexer。
