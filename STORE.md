# 商店信息

上架 Chrome 应用商店时要填的东西，都在这里；改完这份，复制粘贴过去即可。
英文版在每一节的后半段。

## 名称

Sub Translator

## 简短说明（132 字符以内）

YouTube 双语字幕翻译，为长访谈与科技播客优化。用你自己的 API Key，字幕只发给你自己填的接口。

> Bilingual subtitles for YouTube, tuned for long interviews and tech podcasts. Uses your own API key.

## 详细说明

自动识别视频的原声语言，把字幕译成你一眼看懂的那一种，默认双语对照显示在播放器里。
为 Lex Fridman、Joe Rogan 这类三小时长访谈和科技播客调过参数。

**它是怎么工作的**

- 打开视频就自动识别原声语言，与你的目标语言不同才开始翻，播放器右下角多一个「译」按钮随时开关。
- 按播放头懒翻译：只翻你正要看到的那一段，看不到的不花钱。
- 翻过的句子存在本机，重看同一个视频不再花钱；同一句口头禅在整片里只买一次。
- 视频自带目标语言的人工字幕时直接拿来用，一个 token 都不花。
- 字幕框可以拖位置、拖宽度、选中复制；全屏时字号按画面比例放大。

**你需要自备一个 OpenAI 兼容接口**

装好后设置页会自动打开，填 API 地址、Key、模型三项即可。可以存多套配置随时切换。
支持四种推理参数写法，配合「测试连接」能看出这个模型到底有没有真的关掉推理。

**关于稳定**

限流会自己退避重试，不用你点；切视频会真的取消在途请求，不白花钱；后台被浏览器回收
时有兜底，不会卡在「正在翻译」；直播、Shorts 这类翻不了的页面会直说原因而不是一直转圈。

> Detects the spoken language of a video and translates its subtitles into one you read at a
> glance, shown bilingually in the player. Tuned for three-hour interviews and tech podcasts.
> Bring your own OpenAI-compatible endpoint: fill in address, key and model, and you are done.
> Lazy translation follows the playhead, results are cached locally, and a video that ships its
> own human subtitles in your language costs nothing at all.

## 隐私说明

**这个扩展收集什么数据：什么都不收集。** 没有任何数据发给作者或第三方分析服务。

- **API Key** 只存在你这台机器的浏览器里（`chrome.storage.local`），不同步、不外发，
  只会作为 `Authorization` 头发给**你自己填写的那个 API 地址**。
- **字幕文本** 只发给你自己填写的那个 API 地址，用于翻译。除此之外不发往任何地方。
- **译文缓存、用量统计** 只存在本机，可在设置页一键清空。
- **诊断信息** 只在你主动点「复制诊断」时生成，进的是你的剪贴板，里面**不含 API Key**
  （只写「已填 / 空」），接口只留主机名，原文和译文一个字都不带。

> This extension collects nothing. Your API key stays in this browser and is only sent to the
> endpoint you configured. Subtitle text is sent only to that same endpoint, for translation.
> Cache and usage stats are local and can be cleared in the options page.

## 权限说明

| 权限 | 为什么要 |
| --- | --- |
| `storage` / `unlimitedStorage` | 存设置和译文缓存。缓存是按视频存的，长播客攒起来会超过 5 MB 的默认上限 |
| `https://www.youtube.com/*` | 内容脚本要在视频页上取字幕、渲染字幕框 |
| `https://api.openai.com/*` | 默认的翻译接口。**填别的地址时不会自动获得权限**，要在设置页单独点「授权访问」 |
| `<all_urls>`（可选） | 只在你填了自定义 API 地址时按需申请，安装时不会向你索要 |
| `commands` | Alt+Shift+T 开关字幕 |

> Storage holds settings and the translation cache. The YouTube host permission is what lets the
> content script read subtitles and draw the box. api.openai.com is the default endpoint; any other
> address needs a one-off grant you trigger yourself in the options page.

## 截图

`npm run shots` 会生成三张放在 `build/shots/`：弹窗、设置页、字幕框（假播放页）。
前两张可以直接用。**字幕框那张请自己在真视频上重拍一张**：商店审核和用户都想看到它在真
YouTube 上的样子，而假播放页只是我们跑测试用的。

拍真截图的做法：打开一个有英文字幕的视频，等字幕出来，用系统截图工具截播放器区域，
1280×800 或 640×400。

## 上架前再核一遍

- [ ] `npm run check` 与 `npm run e2e` 全绿
- [ ] `npm run zip` 出的包在干净 Chrome 里加载即用
- [ ] 设置页里的模型候选是当前在用的那两个
- [ ] 版本号：`manifest.json` 与 `package.json` 一致，CHANGELOG 有这一版
- [ ] 商店后台的隐私问卷按上面「隐私说明」如实填：不收集任何用户数据
