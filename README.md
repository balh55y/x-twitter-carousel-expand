# X / Twitter 轮播图展开 (画质与体积优化版)

展开 X (Twitter) 多图推文，一键无缝横向拼接所有原图并复制到剪贴板或下载保存。支持自由选择图片格式（JPEG / PNG / WebP）、自定义压缩质量、分辨率缩放，并实时预估文件大小。

---

## 🚀 一键安装

请确保浏览器已安装扩展：[Tampermonkey (油猴)](https://www.tampermonkey.net/) 或 [Violentmonkey (暴力猴)](https://violentmonkey.github.io/)。

点击下方任一链接，即可自动呼出油猴安装界面：

* [👉 **【点击一键安装】GitHub 官方直链**](https://raw.githubusercontent.com/balh55y/x-twitter-carousel-expand/main/x-twitter-carousel-expand.user.js)
* [⚡ **【点击一键安装】国内 CDN 镜像加速**](https://fastly.jsdelivr.net/gh/balh55y/x-twitter-carousel-expand@main/x-twitter-carousel-expand.user.js)

> **注**：安装后，脚本会在 GitHub 发布新版本时自动静默检查更新。

---

## ✨ 核心特性

- 🖼️ **原图质量获取**：自动解析推文原图资源（`name=orig`），拒绝缩略图模糊失真。
- 📐 **横向无缝拼接**：针对推文中的 2~4 张（或更多）连图进行自动对齐与无缝拼接。
- ⚙️ **多格式与画质控制**：
  - **格式选择**：支持 JPEG（推荐）、PNG（无损原画）、WebP。
  - **质量滑块**：30% ~ 100% 自由微调压缩率。
  - **尺寸缩放**：原图 / 75% / 50% / 限高 1080p / 限高 1440p，避免图幅过大。
  - **体积预估**：悬浮工具栏实时预估生成后的大小，清晰掌控文件体积。
- 📋 **智能剪贴板适配**：
  - 自动适配现代浏览器 Async Clipboard API 规范。
  - 当浏览器底层限制仅允许写入 PNG 时，脚本会自动执行兼容性降级，确保在微信、QQ、Discord 等软件中粘贴顺畅。
- 💾 **一键本地保存**：支持直接导出完整拼接图片文件到本地磁盘，不受系统剪贴板体积和格式约束。

---

## 💡 常见问题与说明

### Q: 为什么复制时提示“已复制为兼容PNG”？
* **原因**：现代浏览器（Chromium / Firefox / Safari）出于内存安全和跨平台剪贴板标准规范，限制向系统剪贴板写入压缩格式（如 JPEG / WebP），默认只允许写入 `image/png`。
* **说明**：脚本探测到浏览器拒绝写入 JPEG 时，会自动无损回退并以 `image/png` 格式写入，确保你在微信、QQ、Office 等软件中能正常 `Ctrl + V` 粘贴出来。
* **建议**：
  1. 日常直接复制：可直接在顶部将格式切换为 **PNG**，脚本会自动记住设置，今后复制将不再弹回退提示。
  2. 需要极小体积的 JPG 文件：直接点击右上角的 **【💾 下载】** 按钮保存到电脑即可。

---

## 📄 开源许可

本项目遵循 MIT 协议开源。
