# Third-Party Notices

本包包含以下第三方代码。逐文件来源与哈希见 `lib/vendor/manifest.json`；完整许可证在对应目录内。

## openhongguo 0.4.1

- 上游：https://github.com/beilunyang/openhongguo
- 来源：npm `openhongguo@0.4.1`
- 许可证：Apache License 2.0（见 `lib/vendor/openhongguo/LICENSE`）
- 随包附 Go 运行时/依赖许可证：`lib/vendor/openhongguo/GO_LICENSE`
- 使用位置：`lib/hongguo.mjs`（只暴露 `search/getSeries/listEpisodes/listDanmaku`；不暴露 `resolvePlayback`，不读取/保存播放地址或内容密钥）
- 修改：无。上游文件原样 vendored；WASM 为上游 npm 包内文件。

## 说明

- 第三方代码的许可证不自动授予平台内容、角色图、漫画页、短剧帧、弹幕或同人正文的权利。
- 本包不打包任何角色图/漫画页/短剧帧；用户确认的图片只存在用户本地项目目录。
- 本文件不是法律意见；发布前按实际使用方式复核。
