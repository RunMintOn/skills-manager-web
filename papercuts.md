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
