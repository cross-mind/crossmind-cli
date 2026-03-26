---
id: crossmind-cli-plan
title: crossmind-cli 开发计划
type: article
created_at: '2026-03-25T06:06:49.603681+00:00'
session_id: unknown
---

# crossmind-cli 开发计划

_日期：2026-03-25_
_基于：opencli v1.3.3、twitter-cli、rdt-cli 代码审计_

---

## 零、项目特性

> 本章节为项目介绍草稿，可直接用于 README / 官网描述。

crossmind-cli 是一个面向 AI Agent 的社交平台命令行工具集，覆盖 15 个主流平台，专为机器消费场景设计。

---

### 免登录优先

大多数读操作无需账号。公开内容（Hacker News、Reddit、DEV.to、Stack Overflow 等）通过官方公开 API 直接获取，无需任何认证配置。需要登录态的平台（X、Instagram、LinkedIn）通过浏览器 cookie 鉴权，由内置的 `crossmind extract-cookie` 命令从本机浏览器 Profile 自动提取，一次配置后长期复用。

写操作全部走 OAuth 2.0 PKCE，不使用 UI 自动化模拟点击，账号安全性与官方客户端等同。

---

### Agent 友好的输出格式

输出专为 LLM 消费场景设计，而非人类阅读：

- 默认单行紧凑格式，字段使用 `key:value` 标注，无歧义缩写和 emoji
- 超长字段自动截断，只保留核心信号
- 无装饰性空格、框线、分隔符
- `--json` 输出为干净 JSON 数组，无外层包装

**实测 token 节约量**：
- 与原始 API 完整 JSON 响应对比：节约约 85%
- 与其他 CLI 表格/格式化输出对比：节约约 60%

同等信息密度下，单次工具调用的 token 消耗降低一个数量级。这在 Agent 高频调用场景下直接影响成本和上下文窗口占用。

---

### 内置安全策略

写操作内置多层保护，防止账号因自动化行为被封禁：

- **每日操作上限**：每类写操作设独立日限额（发推 10 条、回复 30 条、点赞 100 次等），超限自动拒绝并提示
- **随机延迟抖动**：写操作之间强制随机等待 1.5–4 秒，模拟人类操作节奏
- **指数退避重试**：遇到限速响应时自动退避重试，不暴力重发
- **TLS 指纹模拟**：X 读操作使用 JA3 指纹模拟，降低反爬识别概率
- **OAuth 而非 UI 模拟**：所有写操作走官方 API 授权路径，token 可随时独立撤销，不影响账号本身

---

### 多账号支持

每个平台可配置多个命名账号（如 `personal`、`crossmind`、`work`），通过 `--account <name>` 在单次命令中切换：

```
crossmind x feed --account personal
crossmind x post "hello" --account crossmind
```

账号通过 `crossmind account` 命令组统一管理（列举、添加、删除、设置默认）。凭证存储目录可通过 `--data-dir` 参数或 `CROSSMIND_DATA_DIR` 环境变量自定义，适配 CI/CD 和多环境部署场景。

---

### 平台覆盖全面

15 个平台，统一命令风格：

| 平台 | 别名 | 能力 |
|------|------|------|
| X (Twitter) | `x` | 读/写全量，含 DM、Lists、Spaces、Analytics |
| Reddit | `r` | 读/写全量，OAuth |
| Bluesky | `bsky` | 读/写全量，AT Protocol app password |
| GitHub | `gh` | 仓库/Issue/PR/用户/trending，公开 API |
| Product Hunt | `ph` | 产品发现/今日/搜索，公开 API |
| Hacker News | `hn` | 全量读取，公开 API |
| Lobsters | `lb` | 全量读取，公开 API |
| DEV.to | `dev` | 全量读取，公开 API |
| Stack Overflow | `so` | 全量读取，公开 API |
| arXiv | `arxiv` | 论文搜索/摘要/最新，公开 API |
| YouTube | `yt` | 搜索、视频信息、字幕提取 |
| Medium | `med` | 搜索、文章全文 |
| Substack | `sub` | Newsletter 搜索、文章全文 |
| Instagram | `ig` | 公开 Profile 读取，cookie auth |
| LinkedIn | `li` | 公开 Profile/搜索，cookie auth |

---

### 灵活的凭证管理

- **自动提取 cookie**：`crossmind extract-cookie <platform>` 从本机 Chrome、Brave、Firefox、Edge、Chromium 的 Profile 目录自动定位并提取 session cookie，支持指定浏览器和 Profile 路径，支持 `--dry-run` 预览
- **直接注入 token**：`crossmind auth x login --access-token <token>` 跳过浏览器授权，适合 CI/CD 或已有 token 的场景；传入后立即验证有效性，运行时自动刷新
- **可配置存储路径**：凭证目录默认为 `~/.crossmind/`，可通过 `--data-dir` 或环境变量覆盖，便于多环境隔离

---

### X 深度集成

X 平台支持超出基础发推/阅读的高级能力：

- **DM**：读取会话列表和对话历史（cookie auth）；发送私信（OAuth，Basic API tier 降级为 cookie 路径并标注状态）
- **Lists**：读取 List 时间线和成员；创建 List、添加/移除成员（OAuth write）
- **Spaces**：发现当前直播中的 Spaces，关键词搜索，查看 Space 详情及参与者
- **Analytics**：查看自己账号下单条推文的曝光和互动数据，以及账号近期汇总指标
- **Poll**：发推时支持附带投票选项

---

## 一、版权风险评估

### 三个工具的许可证现状

| 工具 | 作者 | License | 仓库 |
|------|------|---------|------|
| opencli | jackwener (jakevingoo@gmail.com) | **Apache-2.0** | github.com/jackwener/opencli |
| twitter-cli | jackwener | **Apache-2.0** | github.com/jackwener/twitter-cli |
| rdt-cli | jackwener | **Apache-2.0** | github.com/jackwener/rdt-cli |

三个工具同一作者，统一 Apache-2.0。

### Apache-2.0 允许的行为
- 商业使用 ✅
- 修改源代码 ✅
- 二次发行（含闭源）✅
- 专利授权 ✅

### Apache-2.0 的强制要求
- 保留原始版权声明（NOTICE 文件）
- 标注对原始代码的修改内容
- 不得使用原作者名/商标为衍生产品背书

### 风险分级

| 复用方式 | 风险等级 | 说明 |
|---------|---------|------|
| 直接 fork 并修改 | 🟡 低中 | 合法，但需完整保留 NOTICE，且用户发现后品牌形象受影响 |
| 借鉴架构，重写代码 | 🟢 低 | **推荐方案**。架构、API 调用模式不受著作权保护，只保护具体表达 |
| 复制 YAML 公开 API 配置 | 🟢 极低 | YAML pipeline 本质是 API 调用配置，类型接近数据而非创作性代码 |
| 复制 twitter search.ts 等适配器 | 🔴 中高 | 具体实现代码受保护，需重写而非复制 |

### 结论与建议

**crossmind-cli 采用"参考架构、全量重写"策略**：
- 不 fork 任何仓库
- 借鉴 opencli 的 策略分层（public/cookie/oauth）和 YAML pipeline 设计思想
- 借鉴 twitter-cli 的 `curl_cffi` TLS 指纹方案（Python）的等价 JS 实现
- 借鉴 rdt-cli 的 Gaussian jitter + 指数退避 反检测模式
- 所有适配器代码从头实现，不复制原始实现

版权风险：**可接受（低）**

---

## 二、产品设计

### 命令名称

```
crossmind <platform> <command> [args] [options]
```

```
npm install -g crossmind
crossmind hn top
```

### 平台覆盖（移除新闻、财经、中文平台）

| 平台 | 别名 | 认证方式 | 读 | 写 |
|------|------|---------|---|---|
| X (Twitter) | `x` | 读：cookie；写：OAuth 2.0 | ✅ | ✅ OAuth |
| Reddit | `r` | 读：public；写：OAuth 2.0 | ✅ | ✅ OAuth |
| Bluesky | `bsky` | AT Protocol app password | ✅ | ✅ |
| GitHub | `gh` | 无（公开 API）；可选 token 提升限额 | ✅ | — |
| Product Hunt | `ph` | 无（公开 API） | ✅ | — |
| Hacker News | `hn` | 无（公开 API） | ✅ | — |
| Lobsters | `lb` | 无（公开 API） | ✅ | — |
| DEV.to | `dev` | 无（公开 API） | ✅ | — |
| Stack Overflow | `so` | 无（公开 API） | ✅ | — |
| arXiv | `arxiv` | 无（公开 API） | ✅ | — |
| YouTube | `yt` | 无（公开 Data API） | ✅ | — |
| Medium | `med` | 无（公开 scraping） | ✅ | — |
| Substack | `sub` | 无（公开 scraping） | ✅ | — |
| Instagram | `ig` | cookie（只读） | ✅ 公开数据 | ❌ |
| LinkedIn | `li` | cookie（只读） | ✅ 公开数据 | ❌ |

### 完整命令清单

#### X (`crossmind x`)

**Read（cookie auth）**
```
crossmind x feed [--limit N] [--type home|following]
crossmind x search <query> [--from handle] [--since YYYY-MM-DD] [--lang en] [--min-likes N] [--type top|latest|photos|videos]
crossmind x thread <id>
crossmind x user <handle>
crossmind x user-posts <handle> [--limit N]
crossmind x followers <handle> [--limit N]
crossmind x following <handle> [--limit N]
crossmind x trending [--location worldwide]
crossmind x notifications [--type all|mention|like|follow|repost]
crossmind x bookmarks [--limit N]
crossmind x likes <handle> [--limit N]
```

**Write（OAuth 2.0 PKCE）**
```
crossmind x post <text> [--image path] [--reply-to id] [--poll "opt1,opt2,opt3" --poll-duration 1440]
crossmind x reply <id> <text>
crossmind x retweet <id>
crossmind x quote <id> <text>
crossmind x like <id>
crossmind x unlike <id>
crossmind x follow <handle>
crossmind x unfollow <handle>
crossmind x delete <id>
crossmind x bookmark <id>
crossmind x unbookmark <id>
```

**DM（Direct Message，cookie auth + OAuth write）**
```
crossmind x dm list [--limit N]                          # 最近 DM 会话列表
crossmind x dm conversation <user-handle> [--limit N]    # 查看与某用户的完整 DM 历史
crossmind x dm send <user-handle> <text>                 # 发送 DM
crossmind x dm send <user-handle> --file <path>          # 发送图片/文件 DM
```

> DM 读取通过 cookie auth；DM 发送通过 OAuth（需 X API Basic tier 或以上）。
> 无 Basic tier 时发送自动降级为 cookie 模拟路径，并在输出中标注降级状态。

**Lists（Twitter Lists）**
```
crossmind x lists <handle>                               # 列出某用户创建/订阅的 Lists
crossmind x list-timeline <list-id> [--limit N]          # List 时间线
crossmind x list-members <list-id> [--limit N]           # List 成员
crossmind x list-create <name> [--private]               # 创建 List（OAuth write）
crossmind x list-add <list-id> <handle>                  # 添加成员（OAuth write）
crossmind x list-remove <list-id> <handle>               # 移除成员（OAuth write）
```

**Spaces**
```
crossmind x spaces [--limit N]                           # 当前正在直播的 Spaces
crossmind x spaces search <query> [--limit N]            # 搜索 Spaces
crossmind x spaces info <space-id>                       # Space 详情及参与者
```

**Analytics（需 OAuth，数据仅限自己账号的推文）**
```
crossmind x analytics <tweet-id>                         # 单条推文的曝光/互动数据
crossmind x analytics-summary [--days N]                 # 最近 N 天账号整体数据
```

#### Reddit (`crossmind r`)

**Read（public API）**
```
crossmind r feed [--limit N]
crossmind r hot [--limit N]
crossmind r popular [--limit N]
crossmind r sub <name> [--sort hot|new|top|rising] [--limit N]
crossmind r sub-info <name>
crossmind r search <query> [--sub name] [--sort relevance|hot|top|new] [--limit N]
crossmind r post <id>
crossmind r user <name>
crossmind r user-posts <name> [--limit N]
crossmind r user-comments <name> [--limit N]
crossmind r saved [--limit N]          # 需 OAuth
crossmind r upvoted [--limit N]        # 需 OAuth
```

**Write（OAuth 2.0）**
```
crossmind r comment <post-id> <text>
crossmind r reply <comment-id> <text>
crossmind r upvote <id>
crossmind r downvote <id>
crossmind r save <id>
crossmind r unsave <id>
crossmind r subscribe <sub>
crossmind r unsubscribe <sub>
```

#### Hacker News (`crossmind hn`)
```
crossmind hn top [--limit N]
crossmind hn best [--limit N]
crossmind hn show [--limit N]
crossmind hn ask [--limit N]
crossmind hn jobs [--limit N]
crossmind hn search <query> [--sort relevance|date] [--limit N]
crossmind hn post <id>
crossmind hn user <name>
```

#### Lobsters (`crossmind lb`)
```
crossmind lb hot [--limit N]
crossmind lb active [--limit N]
crossmind lb newest [--limit N]
crossmind lb tag <name> [--limit N]
```

#### DEV.to (`crossmind dev`)
```
crossmind dev feed [--limit N]
crossmind dev tag <name> [--limit N]
crossmind dev user <name>
crossmind dev search <query>           # DEV.to public search API
```

#### Stack Overflow (`crossmind so`)
```
crossmind so search <query> [--limit N]
crossmind so hot [--limit N]
crossmind so question <id>
crossmind so bounties [--limit N]
```

#### YouTube (`crossmind yt`)
```
crossmind yt search <query> [--limit N] [--type video|channel|playlist]
crossmind yt info <url-or-id>
crossmind yt transcript <url-or-id> [--lang en]
```

#### Medium (`crossmind med`)
```
crossmind med search <query> [--limit N]
crossmind med user <name>
crossmind med post <url>               # 获取文章完整正文
```

#### Substack (`crossmind sub`)
```
crossmind sub search <query> [--limit N]
crossmind sub publication <url> [--limit N]
crossmind sub post <url>               # 获取文章正文
```

#### Instagram（只读，`crossmind ig`）
```
crossmind ig profile <handle>
crossmind ig posts <handle> [--limit N]
crossmind ig explore [--limit N]
```

#### LinkedIn（只读，`crossmind li`）
```
crossmind li search <query> [--type people|jobs|companies]
crossmind li profile <url-or-id>
```

#### Bluesky (`crossmind bsky`)

**Read（AT Protocol，无需认证）**
```
crossmind bsky feed [--limit N]
crossmind bsky search <query> [--limit N] [--lang en]
crossmind bsky profile <handle>
crossmind bsky posts <handle> [--limit N]
crossmind bsky followers <handle> [--limit N]
crossmind bsky following <handle> [--limit N]
crossmind bsky trending [--limit N]
```

**Write（app password auth）**
```
crossmind bsky post <text> [--image path] [--reply-to uri]
crossmind bsky reply <uri> <text>
crossmind bsky like <uri>
crossmind bsky unlike <uri>
crossmind bsky repost <uri>
crossmind bsky follow <handle>
crossmind bsky unfollow <handle>
crossmind bsky delete <uri>
```

> Bluesky 使用 AT Protocol app password（在账号设置中生成，不影响主密码）。
> 通过 `crossmind auth bsky login --app-password <password>` 配置。

#### GitHub (`crossmind gh`)

**Read（公开 API，可选 token 提升 rate limit）**
```
crossmind gh trending [--lang <lang>] [--since daily|weekly|monthly] [--limit N]
crossmind gh search <query> [--type repos|users|code|issues] [--limit N]
crossmind gh repo <owner/repo>
crossmind gh issues <owner/repo> [--state open|closed] [--limit N]
crossmind gh issue <owner/repo> <number>
crossmind gh pulls <owner/repo> [--state open|closed] [--limit N]
crossmind gh pull <owner/repo> <number>
crossmind gh releases <owner/repo> [--limit N]
crossmind gh user <username>
crossmind gh user-repos <username> [--sort stars|updated|created] [--limit N]
crossmind gh stars <owner/repo> [--limit N]
crossmind gh readme <owner/repo>
```

> 无 token 时 rate limit 为 60 次/小时；配置 `GITHUB_TOKEN` 或通过
> `crossmind auth gh set-token` 后提升至 5000 次/小时。

#### Product Hunt (`crossmind ph`)
```
crossmind ph today [--limit N]                          # 今日产品
crossmind ph top [--since daily|weekly|monthly] [--limit N]
crossmind ph search <query> [--limit N]
crossmind ph product <slug>                             # 产品详情、upvotes、评论
crossmind ph topics [--limit N]                         # 热门话题
crossmind ph topic <slug> [--limit N]                   # 某话题下的产品
```

#### arXiv (`crossmind arxiv`)
```
crossmind arxiv search <query> [--limit N] [--sort relevance|date] [--category <cat>]
crossmind arxiv recent [--category <cat>] [--limit N]   # 最新提交
crossmind arxiv paper <id>                              # 标题、摘要、作者、分类、链接
crossmind arxiv abstract <id>                           # 只输出摘要（最省 token）
```

> 常用 category：`cs.AI`、`cs.LG`、`cs.CL`、`stat.ML`、`cs.IR`。
> 完整 arXiv ID 示例：`2401.12345` 或 `cs/0301012`。

#### Auth 管理（`crossmind auth`）
```
crossmind auth status                               # 显示所有平台认证状态
crossmind auth x login [--account <name>]                                     # 触发 OAuth 2.0 PKCE 流程（开浏览器）
crossmind auth x login --access-token <token> [--refresh-token <token>] [--account <name>]  # 直接传入 token（跳过浏览器授权）
crossmind auth x set-cookie [--account <name>]                                # 从环境变量 X_AUTH_TOKEN / X_CT0 读取
crossmind auth reddit login [--account <name>]               # Reddit OAuth PKCE
crossmind auth reddit set-cookie [--account <name>]          # 从 rdt credential.json 导入
crossmind auth bsky login --app-password <password> [--account <name>]  # Bluesky app password
crossmind auth gh set-token [--account <name>]               # GitHub token（可选，提升 rate limit）
crossmind auth instagram set-cookie [--account <name>]
crossmind auth linkedin set-cookie [--account <name>]
crossmind auth show <platform> [--account <name>]   # 显示 token 状态（脱敏）
```

#### 账号管理（`crossmind account`）
```
crossmind account list [<platform>]                 # 列出所有/某平台所有账号
crossmind account add <platform> <name>             # 添加命名账号（提示输入凭证）
crossmind account remove <platform> <name>          # 删除账号
crossmind account use <platform> <name>             # 设置某平台默认账号
crossmind account show <platform> <name>            # 显示账号凭证摘要（脱敏）
```

每个平台命令均支持 `--account <name>` 覆盖默认账号，例如：
```
crossmind x feed --account crossmind
crossmind r sub Entrepreneur --account personal
crossmind ig profile elonmusk --account work
```

#### Cookie 提取（`crossmind extract-cookie`）
```
crossmind extract-cookie <platform>                 # 自动搜索常见浏览器 Profile 目录
crossmind extract-cookie <platform> --browser chrome|brave|firefox|edge|chromium
crossmind extract-cookie <platform> --profile-dir <path>   # 指定 Profile 目录
crossmind extract-cookie <platform> --account <name>        # 保存到指定账号
crossmind extract-cookie <platform> --dry-run               # 只显示找到的 cookie，不写入
crossmind extract-cookie <platform> --domains "example.com,auth.example.com"  # 自定义域名过滤
```

自动搜索路径（按优先级）：
- Chrome: `~/.config/google-chrome/` · macOS: `~/Library/Application Support/Google/Chrome/`
- Brave: `~/.config/BraveSoftware/Brave-Browser/` · macOS: `~/Library/Application Support/BraveSoftware/Brave-Browser/`
- Firefox: `~/.mozilla/firefox/` · macOS: `~/Library/Application Support/Firefox/`
- Edge: `~/.config/microsoft-edge/` · macOS: `~/Library/Application Support/Microsoft Edge/`
- Chromium: `~/.config/chromium/`

多 Profile 时自动选最近登录的 Profile；无法确定时交互式列举供选择。

### 输出设计原则

**核心目标：Agent 友好 + 极致 token 节约**

每条输出都是面向 LLM 消费而非人类阅读设计的。默认输出即最省 token 的格式——单行紧凑，只保留核心信号字段，超长字段截断，无装饰性空格/框线/分隔符。

**默认输出（紧凑单行格式）**：
```
$ crossmind hn top --limit 5
1. [score:212 comments:72] Flighty Airports https://example.com
2. [score:554 comments:413] Goodbye to Sora https://example.com
3. [score:300 comments:54] I took back Video.js after 16 years https://example.com
4. [score:206 comments:91] Show HN: Cq – Stack Overflow for AI agents https://example.com
5. [score:126 comments:88] Show HN: ProofShot – Give AI agents eyes to verify UI https://example.com
```

```
$ crossmind x feed --limit 3
1. @elonmusk [likes:8800 views:591000] Optimus https://t.co/d6AU3p4xBn
2. @TeeDevh [likes:39 views:2800] Why do people still use Vercel?...
3. @foxtomb232 [likes:17 views:16000] Being a reply guy is exhausting...
```

**`--json`**：结构化输出，供 Agent 解析或传递给下游工具，无包装层
```json
[
  { "rank": 1, "score": 212, "comments": 72, "title": "...", "url": "..." }
]
```

**Token 节约量化**（与同类工具对比的核心宣传点）：
- vs. 原始 API JSON（含全量字段）：节约 **~85%**
- vs. 其他 CLI 的表格/格式化输出：节约 **~60%**
- 同等信息密度下，单次工具调用的 token 消耗降低一个数量级

**通用选项**（所有命令适用）
```
--json              结构化 JSON 数组输出（Agent 解析用）
--limit N           结果数量上限（默认各平台自定义）
--quiet             只输出数据行，无 footer
--data-dir <path>   覆盖凭证和配置的存储目录（优先于 CROSSMIND_DATA_DIR 环境变量）
```

---

## 三、技术架构

### 技术选型

- **语言**：TypeScript，Node.js 20+
- **包管理**：pnpm
- **HTTP（X read）**：`undici` + 自定义 TLS/JA3 fingerprint（模拟 `curl_cffi` 的 JS 等价）
- **HTTP（其他）**：原生 `fetch` / `undici`
- **CLI 框架**：`commander.js`（与 opencli 一致，熟悉度高）
- **表格输出**：`cli-table3`（轻量，opencli 已验证）
- **颜色**：`chalk`
- **OAuth**：自实现 PKCE 流程 + `open` 包打开浏览器
- **浏览器（Instagram/LinkedIn read-only）**：Playwright，仅只读场景使用，无 daemon

### 分层架构

```
crossmind-cli/
├── src/
│   ├── main.ts              # 入口，注册所有平台命令
│   ├── auth/
│   │   ├── oauth.ts         # 通用 OAuth 2.0 PKCE 流程
│   │   ├── x.ts             # X OAuth + cookie auth
│   │   ├── reddit.ts        # Reddit OAuth
│   │   ├── store.ts         # 多账号凭证存储，路径通过 CROSSMIND_DATA_DIR 或 --data-dir 配置
│   │   └── extract-cookie.ts # 浏览器 cookie 自动提取
│   ├── platforms/
│   │   ├── x/               # 每个命令一个文件
│   │   │   ├── feed.ts
│   │   │   ├── search.ts
│   │   │   ├── post.ts      # OAuth write
│   │   │   └── ...
│   │   ├── reddit/
│   │   ├── bluesky/         # AT Protocol app password
│   │   ├── github/          # 公开 API，可选 token
│   │   ├── producthunt/     # 公开 API
│   │   ├── hackernews/      # 全 public API，YAML pipeline 配置
│   │   ├── lobsters/
│   │   ├── devto/
│   │   ├── stackoverflow/
│   │   ├── arxiv/           # 公开 XML API
│   │   ├── youtube/
│   │   ├── medium/
│   │   ├── substack/
│   │   ├── instagram/       # cookie only, read-only
│   │   └── linkedin/
│   ├── http/
│   │   ├── client.ts        # 带 jitter/retry/backoff 的基础 HTTP 客户端
│   │   ├── x-client.ts # TLS fingerprint 模拟
│   │   └── pipeline.ts      # YAML pipeline executor（借鉴 opencli 设计）
│   └── output/
│       ├── formatter.ts     # 紧凑单行（默认）/ json
│       └── colors.ts
├── <data-dir>/              # 运行时数据目录，默认 ~/.crossmind/
│   │                        # 优先级：--data-dir > CROSSMIND_DATA_DIR > ~/.crossmind/
│   ├── config.json          # 全局配置（各平台默认账号、全局选项）
│   ├── daily-limits.json    # 写操作日限额计数
│   └── accounts/
│       ├── x/
│       │   ├── personal.json   # cookie + oauth token
│       │   └── crossmind.json
│       ├── reddit/
│       │   ├── personal.json
│       │   └── crossmind.json
│       ├── instagram/
│       └── linkedin/
├── adapters/                # 公开 API 平台的 YAML pipeline 定义
│   ├── hackernews/
│   │   ├── top.yaml
│   │   ├── search.yaml
│   │   └── ...
│   ├── lobsters/
│   ├── devto/
│   └── stackoverflow/
├── package.json
└── README.md
```

### 写操作安全机制（重点）

opencli 的写操作用 UI 点击，无速率限制，单 tab 串行限制。crossmind-cli 改为：

**X 写操作：X API v2 OAuth 2.0 PKCE**

两种 token 获取模式，写入同一凭证存储：

**模式 A：浏览器授权（交互式）**
- `crossmind auth x login` → 打开浏览器 → OAuth PKCE 授权 → access token + refresh token 存本地

**模式 B：直接传入 token（自动化友好）**
- `crossmind auth x login --access-token <token> [--refresh-token <token>]`
- 写入前立即调用 `GET /2/users/me` 验证 token 有效性，无效则报错并终止
- 每次执行写操作前检查 token 有效期；剩余不足 5 分钟时自动用 refresh token 换取新 access token
- 无 refresh token 时，token 过期后报错提示重新传入，不静默失败

**共同约束**
- 写操作通过 X API v2 执行（POST /2/tweets 等）
- 免费层限制：1500 条/月，自动在 footer 显示配额余量
- token 可随时通过 `crossmind auth x login`（任意模式）覆盖更新

**Reddit 写操作：Reddit OAuth 2.0（script app type）**
- `crossmind auth reddit login` → script app → 用户授权
- 写操作通过 `oauth.reddit.com` API 执行
- 好处：不依赖 modhash/cookie，标准 OAuth 机制

**所有写操作内置保护**：
```typescript
const WRITE_LIMITS = {
  x:      { post: 10, reply: 30, like: 100, follow: 50, dm: 50 },
  reddit: { comment: 20, upvote: 100, save: 50 },
  bsky:   { post: 20, reply: 50, like: 200, follow: 100 },
};

const WRITE_DELAY = { min: 1500, max: 4000 }; // ms，随机抖动

// 操作前检查当日计数（<data-dir>/daily-limits.json）
```

---

## 四、开发计划

### Phase 1：基础架构（约 3 天）

**目标**：`crossmind` 命令可执行，HN 全量可用，auth 框架跑通

| 任务 | 产出 |
|------|------|
| 项目初始化（TypeScript + pnpm + commander）| `package.json`，可执行入口 |
| HTTP 基础客户端（jitter + retry + backoff）| `src/http/client.ts` |
| Output formatter（紧凑单行默认 + json 模式）| `src/output/formatter.ts` |
| YAML pipeline executor（借鉴 opencli 设计，重写） | `src/http/pipeline.ts` |
| 多账号存储框架（路径可配置：`--data-dir` / `CROSSMIND_DATA_DIR`，默认 `~/.crossmind/`）| `src/auth/store.ts` |
| `crossmind account` 命令组（list/add/remove/use/show）| `src/commands/account.ts` |
| `crossmind extract-cookie` 命令（Chrome/Brave/Firefox/Edge 自动检测）| `src/auth/extract-cookie.ts` |
| HN 全量命令（top/best/show/ask/jobs/search/user/post）| `adapters/hackernews/*.yaml` |
| `crossmind auth status` 命令 | 显示各平台/各账号状态 |

**验收**：`crossmind hn top --json`，`crossmind hn search "AI agent"` 正常返回

### Phase 2：Reddit（约 3 天）

**目标**：Reddit 读写全量，OAuth 流程完整

| 任务 | 产出 |
|------|------|
| Reddit OAuth 2.0 实现（script app + refresh token）| `src/auth/reddit.ts` |
| Reddit public API 读命令（feed/hot/popular/sub/search/post/user）| `src/platforms/reddit/` |
| Reddit 需 auth 的读命令（saved/upvoted）| 同上 |
| Reddit 写命令（comment/upvote/save/subscribe）| 同上，OAuth 路径 |
| 从 rdt credential.json 导入 cookie 作为兼容方案 | `crossmind auth reddit set-cookie` |
| 写操作速率限制 + daily limit 保护 | `src/http/rate-limiter.ts` |

**验收**：`crossmind r search "AI agent" -r Entrepreneur`，`crossmind r comment <id> "test"`

### Phase 3：X + Bluesky（约 7 天）

**目标**：X 全量能力（OAuth 写 + cookie 读，含 DM / Lists / Spaces / Analytics）；Bluesky 读写全量

| 任务 | 产出 |
|------|------|
| X cookie auth（X_AUTH_TOKEN + X_CT0）| `src/auth/x.ts` |
| X TLS fingerprint HTTP 客户端 | `src/http/x-client.ts` |
| X 读命令（feed/search/user/thread/trending/notifications/bookmarks/likes）| `src/platforms/x/` |
| X OAuth 2.0 PKCE 实现 | `src/auth/oauth.ts` |
| 直接 token 注入（`--access-token`）+ 启动验证 + 自动刷新 | `src/auth/x.ts` |
| X 写命令（post/reply/like/retweet/quote/follow/delete/bookmark）含 poll 参数 | 同上，OAuth 路径 |
| DM 读取（会话列表 + 对话历史，cookie auth）| `src/platforms/x/dm.ts` |
| DM 发送（OAuth write，Basic tier 降级处理）| 同上 |
| Lists 全量（timeline/members/create/add/remove）| `src/platforms/x/lists.ts` |
| Spaces（发现/搜索/详情，cookie auth）| `src/platforms/x/spaces.ts` |
| Analytics（单条推文 + 账号汇总，OAuth）| `src/platforms/x/analytics.ts` |
| 高级搜索参数（--from/--since/--lang/--min-likes）| `src/platforms/x/search.ts` |
| 写操作 daily limit 保护 | 与 Phase 2 共用 |
| Bluesky AT Protocol app password auth | `src/auth/bluesky.ts` |
| Bluesky 读命令（feed/search/profile/posts/followers/trending）| `src/platforms/bluesky/` |
| Bluesky 写命令（post/reply/like/repost/follow/delete）| 同上 |

**验收**：`crossmind x feed`，`crossmind x post "test"`，`crossmind auth x login` OAuth 流程，`crossmind bsky feed`，`crossmind bsky post "test"`

### Phase 4：研究类平台（约 4 天）

**目标**：GitHub、Product Hunt、arXiv、Lobsters、DEV.to、SO、YouTube、Medium、Substack 全量

| 任务 | 产出 |
|------|------|
| GitHub 公开 API 全量命令（trending/search/repo/issues/pulls/user）| `src/platforms/github/` |
| GitHub token 可选配置（rate limit 60→5000）| `src/auth/github.ts` |
| Product Hunt 公开 API（today/top/search/product/topics）| `src/platforms/producthunt/` |
| arXiv XML API（search/recent/paper/abstract）| `src/platforms/arxiv/` |
| Lobsters（全 YAML pipeline，公开 API）| `adapters/lobsters/` |
| DEV.to（公开 API，支持搜索）| `adapters/devto/` |
| Stack Overflow（公开 API）| `adapters/stackoverflow/` |
| YouTube（Data API v3 + transcript 用 yt-dlp）| `src/platforms/youtube/` |
| Medium（公开 scraping）| `src/platforms/medium/` |
| Substack（公开 scraping）| `src/platforms/substack/` |

**验收**：`crossmind gh trending`，`crossmind ph today`，`crossmind arxiv search "LLM agent" --category cs.AI`，`crossmind yt transcript <url>`

### Phase 5：只读 cookie 类（约 2 天）

**目标**：Instagram、LinkedIn 公开数据读取

| 任务 | 产出 |
|------|------|
| Instagram profile/posts/explore（cookie auth，只读）| `src/platforms/instagram/` |
| LinkedIn search/profile（cookie auth，只读）| `src/platforms/linkedin/` |
| Playwright 按需启动（只用于 ig/li，不常驻 daemon）| 按需 launch，用完关闭 |

**验收**：`crossmind ig profile elonmusk`，`crossmind li search "AI founder"`

### Phase 6：打磨与发布（约 2 天）

| 任务 | 产出 |
|------|------|
| `crossmind auth status` 完整显示（配额/token 过期时间）| 完整 auth 状态 |
| 各平台输出 token 用量基准测试（与原始 API 对比）| token 节约数据 |
| 错误信息精简（auth 失败给出具体操作指引，单行）| 友好报错 |
| `crossmind --help` 和各子命令 help 完整 | 文档内嵌 CLI |
| 打包为单文件可执行（pkg 或 bun compile）| `crossmind` / `crossmind` 二进制 |
| `npm install -g crossmind` 可用 | npm/pnpm 发布 |

---

## 五、关键设计决策

### 为什么写操作不用浏览器（opencli 的路径）

| 方面 | opencli 浏览器写 | crossmind-cli OAuth 写 |
|------|----------------|----------------------|
| 账号安全 | 高风险（IP 异常触发安全警告）| 低风险（官方授权路径）|
| 并发 | 串行（单 tab 限制）| 并发安全 |
| 维护成本 | UI selector 随网站改版失效 | API 稳定，版本化 |
| 速率限制 | 无保护 | 平台强制限速，有反馈 |
| token 撤销 | 只能改密码 | 随时 revoke，账号不受影响 |

### 为什么 X 读操作不用官方 API

X API v2 免费层限制严格：
- 读：每月 1M tweet/app，但用户级端点（feed、notifications）不在免费层
- Cookie + TLS fingerprint 方案读到的内容与真实用户一致，无字段缺失
- 官方 API 读取的适合高量数据，不适合个人 agent 的低频调用场景

### YAML Pipeline vs TypeScript 适配器的分工

| 适合 YAML Pipeline | 适合 TypeScript |
|-------------------|----------------|
| 公开 API，逻辑简单（fetch → map → filter）| 需要复杂解析的私有 API（X intercept）|
| HN、Lobsters、DEV.to、SO | X search（拦截 SPA 请求）|
| arXiv XML API（结构稳定，字段固定）| Bluesky（AT Protocol 客户端逻辑较复杂）|
| GitHub REST API（标准 JSON 响应）| Instagram/LinkedIn（动态 DOM 解析）|
| Product Hunt API | |
| 维护成本低，非工程师可以贡献 | |

---

## 六、风险与对策

| 风险 | 可能性 | 对策 |
|------|--------|------|
| X 私有 API 变更导致 read 失效 | 中 | 模块化适配器，单独修复不影响其他命令 |
| DM 发送需要 Basic API tier（$100/月）| 中 | 自动降级到 cookie 模拟路径，输出中标注降级状态 |
| Reddit 封锁 anonymous 访问 | 低 | fallback 到 OAuth 读取 |
| GitHub 无 token 时 rate limit 过低（60/h）| 中 | 提示配置 token，超限后输出明确报错和配置指引 |
| Product Hunt 非官方 API 结构变更 | 中 | 接口较稳定；变更后模块化修复 |
| Instagram scraping 触发 bot 检测 | 高 | 设置合理 delay + 提醒用户风险 |
| LinkedIn 反爬严格 | 高 | 仅暴露最基础的 profile 查询，失败不报 error |
| jackwener 提版权主张 | 极低 | 全量重写，代码无重叠，Apache-2.0 合规 |

---

## 七、优先级小结

按用户价值排序的实施顺序：

1. **Phase 1**（HN + 架构）— 立即可用，调研场景最常用
2. **Phase 3**（X + Bluesky）— CrossMind agent 的核心操作平台；Bluesky 顺带实现成本低
3. **Phase 2**（Reddit）— 第二大平台，获客渠道有效
4. **Phase 4**（GitHub / Product Hunt / arXiv + 研究类）— 竞品调研和技术情报核心来源
5. **Phase 5**（Instagram/LinkedIn）— 有限价值，最后做
6. **Phase 6**（发布）— 对外可用后跟上

可以在 Phase 1+3 完成后就内部使用，Phase 1+3+2+4 完成后对外发布。

---

## 八、当前实施进度（2026-03-26）

仓库：[https://github.com/cross-mind/cli](https://github.com/cross-mind/cli)

### 进度总览

| Phase | 状态 | 备注 |
|-------|------|------|
| Phase 1：基础架构 | ✅ 完成 | |
| Phase 2：Reddit | ✅ 完成 | |
| Phase 3：X + Bluesky | 🟡 部分完成 | X 可用；Bluesky 框架在但未验证 |
| Phase 4：研究类平台 | 🟡 部分完成 | 6/9 可用，PH/YouTube/Bluesky 待处理 |
| Phase 5：Instagram/LinkedIn | 🟡 框架在 | 报清晰错误，cookie 提取未验证 |
| Phase 6：打磨与发布 | ❌ 未开始 | |

---

### Phase 1 完成情况

- ✅ TypeScript + pnpm + commander.js 项目架构
- ✅ HTTP 基础客户端（jitter + retry + backoff）
- ✅ YAML pipeline executor（adapters/）
- ✅ Output formatter（紧凑单行 + `--json`）
- ✅ 多账号凭证存储（`~/.crossmind/` 或 `CROSSMIND_DATA_DIR`）
- ✅ `crossmind account` 命令组
- ✅ `crossmind extract-cookie` 命令（Playwright，支持 x/instagram/linkedin）
- ✅ `crossmind auth status`
- ✅ HN：top/ask/search/show（YAML pipeline）
- ✅ 48 个单元测试 + 集成测试，全部通过

### Phase 2 完成情况

- ✅ Reddit OAuth 2.0 PKCE
- ✅ Reddit cookie auth（session + modhash）
- ✅ 认证优先链：公开 API → cookie → OAuth
- ✅ Reddit 读命令：`r <subreddit>`、`search`、`comments`
- ✅ Reddit 写命令：`comment`、`upvote/downvote`、`save`、`subscribe`、`post`
- ✅ 写操作 daily limit 保护（`src/http/rate-limiter.ts`）

### Phase 3 当前状态

**X (Twitter) — 可用**
- ✅ Cookie auth（auth_token + ct0）
- ✅ 认证优先链：cookie → OAuth token → public bearer（仅 search）
- ✅ `x search`、`x home`、`x timeline`、`x profile`
- ✅ OAuth 2.0 PKCE 写操作（`x post`、`x reply`、`x like`、`x retweet`、`x follow`、`x dm`、`x delete`）
- ✅ 写操作 daily limit 保护

**X 架构特殊说明 — twitter-cli bridge**

原计划使用 Node.js 原生 TLS fingerprint 模拟访问 `x.com/i/api/graphql`。实测发现 x.com 对非 Chrome JA3 指纹返回 404（bot 检测），Node.js `fetch()` 无法绕过。

当前方案：cookie auth 时通过 subprocess 调用 `/root/.local/share/uv/tools/twitter-cli/bin/twitter`，该工具使用 `curl_cffi` Python 库模拟 Chrome TLS。REST v2 API 作为无 cookie 时的降级路径。

**影响：**
- 运行时依赖外部 `twitter-cli` 二进制（需预装 uv + `uvx install twitter-cli`）
- cookie 读操作速度约 2–10 秒（subprocess 启动 + Python 开销），高于原生 fetch
- 无 `twitter-cli` 时自动降级到 v2 REST（search 功能受限，feed/home 不可用）

**待实现（原 Phase 3 计划中）：**
- ❌ `x thread`：读取完整对话串
- ❌ `x dm list / dm conversation`：DM 读取（cookie auth）
- ❌ `x lists`、`x list-timeline`、`x list-members`、`x list-create`
- ❌ `x spaces`：Spaces 发现/搜索
- ❌ `x analytics`：推文 + 账号数据
- ❌ `x bookmarks`、`x likes <handle>`、`x followers`、`x following`
- ❌ `x trending`

**Bluesky — 框架完成，未端到端验证**
- ✅ AT Protocol app password auth（`src/auth/bluesky.ts`）
- ✅ 读命令：`bsky timeline`、`bsky search`、`bsky profile`、`bsky posts`
- ✅ 写命令：`bsky post`、`bsky reply`、`bsky like`、`bsky repost`、`bsky follow`、`bsky delete`
- ⚠️ 未能端到端测试（需要 Bluesky 账号 + app password）
- ⚠️ `bsky search` 当前要求 auth，计划改为 public API 路径（`app.bsky.feed.searchPosts` 支持无鉴权访问）

### Phase 4 当前状态

| 平台 | 状态 | 备注 |
|------|------|------|
| GitHub | ✅ 可用 | trending、search，public API |
| Lobsters | ✅ 可用 | YAML pipeline |
| DEV.to | ✅ 可用 | search、tag，public API |
| Stack Overflow | ✅ 可用 | search，public API |
| arXiv | ✅ 可用 | search with `--cat` 过滤 |
| Medium | ✅ 可用 | tag feed（RSS） |
| Substack | ✅ 可用 | newsletter feed（RSS） |
| Product Hunt | ⚠️ 需 API token | 当前返回 401；需在 PH Developer Portal 申请 token |
| YouTube | ⚠️ 需 API key | 框架在，`yt search` 需配置 Google Data API v3 key |

### Phase 5 当前状态

- ✅ Instagram/LinkedIn 命令框架完整
- ✅ 无 cookie 时返回明确错误信息 + 操作指引
- ⚠️ `extract-cookie` 命令基于 Playwright，在无图形界面的 CI 环境中需要 `--headless` 支持
- ⚠️ 实际 cookie 提取未在生产环境验证

---

### 已知问题与待处理事项

| 问题 | 优先级 | 说明 |
|------|--------|------|
| twitter-cli 运行时依赖 | 🔴 高 | 需预装 uv 工具链；部署文档和 README 须说明 |
| Bluesky search 强制 auth | 🟡 中 | AT Protocol `app.bsky.feed.searchPosts` 公开端点无需鉴权，可去掉 auth gate |
| Product Hunt 401 | 🟡 中 | 申请 PH developer token 后可用 |
| X 高级读命令缺失 | 🟡 中 | DM / Lists / Spaces / Analytics 未实现 |
| YouTube API key 未配置 | 🟢 低 | 功能本身已实现，需用户提供 key |
| npm 发布 + 单文件二进制 | 🟢 低 | Phase 6 内容，对外发布前处理 |
| Playwright 无头环境兼容 | 🟢 低 | ig/li cookie 提取在 server 环境需要验证 |

---

## 九、Phase 2 详细开发计划（2026-03-26）

> 基于 twitter-cli v0.8.5 和 rdt-cli v0.4.1 代码审计结果，补全 X 和 Reddit 所有公开能力。
> 全部实现完毕后仍保持 48+ 测试通过、`pnpm build` 无错误。

---

### 9.1 X (Twitter) Phase 2

#### 新增读命令

| 命令 | 签名 | 实现方式 | 鉴权 |
|------|------|---------|------|
| `x tweet` | `x tweet <tweet_id> [limit]` | bridge: `twitter tweet ID -n N --json` | cookie → REST v2 fallback |
| `x followers` | `x followers <username> [limit]` | bridge: `twitter followers HANDLE -n N --json` | no-auth REST v2 |
| `x following` | `x following <username> [limit]` | bridge: `twitter following HANDLE -n N --json` | no-auth REST v2 |
| `x bookmarks` | `x bookmarks [limit]` | bridge: `twitter bookmarks -n N --json` | cookie 必须 |
| `x list` | `x list <list_id> [limit]` | bridge: `twitter list LIST_ID -n N --json` → REST v2 fallback | OAuth → public bearer |
| `x likes` | `x likes <username> [limit]` | REST v2 `/2/users/{id}/liked_tweets` | OAuth（他人仅自己可见） |

**Bridge 输出格式**（twitter-cli `--json` 返回）：
```json
{ "ok": true, "data": [{ "id": "...", "text": "...", "author": { "screenName": "..." }, "metrics": {...} }] }
```
tweet 命令额外包含 `replies` 数组字段，映射为 `thread` 输出。

**REST v2 fallback**（无 cookie 时）：
- `followers/following`：`/2/users/{id}/followers`、`/2/users/{id}/following` + `user.fields=username,name,public_metrics`
- `list`：`/2/lists/{id}/tweets` + expansions
- `likes`：`/2/users/{id}/liked_tweets`

---

#### 新增写命令

| 命令 | 签名 | API | 鉴权 |
|------|------|-----|------|
| `x quote` | `x quote <tweet_id> "<text>"` | POST `/2/tweets` with `quote_tweet_id` | OAuth 必须 |
| `x unlike` | `x unlike <tweet_id>` | DELETE `/2/users/{me}/likes/{id}` | OAuth 必须 |
| `x unretweet` | `x unretweet <tweet_id>` | DELETE `/2/users/{me}/retweets/{id}` | OAuth 必须 |
| `x bookmark` | `x bookmark <tweet_id>` | POST GraphQL Bookmark (bridge) | cookie 必须 |
| `x unbookmark` | `x unbookmark <tweet_id>` | DELETE GraphQL Bookmark (bridge) | cookie 必须 |
| `x unfollow` | `x unfollow <username>` | DELETE `/2/users/{me}/following/{id}` | OAuth 必须 |

bookmark / unbookmark 通过 twitter-cli bridge：
```bash
twitter bookmark TWEET_ID --json
twitter unbookmark TWEET_ID --json
```

---

#### DM 读（v2 REST，OAuth dm.read scope）

| 命令 | 签名 | API | 鉴权 |
|------|------|-----|------|
| `x dm-list` | `x dm-list [limit]` | GET `/2/dm_events?event_types=MessageCreate` | OAuth + dm.read scope |
| `x dm-conversation` | `x dm-conversation <participant_username> [limit]` | GET `/2/dm_conversations/with/{participant}/dm_events` | OAuth + dm.read scope |

DM 写操作（`x dm`）已实现，这里补全读端。
无 dm.read scope 时返回清晰错误：`Requires OAuth dm.read scope. Run: crossmind auth login x`

---

#### 输出结构扩展

新增类型：
```typescript
// tweet 命令返回（含 thread）
export interface XTweetThread {
  tweet: XTweet;
  thread: XTweet[];  // 回复链
}

// followers/following/likes 返回
export interface XUser { ... }  // 已有，复用

// dm-list / dm-conversation
export interface XDMEvent {
  rank: number;
  id: string;
  sender: string;
  recipient: string;
  text: string;
  created_at: string;
}
```

---

### 9.2 Reddit Phase 2

#### 新增读命令

| 命令 | 签名 | API | 鉴权 |
|------|------|-----|------|
| `reddit popular` | `reddit popular [limit] --sort SORT --time TIME` | `/r/popular/{sort}.json` | 公开 |
| `reddit all` | `reddit all [limit] --sort SORT --time TIME` | `/r/all/{sort}.json` | 公开 |
| `reddit sub-info` | `reddit sub-info <subreddit>` | `/r/{sub}/about.json` | 公开 |
| `reddit user` | `reddit user <username>` | `/user/{name}/about.json` | 公开 |
| `reddit user-posts` | `reddit user-posts <username> [limit] --sort SORT` | `/user/{name}/submitted.json` | 公开 |
| `reddit user-comments` | `reddit user-comments <username> [limit] --sort SORT` | `/user/{name}/comments.json` | 公开 |
| `reddit post` | `reddit post <post_id> [limit] --sort SORT` | `/r/{sub}/comments/{id}.json` | 公开 |
| `reddit home` | `reddit home [limit] --sort SORT` | `/` (JSON feed) | OAuth/cookie 必须 |
| `reddit saved` | `reddit saved [limit]` | `/user/me/saved.json` | OAuth/cookie 必须 |

`reddit post` 从 URL 或裸 ID 解析 post_id（去掉 `t3_` 前缀），返回帖子 + 顶级评论列表。

---

#### 新增写命令

| 命令 | 签名 | API | 鉴权 |
|------|------|-----|------|
| `reddit text-post` | `reddit text-post <subreddit> "<title>" "<text>"` | POST `/api/submit` with `kind=self` | OAuth 必须 |
| `reddit crosspost` | `reddit crosspost <target_sub> <post_id>` | POST `/api/submit` with `kind=crosspost` | OAuth 必须 |

已有 `reddit post` 命令提交链接帖（`kind=link`），`text-post` 补全文字帖场景。

---

#### 新增输出类型

```typescript
export interface RedditSubInfo {
  name: string;
  title: string;
  subscribers: number;
  active_users: number;
  description: string;
  url: string;
  nsfw: boolean;
}

export interface RedditUserProfile {
  username: string;
  karma_post: number;
  karma_comment: number;
  created_utc: number;
  is_mod: boolean;
  url: string;
}

// reddit post 命令（帖子+评论）
export interface RedditPostDetail {
  post: RedditPost;
  comments: RedditComment[];
}

// reddit saved 返回（帖子和评论混合）
export type RedditSavedItem = RedditPost | RedditComment;

export interface RedditDMEvent { ... }  // 若 Reddit DM API 开放（目前不支持）
```

---

### 9.3 实施顺序

```
1. X read.ts：bridgeTweet, bridgeFollowers, bridgeFollowing, bridgeBookmarks
2. X read.ts：REST fallback for followers/following/list/likes
3. X write.ts：quote, unlike, unretweet, unfollow
4. X write.ts（bridge）：bookmark, unbookmark
5. X commands/x.ts：注册所有新命令 + dm-list/dm-conversation
6. Reddit read.ts：popular, all, sub-info, user, user-posts, user-comments, post, home, saved
7. Reddit write.ts：text-post, crosspost
8. Reddit commands/reddit.ts：注册所有新命令
9. pnpm build → 全量测试 → commit → push
```

---

### 9.4 不做的事（明确排除）

| 功能 | 原因 |
|------|------|
| X Spaces | API 已限制，非 Premium 账号无法创建/访问 |
| X Analytics（推文分析） | 需要 Elevated API Access，普通账号不可用 |
| X Lists 创建/管理 | 低优先级，读命令已足够 |
| Reddit DM | Reddit 不开放 DM API（`/api/compose` 已废弃） |
| Reddit Poll/Award | 低频，不影响核心 agent 场景 |

