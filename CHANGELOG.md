# 更新日志

版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。`manifest.json` 里的版本号只在真正发布时才改
（Chrome 只认纯数字的版本号，写不下 `-dev` 这类后缀），开发期间以本文件的「未发布」一节为准。

## 未发布（0.2.0-dev）

### 工程

- 加 `package.json`：`npm test` / `npm run lint` / `npm run zip` / `npm run check`。
- 加 eslint 最小规则集（只抓「一定是错」的问题，不管风格），修掉它报出来的 9 处。
- 加 `tools/zip.mjs`：零依赖打包，产出 `dist/sub-translator-<版本>.zip`，白名单进包。
- 加 GitHub Actions：push / PR 上跑 lint + 测试 + 打包，包作为构建产物留存。

## 0.1.0

第一个能用的版本：自动识别原声语言、按播放头懒翻译、双语字幕框（可拖动 / 可调宽 / 可选中复制）、
本地缓存、接口配置档、自带译文轨采用、批次自动升降档、对齐容错与统计。
