# Review Auto Decline

[English](README.md)

Chrome 插件：在 Outlook 网页版里自动拒绝所有发给你的期刊审稿邀请。它在后台标签页里完成期刊网站上的拒绝步骤，然后删掉邀请邮件、投稿系统的 Registration 邮件和「你已拒绝」的确认邮件。

适合已经决定不再给期刊审稿的人：没有白名单，发给你的邀请全部拒绝。

## 安装

1. 从 [Releases](https://github.com/vvv214/review-auto-decline/releases) 下载 `review-auto-decline-*.zip`，解压到一个固定的位置，或者 `git clone` 这个仓库。Chrome 每次启动都从这个文件夹读插件，所以别删、别移动它（移动了要在 `chrome://extensions` 里重新加载）
2. 打开 `chrome://extensions`，右上角打开「开发者模式」，点「加载已解压的扩展程序」，选这个文件夹。插件 ID 固定为 `cdaieplelnbooonfgjjnipgkmpblfjml`（由 `manifest.json` 里的 `key` 决定）
3. 装好后会打开设置页：选规则认不出时用的 LLM（见下），填上邀请可能发到的其他名字或邮箱，点 Save。「Test LLM」用一封虚构的 IEEE Access 邀请试一下 LLM，显示答案和耗时

点工具栏上的插件图标可以打开设置页和操作记录。

### 选 LLM

- **Codex（默认）**：通过 Chrome native messaging host 调用本机的 `codex exec`。需要 macOS、Google Chrome、已登录的 [Codex CLI](https://github.com/openai/codex)、Node 和 `/usr/bin/python3`（Xcode Command Line Tools）。先运行一次 `host/install.sh`；改了 `host/codex_host.py` 或者换了 Node 版本（nvm）要重新运行。默认模型 gpt-6.1-sol，low effort，每次约 6–8 秒，设置页可以换模型
- **Anthropic API**：插件用你的 API key 直接调用 Claude（Opus 5.5 / Sonnet 5.5 / Haiku 5.5）。key 不加密地存在插件的本地存储里
- **Off**：只用内置规则，Editorial Manager 和 ScholarOne 的邀请照样能处理

## 它做什么

Chrome 里开着 Outlook 网页版（outlook.cloud.microsoft / outlook.office.com / outlook.office365.com）时，对**安装之后**收到、看起来和审稿有关的邮件，每封打开一次：

| 邮件 | 处理 |
| --- | --- |
| 发给你（To 里有你）的审稿邀请 | 在后台标签页打开拒绝链接，按提交/确认，看到确认页后关掉标签页，邀请邮件移到「已删除邮件」 |
| 投稿系统的 Registration / 账号创建邮件 | 移到「已删除邮件」 |
| 「你已拒绝」/「感谢回复」的确认邮件 | 移到「已删除邮件」 |
| 其他（学生邮件、会议 PC 邀请、你作为编辑被 cc 的邀请副本等） | 不动；原来是未读的，恢复成未读 |

先用内置规则判断（Editorial Manager、ScholarOne 的格式；ScholarOne 的确认页和「已拒绝」邮件按 IEEE Access 的真实页面和邮件核对过）。规则认不出时问 LLM：这封邮件是什么、拒绝链接是哪个；拒绝页面长得不一样时，看下一步该点什么或选什么。

## 安全措施

- 只拒绝 To 里有你的邀请。比如你当编辑时被 cc 的、发给别的审稿人的邀请副本不会碰。Outlook 的显示名总算你本人，其他邮箱在设置页里加
- 永远不点 agree / accept / login / register / remove my information 之类的按钮，不填密码；需要填文字时只会填固定的一句 "I am unable to review this manuscript at this time."，网页上的文字没法让它填别的
- Codex 在沙盒里跑：读不到临时目录以外的文件、没有网络、不用 web search / 插件 / memories，每次用一个只含 `auth.json` 链接的临时 Codex home，所以邮件或网页里的恶意指令拿不到你电脑上的东西
- 页面认不出、需要登录，或者走了 6 步还没完成：标签页留着不关，插件图标显示红色「!」，设置页的记录里写原因
- 页面弹出的「确定要拒绝吗？」对话框会自动点确定（只在插件自己打开的标签页里）
- 删除都是移到「已删除邮件」，可以找回
- 你在 Outlook 里操作时（30 秒内动过鼠标/键盘、正在输入）会暂停，免得切走你正在看的邮件

## 发给 LLM 的内容

只发：邮件列表那一行（发件人、标题、预览）、发件地址、From/To/Cc、正文开头 800 字和每个链接前后各 200 字（不含链接地址），以及拒绝页面上的文字和按钮。不会发整篇摘要。

## 限制

- 只支持英文界面的 Outlook 网页版：插件按英文标签（"To:"、"Delete"、"Mark as unread"）找 Outlook 的按钮
- Chrome 里得开着 Outlook 标签页；安装之前收到的邮件不处理
- Codex 后端只支持 macOS 上的 Google Chrome

## Codex host 排错

- 设置页点「Test LLM」：显示 Works 就是通了；显示 "Native host has exited" 且日志里没有 `request:` 行，说明 host 没启动起来，重新运行 `host/install.sh`。打开 `chrome-extension://cdaieplelnbooonfgjjnipgkmpblfjml/options.html#test` 会自动跑一次测试
- 每次调用在 `~/Library/Logs/review-auto-decline-host.log` 记两行（收到请求；耗时、退出码、有没有拿到答案），host 启动时的报错也写在这里
- host 从 `~/Library/Application Support/review-auto-decline/` 运行，不从这个文件夹：Chrome 启动的 host 在 macOS 隐私检查里算独立进程，读不了 ~/Documents、~/Desktop、~/Downloads 里的文件
- host 用苹果自带的 `/usr/bin/python3`，不要换成 Homebrew 的：Chrome 启动的 host 在 macOS 隐私检查里算独立进程，套着 Homebrew 的 Python.app 时 `codex exec` 会卡死在启动阶段
- 单次调用超过 240 秒会被杀掉，插件把那封邮件留到下次再试（最多 3 次）

## 开发

改了代码后在 `chrome://extensions` 里点插件的刷新按钮，或者打开 `chrome-extension://cdaieplelnbooonfgjjnipgkmpblfjml/options.html#reload`；已经开着的 Outlook 标签页会自动换上新脚本，不用刷新。

`test/e2e.mjs` 用无头 Chromium 加载插件，配一个假的 Outlook 页面和假的期刊网站，检查拒绝、删除、跳过副本、恢复未读等行为，不碰真实账号：

```bash
cd test && npm install && npx playwright install chromium
node e2e.mjs ..         # 只用规则
node e2e.mjs .. llm     # Anthropic 后端，模拟 Claude API
node e2e.mjs .. codex   # 真的 codex exec（经 native host，只登记在测试用的临时 profile 里）
```

- `outlook.js`：Outlook 页面里的脚本，找邮件、打开、读内容、删除
- `background.js`：判断邮件，驱动拒绝页面的后台标签页
- `rules.js`：Editorial Manager / ScholarOne 的固定规则
- `llm.js`：给 LLM 的提示词和 JSON 格式，Codex / Claude 两个后端
- `host/codex_host.py`、`host/install.sh`：Chrome native messaging host，每次请求跑一次 `codex exec`；install.sh 把它复制到 `~/Library/Application Support/review-auto-decline/` 再登记
- `lib/anthropic.mjs`：用 esbuild 打包的官方 Anthropic JS SDK（1.3.0，[Apache-2.0](lib/LICENSE-anthropic-sdk.txt)）
- `options.html` / `options.js`：设置页和操作记录

## 许可

[MIT](LICENSE)。`lib/anthropic.mjs` 是 Anthropic SDK，用 Apache License 2.0。
