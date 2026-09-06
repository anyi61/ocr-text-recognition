# extension-delivery

## Purpose

扩展加载与交付。2026-09-05 从现有实现补录的行为基线；不表示新增功能或所有场景均已手工验收。

## Requirements

### Requirement: 零构建加载

扩展 SHALL 能直接加载源码目录，由 manifest、后台 importScripts、页面注入列表和 HTML 脚本顺序加载生产代码。

#### Scenario: 本地加载扩展

- **WHEN** 开发者选择源码目录加载已解压扩展
- **THEN** 浏览器入口与依赖可解析，无需先执行运行时构建

### Requirement: 版本与打包内容

打包器 SHALL 校验 package 与 manifest 版本一致，配置导出读取运行版本，并仅收集显式生产白名单中的文件和目录。

#### Scenario: 版本不一致

- **WHEN** 执行打包时 package 与 manifest 版本不同
- **THEN** 打包失败并报告不一致，避免生成错误版本产物

## Evidence

manifest.json、package.json、scripts/package-extension.mjs、background.js、extension-runtime.js、options.html、popup.html、.github/workflows/ci.yml；tests/extension-static.test.js、tests/package-extension.test.js、tests/background-message-contracts.test.js。具体测试范围及本轮执行状态见 `../../README.md`。
