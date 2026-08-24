# Papercuts

## 2026-08-19T22:13:31+08:00

**Path:** `/home/lee/11MyProjrct/44-skills-manager-web`

skills-manager-web 浏览器验收：Chrome headless CDP 默认拒绝 websocket Origin，需要启动时增加 --remote-allow-origins=* 才能连接。

## 2026-08-19T22:15:54+08:00

**Path:** `/home/lee/11MyProjrct/44-skills-manager-web`

skills-manager-web 浏览器验收：WSL 内 Google Chrome headless 可打开 data URL，但访问 localhost:8787 的 --dump-dom 会超时且服务无请求日志；可能是 WSL Chrome 网络隔离。Windows 原生浏览器链路仍需手动验证。

## 2026-08-20T14:41:28+08:00

**Path:** `/home/lee/11MyProjrct/44-skills-manager-web`

edit 工具精确匹配易踩坑：JS 模板字符串里的 \\\" 转义引号、CSS 单行拼接 vs 多行规则，oldText 稍不一致就静默失败且整批不生效；用 python 脚本带 count 断言做批量替换更稳、失败信息更清楚

## 2026-08-21T20:38:46+08:00

**Path:** `/home/lee/11MyProjrct/44-skills-manager-web`

NO_PROXY 里的 127.* 通配对 curl 无效（curl 只认后缀匹配），导致本机请求走了 Clash 代理、Host 头被改写，测试结果被污染。用 curl --noproxy "*" 或把 NO_PROXY 写成 127.0.0.1

## 2026-08-21T21:58:10+08:00

**Path:** `/home/lee/11MyProjrct/44-skills-manager-web`

诊断接口计时命令超时后，后台启动的 node 服务子进程未随工具超时自动退出；后续应使用可控的进程组或独立端口清理。

## 2026-08-24T22:31:50+08:00

**Path:** `/home/lee/11MyProjrct/44-skills-manager-web`

Windows PowerShell stdout used a legacy code page, corrupting Unicode paths when consumed by WSL Node. Native bridge scripts must set Console.OutputEncoding to UTF-8.
